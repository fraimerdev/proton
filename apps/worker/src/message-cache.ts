import type { EventBus } from '@proton/core';
import {
  type EventType,
  type Logger,
  type MessageContentCache,
  type ProtonEvent,
  parseDuration,
  type Subscription,
  toCachedMessage,
} from '@proton/core';
import {
  type LoggingConfig,
  loggingConfigSchema,
  MESSAGE_CACHE_FALLBACK_TTL_MS,
} from '@proton/module-logging';
import type { ConfigProvider } from './runtime.ts';

export const MESSAGE_CACHE_GROUP = 'message-cache';
export const LOGGING_MODULE_ID = 'logging';

// message.updated is deliberately absent. This consumer and serverlog are different consumer
// groups on the same stream, so caching the new text here could outrun serverlog's read of the
// old text. The edit path re-caches after it has rendered.
const TYPES: EventType[] = ['message.created', 'guild.unavailable', 'proton.config_changed'];

export interface MessageCacheConsumerDeps {
  bus: EventBus;
  cache: MessageContentCache;
  config: ConfigProvider;
  botUserId: string;
  logger: Logger;
}

export class MessageCacheConsumer {
  readonly #deps: MessageCacheConsumerDeps;

  constructor(deps: MessageCacheConsumerDeps) {
    this.#deps = deps;
  }

  start(): Subscription {
    return this.#deps.bus.subscribe(MESSAGE_CACHE_GROUP, TYPES, (event) => this.handle(event));
  }

  async handle(event: ProtonEvent): Promise<void> {
    if (event.type === 'guild.unavailable') {
      if (event.guildId) await this.#deps.cache.purge(event.guildId);
      return;
    }

    if (event.type === 'proton.config_changed') {
      await this.#onConfigChanged(event);
      return;
    }

    await this.#onMessage(event);
  }

  async #onConfigChanged(event: ProtonEvent): Promise<void> {
    const payload = event.payload as {
      guildId?: unknown;
      moduleId?: unknown;
      changedKeys?: unknown;
    };

    if (payload.moduleId !== LOGGING_MODULE_ID) return;
    if (typeof payload.guildId !== 'string') return;

    const changed = Array.isArray(payload.changedKeys) ? payload.changedKeys : [];
    if (!changed.includes('cacheMessageContent')) return;

    // Opting out has to actually delete, not merely stop writing.
    const config = await this.#configFor(payload.guildId);
    if (config?.cacheMessageContent === true) return;

    const removed = await this.#deps.cache.purge(payload.guildId);
    this.#deps.logger.info('purged the message cache after it was switched off', {
      guildId: payload.guildId,
      removed,
    });
  }

  async #onMessage(event: ProtonEvent): Promise<void> {
    const guildId = event.guildId;
    if (!guildId) return;

    const config = await this.#configFor(guildId);
    if (!config?.enabled || !config.cacheMessageContent) return;

    const payload = event.payload as { id?: unknown; channel_id?: unknown };
    const messageId = typeof payload.id === 'string' ? payload.id : null;
    const channelId = typeof payload.channel_id === 'string' ? payload.channel_id : null;
    if (!messageId || !channelId) return;

    if (config.ignoredChannels.includes(channelId)) return;

    const message = toCachedMessage(event.payload);
    if (!message || message.authorId === this.#deps.botUserId) return;

    await this.#deps.cache.put(guildId, messageId, message, ttlOf(config));
  }

  async #configFor(guildId: string): Promise<LoggingConfig | null> {
    try {
      const snapshot = await this.#deps.config.get(guildId, LOGGING_MODULE_ID);
      if (!snapshot.enabled) return null;

      const parsed = loggingConfigSchema.safeParse(snapshot.config);
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }
}

export function ttlOf(config: LoggingConfig): number {
  try {
    return parseDuration(config.cacheRetention);
  } catch {
    return MESSAGE_CACHE_FALLBACK_TTL_MS;
  }
}
