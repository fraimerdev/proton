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

/**
 * Turn one normalised event into the rows it should log.
 *
 * Pure, and the only place that reads Discord's message payloads, so what does
 * and does not get stored is one readable function rather than a policy spread
 * across three handlers.
 *
 * Two absences are Discord's, not oversights, and both matter to anyone reading
 * the resulting log:
 *
 *  - **MESSAGE_UPDATE carries no previous content.** `contentBefore` is
 *    therefore always null. Recovering it means storing every message on
 *    creation, which is a different product with a much larger legal surface
 *    (§6 calls content retention a legal surface, and §14.5 leaves the policy to
 *    the owner) — so it is not smuggled in here.
 *  - **MESSAGE_DELETE carries no content and no author at all.** A deletion row
 *    records which message, in which channel, at what time. It cannot record
 *    what the message said for the same reason.
 */
export function toMessageLogEntries(event: ProtonEvent, config: LoggingConfig): MessageLogEntry[] {
  const d = event.payload as Record<string, unknown>;
  // DMs have no guild, so there is no guild that opted in and no config that
  // governs them. Nothing outside a guild is ever logged.
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
      // A MESSAGE_UPDATE without `content` is Discord resolving an embed, pinning,
      // or flagging — not a member editing text. Logging those as edits would fill
      // the log with entries that read as "the message was blanked".
      const content = str(d.content);
      if (!messageId || content === null) return [];

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

      // One row per message, so a purge of 100 messages reads the same way in the
      // log as 100 individual deletions. The row id stays deterministic — it has
      // to, or a redelivered bulk delete would double every row (I4).
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
