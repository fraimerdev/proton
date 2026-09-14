import type { Redis } from 'ioredis';

export const SCREENING_PREFIX = 'proton:serverlog:screening';

export const SCREENING_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface ScreeningStore {
  mark(guildId: string, userId: string, joinedAt: string): Promise<void>;

  read(guildId: string, userId: string): Promise<string | null>;

  clear(guildId: string, userId: string): Promise<void>;
}

export class RedisScreeningStore implements ScreeningStore {
  readonly #redis: Redis;
  readonly #prefix: string;
  readonly #ttlMs: number;

  constructor(redis: Redis, options: { prefix?: string; ttlMs?: number } = {}) {
    this.#redis = redis;
    this.#prefix = options.prefix ?? SCREENING_PREFIX;
    this.#ttlMs = options.ttlMs ?? SCREENING_TTL_MS;
  }

  #key(guildId: string, userId: string): string {
    return `${this.#prefix}:${guildId}:${userId}`;
  }

  async mark(guildId: string, userId: string, joinedAt: string): Promise<void> {
    await this.#redis.set(this.#key(guildId, userId), joinedAt, 'PX', this.#ttlMs);
  }

  async read(guildId: string, userId: string): Promise<string | null> {
    return this.#redis.get(this.#key(guildId, userId));
  }

  async clear(guildId: string, userId: string): Promise<void> {
    await this.#redis.del(this.#key(guildId, userId));
  }
}
