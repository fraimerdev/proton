import type { Redis } from 'ioredis';
import type { PresenceStore, Seen } from './store.ts';

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

  #refusalsKey(guildId: string, rowId: string): string {
    return `${this.#prefix}:delrefused:${guildId}:${rowId}`;
  }

  #seconds(): number {
    return Math.ceil(this.#ttlMs / 1000);
  }

  async locate(guildId: string, userId: string): Promise<string | null> {
    return (await this.where(guildId, userId))?.channelId ?? null;
  }

  async where(guildId: string, userId: string): Promise<Seen | null> {
    const raw = await this.#redis.get(this.#atKey(guildId, userId));
    return raw === null ? null : decodeSeen(raw);
  }

  // A leave keeps a stamped empty entry, so a replayed join older than it is still refused.
  async place(
    guildId: string,
    userId: string,
    channelId: string | null,
    at: number,
  ): Promise<void> {
    await this.#redis.set(
      this.#atKey(guildId, userId),
      `${channelId ?? ''}|${at}`,
      'PX',
      this.#ttlMs,
    );
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

  async refusedDelete(guildId: string, rowId: string, windowMs: number): Promise<number> {
    const key = this.#refusalsKey(guildId, rowId);

    const [, count] = (await this.#redis
      .multi()
      .set(key, '0', 'PX', Math.max(1, windowMs), 'NX')
      .incr(key)
      .exec()) as Array<[Error | null, unknown]>;

    return Number(count?.[1] ?? 0);
  }

  async deleteRefusals(guildId: string, rowId: string): Promise<number> {
    return Number((await this.#redis.get(this.#refusalsKey(guildId, rowId))) ?? 0);
  }
}

export function decodeSeen(raw: string): Seen {
  const bar = raw.lastIndexOf('|');
  // Written before locations were stamped: a bare channel id, which any new event outranks.
  if (bar < 0) return { channelId: raw, at: 0 };

  const at = Number(raw.slice(bar + 1));
  return { channelId: raw.slice(0, bar) || null, at: Number.isFinite(at) ? at : 0 };
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
