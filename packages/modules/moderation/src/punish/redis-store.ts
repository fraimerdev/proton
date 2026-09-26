import type { Redis } from 'ioredis';
import type { DmChannelStore } from './store.ts';

export const DM_CHANNEL_PREFIX = 'proton:moderation:dm';

export const DM_CHANNEL_TTL_MS = 24 * 60 * 60 * 1000;

export function dmChannelKey(guildId: string, userId: string): string {
  return `${DM_CHANNEL_PREFIX}:${guildId}:${userId}`;
}

export class RedisDmChannelStore implements DmChannelStore {
  readonly #redis: Redis;

  constructor(redis: Redis) {
    this.#redis = redis;
  }

  async recall(guildId: string, userId: string): Promise<string | null> {
    return this.#redis.get(dmChannelKey(guildId, userId));
  }

  async remember(guildId: string, userId: string, channelId: string): Promise<void> {
    await this.#redis.set(dmChannelKey(guildId, userId), channelId, 'PX', DM_CHANNEL_TTL_MS);
  }
}
