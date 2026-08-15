import type { ProtonEvent } from '@proton/core';
import type { LoggingConfig } from './config.ts';
import type { MessageLogEntry } from './store.ts';

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function nested(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

export function toMessageLogEntries(event: ProtonEvent, config: LoggingConfig): MessageLogEntry[] {
  const d = event.payload as Record<string, unknown>;

  const guildId = event.guildId ?? str(d.guild_id);
  const channelId = str(d.channel_id);
  if (!guildId || !channelId) return [];

  if (config.ignoredChannels.includes(channelId)) return [];

  const occurredAt = new Date(event.occurredAt);
  const base = { guildId, channelId, contentBefore: null, occurredAt } as const;

  switch (event.type) {
    case 'message.updated': {
      if (!config.logEdits) return [];

      const messageId = str(d.id);
      const content = str(d.content);

      if (!messageId || content === null || str(d.edited_timestamp) === null) return [];

      return [
        {
          ...base,
          id: event.id,
          messageId,
          authorId: str(nested(d.author, 'id')),
          kind: 'edit',
          contentAfter: content,
        },
      ];
    }

    case 'message.deleted': {
      if (!config.logDeletes) return [];

      const messageId = str(d.id);
      if (!messageId) return [];

      return [
        {
          ...base,
          id: event.id,
          messageId,
          authorId: null,
          kind: 'delete',
          contentAfter: null,
        },
      ];
    }

    case 'message.bulk_deleted': {
      if (!config.logDeletes) return [];

      const ids = Array.isArray(d.ids)
        ? d.ids.filter((id): id is string => typeof id === 'string')
        : [];

      return ids.map((messageId) => ({
        ...base,
        id: `${event.id}:${messageId}`,
        messageId,
        authorId: null,
        kind: 'bulk_delete' as const,
        contentAfter: null,
      }));
    }

    default:
      return [];
  }
}
