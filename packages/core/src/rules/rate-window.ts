import type { Redis } from 'ioredis';

export const RATE_WINDOW_PREFIX = 'proton:rate';

/** PLAN.md §4-P2: keyed by `(guildId, ruleId, actorId)`. */
export function rateWindowKey(
  guildId: string,
  ruleId: string,
  actorId: string,
  prefix: string = RATE_WINDOW_PREFIX,
): string {
  return `${prefix}:${guildId}:${ruleId}:${actorId}`;
}

export interface RateWindowHit {
  guildId: string;
  /** Globally unique rule identity — the engine passes `moduleId:ruleId`. */
  ruleId: string;
  /** The member being counted, or `RATE_WINDOW_GUILD_SCOPE` for a server-wide window. */
  actorId: string;
  windowMs: number;
  /** The count at which the window trips. */
  limit: number;
  /**
   * Stable, unique identity for this occurrence — the engine passes the event
   * id. A redelivered event therefore lands on the member it already occupies
   * and is not counted twice (I4).
   */
  member: string;
  now: number;
}

export interface RateWindowResult {
  /** How many occurrences are inside the window, including this one. */
  count: number;
  /**
   * True for the occurrence that crossed the limit — and true again every time
   * *that same occurrence* is replayed.
   *
   * Not `count >= limit`: during a 40-message spam burst that would be true 35
   * times over and the rule would ban the member 35 times. The window re-arms
   * as soon as an occurrence slides out of it, so a sustained flood still trips
   * again on the next genuine crossing.
   *
   * The replay clause is load-bearing and was originally missing, which cost the
   * anti-nuke breaker its whole reason for existing. `tripped` used to be
   * `added == 1 and count == limit`, so it was an *edge consumed by the first
   * call*. The bus is at-least-once by design: if anything downstream of the hit
   * throws — a REST failure mid-strip, a Redis blip reading guild state — the
   * event is redelivered, the second call finds the member already in the set,
   * `added` is 0, and the handler is told the window is merely counting. The
   * crossing is gone. And because `count == limit` can only hold once per fill,
   * no later event in the same attack trips either: one transient error
   * permanently disarmed the breaker for that burst, silently.
   *
   * So the crossing occurrence is recorded and answered idempotently, which is
   * what the callers' own I4 keys already assume. The record expires with the
   * window, so a later genuine crossing is a new one.
   *
   * The one consequence worth knowing: lowering a rule's limit while its window
   * already holds more than the new limit takes effect at the next crossing,
   * once the window has drained — not retroactively on the occurrences already
   * counted.
   */
  tripped: boolean;
}

export interface RateWindowStore {
  hit(input: RateWindowHit): Promise<RateWindowResult>;
}

/** Actor slot for a `scope: 'guild'` window — raid detection counts everyone. */
export const RATE_WINDOW_GUILD_SCOPE = 'guild';

/**
 * Sliding window as a sorted set, trimmed, appended and counted in one script.
 *
 * PLAN.md §4-P2 mandates the atomicity and it is the entire point of the
 * condition: read-then-increment from two workers consuming the same stream lets
 * a burst of N slip through with every worker observing a count below the limit
 * — precisely the concurrent flood the rule exists to catch. Redis runs a script
 * to completion before any other command, so the trim, the append and the count
 * see one consistent window.
 *
 * A sorted set rather than a counter with a TTL because a fixed bucket lets
 * twice the limit through across a bucket boundary, and an anti-nuke rule that
 * can be defeated by waiting for the top of the second is not a control.
 */
const RATE_WINDOW_LUA = `
local key = KEYS[1]
local crossedKey = KEYS[2]
local nowMs = tonumber(ARGV[1])
local windowMs = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
local member = ARGV[4]

-- %.0f, not tostring(): Lua renders large numbers in scientific notation and
-- the cutoff would land in the wrong millisecond.
redis.call('ZREMRANGEBYSCORE', key, '-inf', string.format('%.0f', nowMs - windowMs))

-- NX so a redelivered event keeps its original score and adds nothing.
local added = redis.call('ZADD', key, 'NX', ARGV[1], member)
local count = redis.call('ZCARD', key)

-- The window is worthless once every occurrence in it has aged out.
redis.call('PEXPIRE', key, ARGV[2])

local crossedBy = redis.call('GET', crossedKey)
local tripped = 0

if crossedBy == member then
  -- This exact occurrence is the one that crossed, and we are seeing it again.
  -- Report the same verdict rather than a fresh count, so a handler that failed
  -- downstream of the trip still trips when the bus redelivers it.
  tripped = 1
elseif not crossedBy and added == 1 and count == limit then
  -- The crossing. Remember which occurrence it was, for exactly as long as the
  -- window it crossed: once that has drained the next genuine crossing is a new
  -- one and must be allowed to trip again.
  redis.call('SET', crossedKey, member, 'PX', ARGV[2])
  tripped = 1
end

return { count, tripped }
`;

const COMMAND_NAME = 'protonRateWindow';

interface RateWindowCommand {
  [COMMAND_NAME](
    key: string,
    crossedKey: string,
    nowMs: string,
    windowMs: string,
    limit: string,
    member: string,
  ): Promise<[number, number]>;
}

/**
 * Where the crossing occurrence is remembered.
 *
 * A sibling key rather than a field on the sorted set, because a sorted set has
 * no room for one and a hash would mean two data types to expire in step.
 *
 * Both keys are declared to the script as KEYS, which is what Redis requires of
 * a script that touches more than one. They do not share a hash slot, so this
 * would need a `{...}` tag before it could run on Redis Cluster — not a concern
 * under PLAN.md §2, which specifies one instance in dev and separate instances
 * in production, never a cluster.
 */
export const crossedKeyFor = (windowKey: string): string => `${windowKey}:crossed`;

export interface RedisRateWindowOptions {
  keyPrefix?: string;
}

export class RedisRateWindow implements RateWindowStore {
  readonly #redis: Redis & RateWindowCommand;
  readonly #prefix: string;

  constructor(redis: Redis, options: RedisRateWindowOptions = {}) {
    // defineCommand registers the script against this client and reuses its
    // SHA, so the body travels to Redis once rather than on every message.
    redis.defineCommand(COMMAND_NAME, { numberOfKeys: 2, lua: RATE_WINDOW_LUA });
    // The command is attached dynamically, so its type has to be asserted;
    // `RateWindowCommand` is the declaration of what defineCommand just created.
    this.#redis = redis as Redis & RateWindowCommand;
    this.#prefix = options.keyPrefix ?? RATE_WINDOW_PREFIX;
  }

  async hit(input: RateWindowHit): Promise<RateWindowResult> {
    const key = rateWindowKey(input.guildId, input.ruleId, input.actorId, this.#prefix);
    const [count, tripped] = await this.#redis[COMMAND_NAME](
      key,
      crossedKeyFor(key),
      String(Math.trunc(input.now)),
      String(Math.trunc(input.windowMs)),
      String(Math.trunc(input.limit)),
      input.member,
    );

    return { count, tripped: tripped === 1 };
  }
}
