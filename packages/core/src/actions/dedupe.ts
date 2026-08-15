import type { Redis } from 'ioredis';

export const DEDUPE_PREFIX = 'proton:dedupe';

export interface DedupeStore {
  claim(key: string, ttlMs: number): Promise<boolean>;

  release(key: string): Promise<void>;

  has(key: string): Promise<boolean>;
}

export class RedisDedupeStore implements DedupeStore {
  readonly #redis: Redis;
  readonly #prefix: string;

  constructor(redis: Redis, prefix: string = DEDUPE_PREFIX) {
    this.#redis = redis;
    this.#prefix = prefix;
  }

  #key(key: string): string {
    return `${this.#prefix}:${key}`;
  }

  async claim(key: string, ttlMs: number): Promise<boolean> {
    const result = await this.#redis.set(this.#key(key), '1', 'PX', ttlMs, 'NX');
    return result === 'OK';
  }

  async release(key: string): Promise<void> {
    await this.#redis.del(this.#key(key));
  }

  async has(key: string): Promise<boolean> {
    return (await this.#redis.exists(this.#key(key))) === 1;
  }
}
