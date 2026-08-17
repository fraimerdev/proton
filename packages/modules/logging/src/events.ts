import type { CachedMessage, ProtonEvent } from '@proton/core';
import type { LoggingConfig } from './config.ts';
import type { MessageLogEntry } from './store.ts';

export type CachedMessages = ReadonlyMap<string, CachedMessage>;

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function nested(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

export function toMessageLogEntries(
  event: ProtonEvent,
  config: LoggingConfig,
  cached: CachedMessages = new Map(),
): MessageLogEntry[] {
  const d = event.payload as Record<string, unknown>;

  const guildId = event.guildId ?? str(d.guild_id);
  const channelId = str(d.channel_id);
  if (!guildId || !channelId) return [];

  if (config.ignoredChannels.includes(channelId)) return [];

  const occurredAt = new Date(event.occurredAt);
  const base = { guildId, channelId, occurredAt } as const;

  switch (event.type) {
    case 'message.updated': {
      if (!config.logEdits) return [];

      const messageId = str(d.id);
      const content = str(d.content);

      if (!messageId || content === null || str(d.edited_timestamp) === null) return [];

      const before = cached.get(messageId);

      return [
        {
          ...base,
          id: event.id,
          messageId,
          authorId: str(nested(d.author, 'id')) ?? before?.authorId ?? null,
          kind: 'edit',
          contentBefore: before?.content ?? null,
          contentAfter: content,
        },
      ];
    }

    case 'message.deleted': {
      if (!config.logDeletes) return [];

      const messageId = str(d.id);
      if (!messageId) return [];

      // MESSAGE_DELETE carries no author, so without the cache a delete log cannot say who wrote
      // the message it is reporting.
      const before = cached.get(messageId);

      return [
        {
          ...base,
          id: event.id,
          messageId,
          authorId: before?.authorId ?? null,
          kind: 'delete',
          contentBefore: before?.content ?? null,
          contentAfter: null,
        },
      ];
    }

    case 'message.bulk_deleted': {
      if (!config.logDeletes) return [];

      const ids = Array.isArray(d.ids)
        ? d.ids.filter((id): id is string => typeof id === 'string')
        : [];

      return ids.map((messageId) => {
        const before = cached.get(messageId);

        return {
          ...base,
          id: `${event.id}:${messageId}`,
          messageId,
          authorId: before?.authorId ?? null,
          kind: 'bulk_delete' as const,
          contentBefore: before?.content ?? null,
          contentAfter: null,
        };
      });
    }

    default:
      return [];
  }
}

export function messageIdsOf(event: ProtonEvent): string[] {
  const d = event.payload as Record<string, unknown>;

  if (event.type === 'message.bulk_deleted') {
    return Array.isArray(d.ids) ? d.ids.filter((id): id is string => typeof id === 'string') : [];
  }

  const messageId = str(d.id);
  return messageId ? [messageId] : [];
}
