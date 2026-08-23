import type { Redis } from 'ioredis';
import type { TempChannel, TempVcStore } from './store.ts';

export const TEMPVC_PREFIX = 'tempvc';

// Longer than any plausible voice session: a key that lapses while someone is still sitting in
// the channel would orphan it, and the guild.available reconcile only runs on reconnect.
export const TEMPVC_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface RedisTempVcStoreOptions {
  keyPrefix?: string;
  ttlMs?: number;
}

export class RedisTempVcStore implements TempVcStore {
  readonly #redis: Redis;
  readonly #prefix: string;
  readonly #ttlMs: number;

  constructor(redis: Redis, options: RedisTempVcStoreOptions = {}) {
    this.#redis = redis;
    this.#prefix = options.keyPrefix ?? TEMPVC_PREFIX;
    this.#ttlMs = options.ttlMs ?? TEMPVC_TTL_MS;
  }

  #channelKey(guildId: string, channelId: string): string {
    return `${this.#prefix}:ch:${guildId}:${channelId}`;
  }

  #ownerKey(guildId: string, userId: string): string {
    return `${this.#prefix}:own:${guildId}:${userId}`;
  }

  #atKey(guildId: string, userId: string): string {
    return `${this.#prefix}:at:${guildId}:${userId}`;
  }

  #occupantsKey(guildId: string, channelId: string): string {
    return `${this.#prefix}:occ:${guildId}:${channelId}`;
  }

  #allKey(guildId: string): string {
    return `${this.#prefix}:all:${guildId}`;
  }

  async claim(channel: TempChannel): Promise<void> {
    const seconds = Math.ceil(this.#ttlMs / 1000);

    await this.#redis
      .multi()
      .hset(this.#channelKey(channel.guildId, channel.channelId), {
        ownerId: channel.ownerId,
        hubChannelId: channel.hubChannelId,
      })
      .expire(this.#channelKey(channel.guildId, channel.channelId), seconds)
      .set(this.#ownerKey(channel.guildId, channel.ownerId), channel.channelId, 'EX', seconds)
      .sadd(this.#allKey(channel.guildId), channel.channelId)
      .expire(this.#allKey(channel.guildId), seconds)
      .exec();
  }

  async get(guildId: string, channelId: string): Promise<TempChannel | null> {
    const row = await this.#redis.hgetall(this.#channelKey(guildId, channelId));
    const ownerId = row.ownerId;
    if (!ownerId) return null;

    return { guildId, channelId, ownerId, hubChannelId: row.hubChannelId ?? '' };
  }

  async ownedBy(guildId: string, userId: string): Promise<string | null> {
    return this.#redis.get(this.#ownerKey(guildId, userId));
  }

  async release(guildId: string, channelId: string): Promise<void> {
    const channel = await this.get(guildId, channelId);

    const pipeline = this.#redis
      .multi()
      .del(this.#channelKey(guildId, channelId))
      .del(this.#occupantsKey(guildId, channelId))
      .srem(this.#allKey(guildId), channelId);

    if (channel) pipeline.del(this.#ownerKey(guildId, channel.ownerId));

    await pipeline.exec();
  }

  async all(guildId: string): Promise<string[]> {
    return this.#redis.smembers(this.#allKey(guildId));
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
      .expire(key, Math.ceil(this.#ttlMs / 1000))
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

  async occupants(guildId: string, channelId: string): Promise<number> {
    return this.#redis.scard(this.#occupantsKey(guildId, channelId));
  }

  async reset(guildId: string, channelId: string, userIds: readonly string[]): Promise<void> {
    const key = this.#occupantsKey(guildId, channelId);

    const pipeline = this.#redis.multi().del(key);
    if (userIds.length > 0) {
      pipeline.sadd(key, ...userIds).expire(key, Math.ceil(this.#ttlMs / 1000));
    }

    await pipeline.exec();
  }
}
