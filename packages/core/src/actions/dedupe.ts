import type { Redis } from 'ioredis';

export const DEDUPE_PREFIX = 'proton:dedupe';

export interface DedupeStore {
  /**
   * Atomically claim a key. Returns true only for the caller that claimed it
   * first; every later caller within the TTL gets false.
   */
  claim(key: string, ttlMs: number): Promise<boolean>;

  /**
   * Give a claim back so the work can be retried.
   *
   * Called when the claimed operation *failed* — without this, a transient
   * Discord 500 would poison the idempotency key and the retry would be
   * silently swallowed as a duplicate.
   */
  release(key: string): Promise<void>;

  has(key: string): Promise<boolean>;
}

/**
 * Redis-backed dedupe for PLAN.md I4.
 *
 * Gateway RESUME redelivers dispatches and the bus is at-least-once, so every
 * handler sees each event more than once as a matter of course. This is the fast
 * path that stops the second one; the UNIQUE constraint on `cases.idempotency_key`
 * is the durable backstop for when Redis is cold, flushed or raced.
 */
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
    // SET NX is atomic, so two workers racing the same event cannot both win.
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
