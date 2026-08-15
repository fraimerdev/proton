import type { Redis } from 'ioredis';

export const RATE_WINDOW_PREFIX = 'proton:rate';

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

  ruleId: string;

  actorId: string;
  windowMs: number;

  limit: number;

  member: string;
  now: number;
}

export interface RateWindowResult {
  count: number;

  tripped: boolean;
}

export interface RateWindowStore {
  hit(input: RateWindowHit): Promise<RateWindowResult>;
}

export const RATE_WINDOW_GUILD_SCOPE = 'guild';

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

export const crossedKeyFor = (windowKey: string): string => `${windowKey}:crossed`;

export interface RedisRateWindowOptions {
  keyPrefix?: string;
}

export class RedisRateWindow implements RateWindowStore {
  readonly #redis: Redis & RateWindowCommand;
  readonly #prefix: string;

  constructor(redis: Redis, options: RedisRateWindowOptions = {}) {
    redis.defineCommand(COMMAND_NAME, { numberOfKeys: 2, lua: RATE_WINDOW_LUA });

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
