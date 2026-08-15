import {
  type AuditLogEventType,
  auditLogEventPayloadSchema,
  type EventType,
  type ProtonEvent,
  snowflakeCreatedAt,
} from '@proton/core';
import { AuditLogEvent } from 'discord-api-types/v10';

export interface RawDispatch {
  t: string;
  s: number;
  op: number;
  d: Record<string, unknown>;
}

export const CHANNEL_OBFUSCATED = 1 << 17;

export function isObfuscatedChannel(channel: { flags?: number }): boolean {
  return ((channel.flags ?? 0) & CHANNEL_OBFUSCATED) === CHANNEL_OBFUSCATED;
}

export function deriveEventId(type: EventType, naturalKey: string): string {
  return `${type}:${naturalKey}`;
}

export const AUDIT_LOG_ACTIONS: ReadonlyMap<number, AuditLogEventType> = new Map([
  [AuditLogEvent.ChannelCreate, 'channel.created'],
  [AuditLogEvent.ChannelDelete, 'channel.deleted'],
  [AuditLogEvent.MemberKick, 'member.kicked'],
  [AuditLogEvent.MemberBanAdd, 'member.banned'],
  [AuditLogEvent.MemberBanRemove, 'member.unbanned'],
  [AuditLogEvent.RoleCreate, 'role.created'],
  [AuditLogEvent.RoleDelete, 'role.deleted'],
  [AuditLogEvent.WebhookDelete, 'webhook.deleted'],
  [AuditLogEvent.EmojiDelete, 'emoji.deleted'],
]);

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function nested(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

function parseTimestamp(value: unknown, fallback: number): number {
  const raw = str(value);
  if (!raw) return fallback;
  const parsed = Date.parse(raw);
  return Number.isNaN(parsed) ? fallback : parsed;
}

export interface NormaliseOptions {
  now?: () => number;
}

export const NORMALISED_EVENT_TYPES: readonly EventType[] = [
  'guild.available',
  'guild.unavailable',
  'member.joined',
  'member.left',

  'channel.created',
  'channel.deleted',
  'member.kicked',
  'member.banned',
  'member.unbanned',
  'role.created',
  'role.deleted',
  'webhook.deleted',
  'emoji.deleted',

  'message.created',
  'message.updated',
  'message.deleted',
  'message.bulk_deleted',

  'reaction.added',
  'reaction.removed',

  'voice.state_updated',

  'member.updated',

  'interaction.command',
  'interaction.component',
] as const;

export function normalise(raw: RawDispatch, options: NormaliseOptions = {}): ProtonEvent | null {
  const now = options.now?.() ?? Date.now();
  const d = raw.d;

  switch (raw.t) {
    case 'GUILD_CREATE': {
      const guildId = str(d.id);
      if (!guildId) return null;
      return {
        id: deriveEventId('guild.available', guildId),
        type: 'guild.available',
        guildId,
        occurredAt: now,
        payload: d,
      };
    }

    case 'GUILD_DELETE': {
      const guildId = str(d.id);
      if (!guildId) return null;
      return {
        id: deriveEventId('guild.unavailable', guildId),
        type: 'guild.unavailable',
        guildId,
        occurredAt: now,
        payload: d,
      };
    }

    case 'GUILD_MEMBER_ADD': {
      const guildId = str(d.guild_id);
      const userId = str(nested(d.user, 'id'));
      if (!guildId || !userId) return null;

      const joinedAt = str(d.joined_at) ?? String(now);
      return {
        id: deriveEventId('member.joined', `${guildId}:${userId}:${joinedAt}`),
        type: 'member.joined',
        guildId,
        occurredAt: parseTimestamp(d.joined_at, now),
        payload: d,
      };
    }

    case 'GUILD_MEMBER_REMOVE': {
      const guildId = str(d.guild_id);
      const userId = str(nested(d.user, 'id'));
      if (!guildId || !userId) return null;
      return {
        id: deriveEventId('member.left', `${guildId}:${userId}:${raw.s}`),
        type: 'member.left',
        guildId,
        occurredAt: now,
        payload: d,
      };
    }

    case 'GUILD_AUDIT_LOG_ENTRY_CREATE': {
      const actionType = typeof d.action_type === 'number' ? d.action_type : -1;
      const type = AUDIT_LOG_ACTIONS.get(actionType);
      if (type === undefined) return null;

      const parsed = auditLogEventPayloadSchema.safeParse({
        entryId: str(d.id),
        guildId: str(d.guild_id),
        actionType,
        actorId: str(d.user_id),
        targetId: str(d.target_id),
        reason: str(d.reason),
      });
      if (!parsed.success) return null;

      return {
        id: deriveEventId(type, parsed.data.entryId),
        type,
        guildId: parsed.data.guildId,

        occurredAt: snowflakeCreatedAt(parsed.data.entryId) ?? now,
        payload: parsed.data,
      };
    }

    case 'MESSAGE_CREATE': {
      const messageId = str(d.id);
      if (!messageId) return null;
      return {
        id: deriveEventId('message.created', messageId),
        type: 'message.created',
        guildId: str(d.guild_id),
        occurredAt: parseTimestamp(d.timestamp, now),
        payload: d,
      };
    }

    case 'MESSAGE_UPDATE': {
      const messageId = str(d.id);
      if (!messageId) return null;
      const editedAt = str(d.edited_timestamp);
      return {
        id: deriveEventId('message.updated', `${messageId}:${editedAt ?? 'noedit'}`),
        type: 'message.updated',
        guildId: str(d.guild_id),
        occurredAt: parseTimestamp(editedAt ?? d.timestamp, now),
        payload: d,
      };
    }

    case 'MESSAGE_DELETE': {
      const messageId = str(d.id);
      if (!messageId) return null;
      return {
        id: deriveEventId('message.deleted', messageId),
        type: 'message.deleted',
        guildId: str(d.guild_id),
        occurredAt: now,
        payload: d,
      };
    }

    case 'MESSAGE_DELETE_BULK': {
      const channelId = str(d.channel_id);
      const ids = Array.isArray(d.ids)
        ? d.ids.filter((id): id is string => typeof id === 'string')
        : [];
      if (!channelId || ids.length === 0) return null;

      const digest = Bun.hash([...ids].sort().join(',')).toString(36);
      return {
        id: deriveEventId('message.bulk_deleted', `${channelId}:${ids.length}:${digest}`),
        type: 'message.bulk_deleted',
        guildId: str(d.guild_id),
        occurredAt: now,
        payload: d,
      };
    }

    case 'GUILD_MEMBER_UPDATE': {
      const guildId = str(d.guild_id);
      const userId = str(nested(d.user, 'id'));
      if (!guildId || !userId) return null;

      const roles = Array.isArray(d.roles)
        ? d.roles.filter((role): role is string => typeof role === 'string')
        : [];
      const state = [
        [...roles].sort().join(','),
        str(d.nick) ?? '',
        str(d.communication_disabled_until) ?? '',
      ].join('|');

      return {
        id: deriveEventId('member.updated', `${guildId}:${userId}:${Bun.hash(state).toString(36)}`),
        type: 'member.updated',
        guildId,
        occurredAt: now,
        payload: d,
      };
    }

    // Reactions carry no id. Never fold `raw.s` into the key — it changes on RESUME and breaks I4.
    case 'MESSAGE_REACTION_ADD':
    case 'MESSAGE_REACTION_REMOVE': {
      const channelId = str(d.channel_id);
      const messageId = str(d.message_id);
      const userId = str(d.user_id);
      if (!channelId || !messageId || !userId) return null;

      const emoji = str(nested(d.emoji, 'id')) ?? str(nested(d.emoji, 'name'));
      if (!emoji) return null;

      const type: EventType =
        raw.t === 'MESSAGE_REACTION_ADD' ? 'reaction.added' : 'reaction.removed';

      return {
        id: deriveEventId(type, `${channelId}:${messageId}:${userId}:${emoji}`),
        type,
        guildId: str(d.guild_id),
        occurredAt: now,
        payload: d,
      };
    }

    case 'VOICE_STATE_UPDATE': {
      const guildId = str(d.guild_id);
      const userId = str(d.user_id);
      const sessionId = str(d.session_id);
      if (!guildId || !userId || !sessionId) return null;

      const channelId = str(d.channel_id);
      return {
        id: deriveEventId(
          'voice.state_updated',
          `${guildId}:${userId}:${sessionId}:${channelId ?? 'disconnect'}`,
        ),
        type: 'voice.state_updated',
        guildId,
        occurredAt: now,
        payload: d,
      };
    }

    case 'INTERACTION_CREATE': {
      const interactionId = str(d.id);
      if (!interactionId) return null;

      const type: EventType | null =
        d.type === 2 ? 'interaction.command' : d.type === 3 ? 'interaction.component' : null;
      if (!type) return null;

      return {
        id: deriveEventId(type, interactionId),
        type,
        guildId: str(d.guild_id),
        occurredAt: now,
        payload: d,
      };
    }

    default:
      return null;
  }
}
