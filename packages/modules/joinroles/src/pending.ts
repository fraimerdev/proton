import type { Redis } from 'ioredis';

export const PENDING_PREFIX = 'proton:joinroles:pending';

export const PENDING_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface PendingGrantStore {
  mark(guildId: string, userId: string): Promise<void>;

  take(guildId: string, userId: string): Promise<boolean>;
}

export class RedisPendingGrantStore implements PendingGrantStore {
  readonly #redis: Redis;
  readonly #prefix: string;
  readonly #ttlMs: number;

  constructor(redis: Redis, options: { prefix?: string; ttlMs?: number } = {}) {
    this.#redis = redis;
    this.#prefix = options.prefix ?? PENDING_PREFIX;
    this.#ttlMs = options.ttlMs ?? PENDING_TTL_MS;
  }

  #key(guildId: string, userId: string): string {
    return `${this.#prefix}:${guildId}:${userId}`;
  }

  async mark(guildId: string, userId: string): Promise<void> {
    await this.#redis.set(this.#key(guildId, userId), '1', 'PX', this.#ttlMs);
  }

  async take(guildId: string, userId: string): Promise<boolean> {
    return (await this.#redis.getdel(this.#key(guildId, userId))) !== null;
  }
}
