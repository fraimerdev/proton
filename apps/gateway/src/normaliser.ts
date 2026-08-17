import {
  type AuditEntry,
  type AuditLogEventType,
  auditEntrySchema,
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

function digest(value: unknown): string {
  return Bun.hash(JSON.stringify(value ?? null)).toString(36);
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

  'audit.entry',

  'entity.guild_updated',
  'entity.channel_created',
  'entity.channel_updated',
  'entity.channel_deleted',
  'entity.channel_pins_updated',
  'entity.thread_created',
  'entity.thread_updated',
  'entity.thread_deleted',
  'entity.role_created',
  'entity.role_updated',
  'entity.role_deleted',
  'entity.ban_added',
  'entity.ban_removed',
  'entity.invite_created',
  'entity.invite_deleted',

  'message.created',
  'message.updated',
  'message.deleted',
  'message.bulk_deleted',

  'reaction.added',
  'reaction.removed',

  'voice.state_updated',

  'automod.executed',

  'member.updated',

  'interaction.command',
  'interaction.component',
] as const;

function event(
  type: EventType,
  naturalKey: string,
  guildId: string | null,
  occurredAt: number,
  payload: unknown,
): ProtonEvent {
  return { id: deriveEventId(type, naturalKey), type, guildId, occurredAt, payload };
}

function auditEvents(d: Record<string, unknown>, now: number): ProtonEvent[] {
  const actionType = typeof d.action_type === 'number' ? d.action_type : -1;

  const parsed = auditEntrySchema.safeParse({
    entryId: str(d.id),
    guildId: str(d.guild_id),
    actionType,
    actorId: str(d.user_id),
    targetId: str(d.target_id),
    reason: str(d.reason),
    changes: Array.isArray(d.changes) ? d.changes : [],
    options: typeof d.options === 'object' ? d.options : null,
  });
  if (!parsed.success) return [];

  const entry: AuditEntry = parsed.data;
  const occurredAt = snowflakeCreatedAt(entry.entryId) ?? now;

  const events: ProtonEvent[] = [];

  // The nine narrow types predate audit.entry and carry the older, smaller payload. antinuke
  // reads them; widening them would change a shape that is already in flight on Redis.
  const narrow = AUDIT_LOG_ACTIONS.get(actionType);
  if (narrow) {
    const { changes: _changes, options: _options, ...legacy } = entry;
    events.push(event(narrow, entry.entryId, entry.guildId, occurredAt, legacy));
  }

  events.push(event('audit.entry', entry.entryId, entry.guildId, occurredAt, entry));

  return events;
}

export function normalise(raw: RawDispatch, options: NormaliseOptions = {}): ProtonEvent[] {
  const now = options.now?.() ?? Date.now();
  const d = raw.d;

  switch (raw.t) {
    case 'GUILD_CREATE': {
      const guildId = str(d.id);
      if (!guildId) return [];
      return [event('guild.available', guildId, guildId, now, d)];
    }

    case 'GUILD_DELETE': {
      const guildId = str(d.id);
      if (!guildId) return [];
      return [event('guild.unavailable', guildId, guildId, now, d)];
    }

    case 'GUILD_UPDATE': {
      const guildId = str(d.id);
      if (!guildId) return [];
      return [event('entity.guild_updated', `${guildId}:${digest(d)}`, guildId, now, d)];
    }

    case 'GUILD_MEMBER_ADD': {
      const guildId = str(d.guild_id);
      const userId = str(nested(d.user, 'id'));
      if (!guildId || !userId) return [];

      const joinedAt = str(d.joined_at) ?? String(now);
      return [
        event(
          'member.joined',
          `${guildId}:${userId}:${joinedAt}`,
          guildId,
          parseTimestamp(d.joined_at, now),
          d,
        ),
      ];
    }

    case 'GUILD_MEMBER_REMOVE': {
      const guildId = str(d.guild_id);
      const userId = str(nested(d.user, 'id'));
      if (!guildId || !userId) return [];
      return [event('member.left', `${guildId}:${userId}:${raw.s}`, guildId, now, d)];
    }

    case 'GUILD_AUDIT_LOG_ENTRY_CREATE':
      return auditEvents(d, now);

    case 'GUILD_BAN_ADD':
    case 'GUILD_BAN_REMOVE': {
      const guildId = str(d.guild_id);
      const userId = str(nested(d.user, 'id'));
      if (!guildId || !userId) return [];

      const type: EventType = raw.t === 'GUILD_BAN_ADD' ? 'entity.ban_added' : 'entity.ban_removed';
      return [event(type, `${guildId}:${userId}`, guildId, now, d)];
    }

    case 'CHANNEL_CREATE':
    case 'CHANNEL_DELETE': {
      const channelId = str(d.id);
      if (!channelId) return [];

      const type: EventType =
        raw.t === 'CHANNEL_CREATE' ? 'entity.channel_created' : 'entity.channel_deleted';
      return [event(type, channelId, str(d.guild_id), now, d)];
    }

    case 'CHANNEL_UPDATE': {
      const channelId = str(d.id);
      if (!channelId) return [];
      return [
        event('entity.channel_updated', `${channelId}:${digest(d)}`, str(d.guild_id), now, d),
      ];
    }

    case 'CHANNEL_PINS_UPDATE': {
      const channelId = str(d.channel_id);
      if (!channelId) return [];
      return [
        event(
          'entity.channel_pins_updated',
          `${channelId}:${str(d.last_pin_timestamp) ?? 'none'}`,
          str(d.guild_id),
          now,
          d,
        ),
      ];
    }

    case 'THREAD_CREATE':
    case 'THREAD_DELETE': {
      const threadId = str(d.id);
      if (!threadId) return [];

      const type: EventType =
        raw.t === 'THREAD_CREATE' ? 'entity.thread_created' : 'entity.thread_deleted';
      return [event(type, threadId, str(d.guild_id), now, d)];
    }

    case 'THREAD_UPDATE': {
      const threadId = str(d.id);
      if (!threadId) return [];
      return [event('entity.thread_updated', `${threadId}:${digest(d)}`, str(d.guild_id), now, d)];
    }

    case 'GUILD_ROLE_CREATE':
    case 'GUILD_ROLE_UPDATE': {
      const guildId = str(d.guild_id);
      const roleId = str(nested(d.role, 'id'));
      if (!guildId || !roleId) return [];

      if (raw.t === 'GUILD_ROLE_CREATE') {
        return [event('entity.role_created', roleId, guildId, now, d)];
      }
      return [event('entity.role_updated', `${roleId}:${digest(d.role)}`, guildId, now, d)];
    }

    case 'GUILD_ROLE_DELETE': {
      const guildId = str(d.guild_id);
      const roleId = str(d.role_id);
      if (!guildId || !roleId) return [];
      return [event('entity.role_deleted', roleId, guildId, now, d)];
    }

    case 'INVITE_CREATE':
    case 'INVITE_DELETE': {
      const code = str(d.code);
      if (!code) return [];

      const type: EventType =
        raw.t === 'INVITE_CREATE' ? 'entity.invite_created' : 'entity.invite_deleted';
      return [event(type, code, str(d.guild_id), now, d)];
    }

    case 'MESSAGE_CREATE': {
      const messageId = str(d.id);
      if (!messageId) return [];
      return [
        event('message.created', messageId, str(d.guild_id), parseTimestamp(d.timestamp, now), d),
      ];
    }

    case 'MESSAGE_UPDATE': {
      const messageId = str(d.id);
      if (!messageId) return [];
      const editedAt = str(d.edited_timestamp);
      return [
        event(
          'message.updated',
          `${messageId}:${editedAt ?? 'noedit'}`,
          str(d.guild_id),
          parseTimestamp(editedAt ?? d.timestamp, now),
          d,
        ),
      ];
    }

    case 'MESSAGE_DELETE': {
      const messageId = str(d.id);
      if (!messageId) return [];
      return [event('message.deleted', messageId, str(d.guild_id), now, d)];
    }

    case 'MESSAGE_DELETE_BULK': {
      const channelId = str(d.channel_id);
      const ids = Array.isArray(d.ids)
        ? d.ids.filter((id): id is string => typeof id === 'string')
        : [];
      if (!channelId || ids.length === 0) return [];

      const hashed = Bun.hash([...ids].sort().join(',')).toString(36);
      return [
        event(
          'message.bulk_deleted',
          `${channelId}:${ids.length}:${hashed}`,
          str(d.guild_id),
          now,
          d,
        ),
      ];
    }

    case 'GUILD_MEMBER_UPDATE': {
      const guildId = str(d.guild_id);
      const userId = str(nested(d.user, 'id'));
      if (!guildId || !userId) return [];

      const roles = Array.isArray(d.roles)
        ? d.roles.filter((role): role is string => typeof role === 'string')
        : [];
      const state = [
        [...roles].sort().join(','),
        str(d.nick) ?? '',
        str(d.communication_disabled_until) ?? '',
        d.pending === true ? 'pending' : '',
      ].join('|');

      return [
        event(
          'member.updated',
          `${guildId}:${userId}:${Bun.hash(state).toString(36)}`,
          guildId,
          now,
          d,
        ),
      ];
    }

    // Reactions carry no id. Never fold `raw.s` into the key — it changes on RESUME and breaks I4.
    case 'MESSAGE_REACTION_ADD':
    case 'MESSAGE_REACTION_REMOVE': {
      const channelId = str(d.channel_id);
      const messageId = str(d.message_id);
      const userId = str(d.user_id);
      if (!channelId || !messageId || !userId) return [];

      const emoji = str(nested(d.emoji, 'id')) ?? str(nested(d.emoji, 'name'));
      if (!emoji) return [];

      const type: EventType =
        raw.t === 'MESSAGE_REACTION_ADD' ? 'reaction.added' : 'reaction.removed';

      return [event(type, `${channelId}:${messageId}:${userId}:${emoji}`, str(d.guild_id), now, d)];
    }

    case 'AUTO_MODERATION_ACTION_EXECUTION': {
      const guildId = str(d.guild_id);
      const ruleId = str(d.rule_id);
      const userId = str(d.user_id);
      if (!guildId || !ruleId || !userId) return [];

      // There is no execution id, and `message_id` is absent when the message was blocked outright
      // — so a blocked message is keyed by its content. Posting the identical blocked message twice
      // therefore collapses to one event, which is right for a log and the same trade the reaction
      // arm makes.
      const occurrence = str(d.message_id) ?? digest(d.matched_content ?? d.content);

      return [
        event('automod.executed', `${guildId}:${ruleId}:${userId}:${occurrence}`, guildId, now, d),
      ];
    }

    case 'VOICE_STATE_UPDATE': {
      const guildId = str(d.guild_id);
      const userId = str(d.user_id);
      const sessionId = str(d.session_id);
      if (!guildId || !userId || !sessionId) return [];

      const channelId = str(d.channel_id);
      return [
        event(
          'voice.state_updated',
          `${guildId}:${userId}:${sessionId}:${channelId ?? 'disconnect'}`,
          guildId,
          now,
          d,
        ),
      ];
    }

    case 'INTERACTION_CREATE': {
      const interactionId = str(d.id);
      if (!interactionId) return [];

      const type: EventType | null =
        d.type === 2 ? 'interaction.command' : d.type === 3 ? 'interaction.component' : null;
      if (!type) return [];

      return [event(type, interactionId, str(d.guild_id), now, d)];
    }

    default:
      return [];
  }
}
