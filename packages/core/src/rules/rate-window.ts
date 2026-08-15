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
   * True only on the call that crossed the limit.
   *
   * Not `count >= limit`: during a 40-message spam burst that would be true 35
   * times over and the rule would ban the member 35 times. The window re-arms
   * as soon as an occurrence slides out of it, so a sustained flood still trips
   * again on the next genuine crossing.
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

local tripped = 0
if added == 1 and count == limit then
  tripped = 1
end

return { count, tripped }
`;

const COMMAND_NAME = 'protonRateWindow';

interface RateWindowCommand {
  [COMMAND_NAME](
    key: string,
    nowMs: string,
    windowMs: string,
    limit: string,
    member: string,
  ): Promise<[number, number]>;
}

export interface RedisRateWindowOptions {
  keyPrefix?: string;
}

export class RedisRateWindow implements RateWindowStore {
  readonly #redis: Redis & RateWindowCommand;
  readonly #prefix: string;

  constructor(redis: Redis, options: RedisRateWindowOptions = {}) {
    // defineCommand registers the script against this client and reuses its
    // SHA, so the body travels to Redis once rather than on every message.
    redis.defineCommand(COMMAND_NAME, { numberOfKeys: 1, lua: RATE_WINDOW_LUA });
    // The command is attached dynamically, so its type has to be asserted;
    // `RateWindowCommand` is the declaration of what defineCommand just created.
    this.#redis = redis as Redis & RateWindowCommand;
    this.#prefix = options.keyPrefix ?? RATE_WINDOW_PREFIX;
  }

  async hit(input: RateWindowHit): Promise<RateWindowResult> {
    const key = rateWindowKey(input.guildId, input.ruleId, input.actorId, this.#prefix);
    const [count, tripped] = await this.#redis[COMMAND_NAME](
      key,
      String(Math.trunc(input.now)),
      String(Math.trunc(input.windowMs)),
      String(Math.trunc(input.limit)),
      input.member,
    );

    return { count, tripped: tripped === 1 };
  }
}
