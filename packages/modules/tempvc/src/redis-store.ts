import type { Redis } from 'ioredis';
import type { PresenceStore } from './store.ts';

export const TEMPVC_PREFIX = 'tempvc';

/**
 * A voice session, not a channel's lifetime. Ownership used to live under this TTL, which is how a
 * channel someone sat in for eight days quietly orphaned itself; presence is a cache that the next
 * reconcile rebuilds, so a short expiry is correct here.
 */
export const TEMPVC_TTL_MS = 24 * 60 * 60 * 1000;

export interface RedisPresenceStoreOptions {
  keyPrefix?: string;
  ttlMs?: number;
}

export class RedisPresenceStore implements PresenceStore {
  readonly #redis: Redis;
  readonly #prefix: string;
  readonly #ttlMs: number;

  constructor(redis: Redis, options: RedisPresenceStoreOptions = {}) {
    this.#redis = redis;
    this.#prefix = options.keyPrefix ?? TEMPVC_PREFIX;
    this.#ttlMs = options.ttlMs ?? TEMPVC_TTL_MS;
  }

  #atKey(guildId: string, userId: string): string {
    return `${this.#prefix}:at:${guildId}:${userId}`;
  }

  #occupantsKey(guildId: string, channelId: string): string {
    return `${this.#prefix}:occ:${guildId}:${channelId}`;
  }

  #seconds(): number {
    return Math.ceil(this.#ttlMs / 1000);
  }

  async locate(guildId: string, userId: string): Promise<string | null> {
    return this.#redis.get(this.#atKey(guildId, userId));
  }

  async place(guildId: string, userId: string, channelId: string | null): Promise<void> {
    const key = this.#atKey(guildId, userId);

    if (channelId === null) {
      await this.#redis.del(key);
      return;
    }

    await this.#redis.set(key, channelId, 'PX', this.#ttlMs);
  }

  async enter(guildId: string, channelId: string, userId: string): Promise<number> {
    const key = this.#occupantsKey(guildId, channelId);

    const [, size] = (await this.#redis
      .multi()
      .sadd(key, userId)
      .scard(key)
      .expire(key, this.#seconds())
      .exec()) as Array<[Error | null, unknown]>;

    return Number(size?.[1] ?? 0);
  }

  async leave(guildId: string, channelId: string, userId: string): Promise<number> {
    const key = this.#occupantsKey(guildId, channelId);

    const [, size] = (await this.#redis.multi().srem(key, userId).scard(key).exec()) as Array<
      [Error | null, unknown]
    >;

    return Number(size?.[1] ?? 0);
  }

  async occupants(guildId: string, channelId: string): Promise<string[]> {
    return this.#redis.smembers(this.#occupantsKey(guildId, channelId));
  }

  async reset(guildId: string, channelId: string, userIds: readonly string[]): Promise<void> {
    const key = this.#occupantsKey(guildId, channelId);

    const pipeline = this.#redis.multi().del(key);
    if (userIds.length > 0) pipeline.sadd(key, ...userIds).expire(key, this.#seconds());

    await pipeline.exec();
  }
}

/**
 * A per-member creation cooldown. `SET NX PX` is the whole mechanism: the first caller inside the
 * window writes the key and is let through, and everybody after it finds the key already there.
 */
export class RedisCooldownGate {
  readonly #redis: Redis;

  constructor(redis: Redis) {
    this.#redis = redis;
  }

  async hit(key: string, windowMs: number): Promise<boolean> {
    const written = await this.#redis.set(key, '1', 'PX', Math.max(1, windowMs), 'NX');

    return written === null;
  }
}
