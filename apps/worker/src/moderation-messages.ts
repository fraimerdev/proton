import {
  type EventBus,
  type EventType,
  type Logger,
  type ProtonEvent,
  protonConfigChangedSchema,
  type Subscription,
  snowflakeSchema,
} from '@proton/core';
import {
  handleCardDeleted,
  type MessageHistoryBuffer,
  type ModerationConfig,
  moderationConfigSchema,
  purgeGuild,
  type ReportStore,
  recordCreated,
  recordDeleted,
} from '@proton/module-moderation';
import { z } from 'zod';
import type { ConfigProvider } from './runtime.ts';

export const MODERATION_MESSAGES_GROUP = 'moderation-messages';
export const MODERATION_MODULE_ID = 'moderation';

const TYPES: EventType[] = [
  'message.created',
  'message.deleted',
  'message.bulk_deleted',
  'proton.config_changed',
  'guild.unavailable',
];

const bulkDeletedSchema = z.object({
  ids: z.array(snowflakeSchema),
  channel_id: snowflakeSchema,
  guild_id: snowflakeSchema,
});

export interface ModerationMessagesDeps {
  bus: EventBus;
  config: ConfigProvider;
  history: MessageHistoryBuffer;
  reports?: ReportStore;
  logger: Logger;
  now?(): number;
}

function deletedMessage(payload: unknown): { channelId: string; messageId: string } | null {
  const raw = (payload ?? {}) as { id?: unknown; channel_id?: unknown };
  return typeof raw.id === 'string' && typeof raw.channel_id === 'string'
    ? { channelId: raw.channel_id, messageId: raw.id }
    : null;
}

export function cardChannels(config: ModerationConfig): Set<string> {
  const { channelId, closing } = config.reports;
  return new Set(
    [channelId, closing.accepted.channelId, closing.dismissed.channelId].filter(
      (id): id is string => id !== undefined,
    ),
  );
}

export class ModerationMessagesConsumer {
  readonly #deps: ModerationMessagesDeps;

  constructor(deps: ModerationMessagesDeps) {
    this.#deps = deps;
  }

  start(): Subscription {
    return this.#deps.bus.subscribe(MODERATION_MESSAGES_GROUP, TYPES, (event) =>
      this.handle(event),
    );
  }

  async handle(event: ProtonEvent): Promise<void> {
    if (event.type === 'guild.unavailable') {
      if (event.guildId) await purgeGuild(this.#deps.history, event.guildId);
      return;
    }

    if (event.type === 'proton.config_changed') {
      await this.#onConfigChanged(event);
      return;
    }

    const guildId = event.guildId;
    if (!guildId) return;

    const config = await this.#configFor(guildId);
    if (!config?.enabled) return;

    const now = this.#deps.now?.() ?? Date.now();

    if (event.type === 'message.created') {
      await recordCreated(this.#deps.history, config, event.payload, now);
      return;
    }

    if (event.type === 'message.bulk_deleted') {
      const bulk = bulkDeletedSchema.safeParse(event.payload);
      if (!bulk.success) return;

      const { ids, channel_id: channelId, guild_id } = bulk.data;
      for (const id of ids) {
        await recordDeleted(
          this.#deps.history,
          config,
          { id, channel_id: channelId, guild_id },
          now,
        );
        await this.#cardDeleted(guildId, config, { channelId, messageId: id }, now);
      }
      return;
    }

    if (event.type !== 'message.deleted') return;

    await recordDeleted(this.#deps.history, config, event.payload, now);

    const deleted = deletedMessage(event.payload);
    if (deleted) await this.#cardDeleted(guildId, config, deleted, now);
  }

  async #cardDeleted(
    guildId: string,
    config: ModerationConfig,
    deleted: { channelId: string; messageId: string },
    now: number,
  ): Promise<void> {
    const reports = this.#deps.reports;
    if (!reports || !cardChannels(config).has(deleted.channelId)) return;

    const missing = await handleCardDeleted(
      reports,
      guildId,
      deleted.channelId,
      deleted.messageId,
      now,
    );
    if (missing) {
      this.#deps.logger.info('a report card was deleted in Discord and is now marked missing', {
        guildId,
        reportId: missing.id,
        channelId: deleted.channelId,
      });
    }
  }

  async #onConfigChanged(event: ProtonEvent): Promise<void> {
    const changed = protonConfigChangedSchema.safeParse(event.payload);
    if (!changed.success || changed.data.moduleId !== MODERATION_MODULE_ID) return;

    const guildId = changed.data.guildId;
    this.#deps.config.invalidate?.(guildId, MODERATION_MODULE_ID);

    // Unreadable counts as off: a purged buffer refills, a message kept after opt-out is a leak.
    const config = await this.#configFor(guildId);
    if (config?.enabled && config.punish.messageHistory) return;

    await purgeGuild(this.#deps.history, guildId);
    this.#deps.logger.info('purged the case message history buffer after it was turned off', {
      guildId,
    });
  }

  async #configFor(guildId: string): Promise<ModerationConfig | null> {
    try {
      const snapshot = await this.#deps.config.get(guildId, MODERATION_MODULE_ID);
      if (!snapshot.enabled) return null;

      const parsed = moderationConfigSchema.safeParse(snapshot.config);
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }
}
