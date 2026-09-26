import type { Redis } from 'ioredis';
import type { AchievementLimits, FencedLocks } from './deps.ts';

export const LOCK_PREFIX = 'proton:achievements:lock';

const RELEASE =
  "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end";

const CLAIM = `
if redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[2], 'NX') then return 1 end
if redis.call('GET', KEYS[1]) == ARGV[1] then return 1 end
return 0
`;

const COUNT = `
local count = redis.call('INCR', KEYS[1])
if redis.call('PTTL', KEYS[1]) < 0 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
return count
`;

function ttl(ms: number): number {
  return Math.max(1, Math.floor(ms));
}

export class RedisFencedLocks implements FencedLocks {
  readonly #redis: Redis;
  readonly #prefix: string;

  constructor(redis: Redis, options: { prefix?: string } = {}) {
    this.#redis = redis;
    this.#prefix = options.prefix ?? LOCK_PREFIX;
  }

  async acquire(key: string, ttlMs: number): Promise<string | null> {
    const token = crypto.randomUUID();
    const set = await this.#redis.set(`${this.#prefix}:${key}`, token, 'PX', ttl(ttlMs), 'NX');
    return set === 'OK' ? token : null;
  }

  async release(key: string, token: string): Promise<boolean> {
    const released = await this.#redis.eval(RELEASE, 1, `${this.#prefix}:${key}`, token);
    return Number(released) === 1;
  }
}

export class RedisLimits implements AchievementLimits {
  readonly #redis: Redis;

  constructor(redis: Redis) {
    this.#redis = redis;
  }

  async claim(key: string, value: string, ttlMs: number): Promise<boolean> {
    return Number(await this.#redis.eval(CLAIM, 1, key, value, ttl(ttlMs))) === 1;
  }

  async release(key: string, value: string): Promise<boolean> {
    return Number(await this.#redis.eval(RELEASE, 1, key, value)) === 1;
  }

  async count(key: string, ttlMs: number): Promise<number> {
    return Number(await this.#redis.eval(COUNT, 1, key, ttl(ttlMs)));
  }
}
