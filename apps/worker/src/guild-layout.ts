import type { EventBus, EventType, Logger, Subscription } from '@proton/core';
import type { GuildLayout } from '@proton/module-backup';
import type { Redis } from 'ioredis';

export const GUILD_LAYOUT_PREFIX = 'proton:layout';

export const guildLayoutKey = (guildId: string): string => `${GUILD_LAYOUT_PREFIX}:${guildId}`;

export interface StoredGuildLayout extends GuildLayout {
  capturedAt: number;
}

export interface GuildLayoutStore {
  get(guildId: string): Promise<StoredGuildLayout | null>;
  put(layout: StoredGuildLayout): Promise<void>;
  delete(guildId: string): Promise<void>;
}

export class RedisGuildLayoutStore implements GuildLayoutStore {
  readonly #redis: Redis;

  constructor(redis: Redis) {
    this.#redis = redis;
  }

  async get(guildId: string): Promise<StoredGuildLayout | null> {
    const raw = await this.#redis.get(guildLayoutKey(guildId));
    if (!raw) return null;

    try {
      const parsed = JSON.parse(raw) as StoredGuildLayout;

      if (!Array.isArray(parsed.channels) || !Array.isArray(parsed.roles)) return null;
      return parsed;
    } catch {
      return null;
    }
  }

  async put(layout: StoredGuildLayout): Promise<void> {
    await this.#redis.set(guildLayoutKey(layout.guildId), JSON.stringify(layout));
  }

  async delete(guildId: string): Promise<void> {
    await this.#redis.del(guildLayoutKey(guildId));
  }
}

const TYPES: EventType[] = ['guild.available', 'guild.unavailable'];

export interface GuildLayoutConsumerDeps {
  bus: EventBus;
  store: GuildLayoutStore;
  logger: Logger;
  group?: string;
}

export class GuildLayoutConsumer {
  readonly #deps: GuildLayoutConsumerDeps;

  constructor(deps: GuildLayoutConsumerDeps) {
    this.#deps = deps;
  }

  start(): Subscription {
    return this.#deps.bus.subscribe(this.#deps.group ?? 'guild-layout', TYPES, (event) =>
      this.handle(event),
    );
  }

  async handle(event: {
    type: string;
    guildId: string | null;
    occurredAt: number;
    payload: unknown;
  }): Promise<void> {
    if (!event.guildId) return;
    const payload = (event.payload ?? {}) as Record<string, unknown>;

    if (event.type === 'guild.unavailable') {
      if (payload.unavailable === true) return;

      const held = await this.#deps.store.get(event.guildId);
      if (held && held.capturedAt > event.occurredAt) {
        this.#deps.logger.info(
          'ignored a guild-removal event older than the layout already stored for it',
          { guildId: event.guildId },
        );
        return;
      }

      await this.#deps.store.delete(event.guildId);
      return;
    }

    const channels = Array.isArray(payload.channels) ? payload.channels : [];
    const roles = Array.isArray(payload.roles) ? payload.roles : [];

    if (channels.length === 0 && roles.length === 0) {
      this.#deps.logger.warn(
        'guild.available carried no channels or roles, so no backup layout was stored for this ' +
          'server. Backups taken now would be empty.',
        { guildId: event.guildId },
      );
      return;
    }

    const held = await this.#deps.store.get(event.guildId);
    if (held && held.capturedAt > event.occurredAt) return;

    await this.#deps.store.put({
      guildId: event.guildId,
      source: 'gateway',
      capturedAt: event.occurredAt,
      channels,
      roles,
    });

    this.#deps.logger.info('backup layout cached', {
      guildId: event.guildId,
      channels: channels.length,
      roles: roles.length,
    });
  }
}
