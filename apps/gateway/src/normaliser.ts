import type { EventType, ProtonEvent } from '@proton/core';

export interface RawDispatch {
  t: string;
  s: number;
  op: number;
  d: Record<string, unknown>;
}

/**
 * Channel flag `CHANNEL_OBFUSCATED` (1<<17), verified against Discord's channel
 * reference. Mandatory from 16 Nov 2026: channels the bot cannot VIEW_CHANNEL
 * still arrive, with name and topic replaced by `___hidden___`.
 */
export const CHANNEL_OBFUSCATED = 1 << 17;

/**
 * Detect an obfuscated channel.
 *
 * Discord's documentation is explicit that you must not inspect `name` or any
 * other obfuscated field — a guild is perfectly entitled to name a real channel
 * `___hidden___`, and testing the string would then hide a channel the bot can
 * actually see. `id`, `type`, `position` and `parent_id` are never obfuscated.
 */
export function isObfuscatedChannel(channel: { flags?: number }): boolean {
  return ((channel.flags ?? 0) & CHANNEL_OBFUSCATED) === CHANNEL_OBFUSCATED;
}

/**
 * Build a **deterministic** event id from the dispatch.
 *
 * PLAN.md §4-P1 describes this field as a ULID, but a freshly generated ULID
 * would defeat its own purpose: it is also the dedupe key (I4), and gateway
 * RESUME redelivers dispatches verbatim. A random id per delivery means the same
 * Discord event arrives with two different ids and is handled twice — which is
 * precisely the catastrophic bug class I4 exists to prevent.
 *
 * So the id is derived from Discord's own identifiers, which are stable across
 * redelivery. Kept human-readable rather than hashed, because it turns up in
 * logs and `cases.idempotency_key` where being able to read it matters.
 * See plan deviation D18.
 */
export function deriveEventId(type: EventType, naturalKey: string): string {
  return `${type}:${naturalKey}`;
}

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

/**
 * Turn a raw gateway dispatch into an internal event, or null when the dispatch
 * has no internal meaning.
 *
 * This is the single place that knows Discord's payload shapes (PLAN.md P1), so
 * a Discord change touches this adapter and nothing downstream.
 */
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
      // joined_at disambiguates a member who leaves and rejoins.
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

    case 'INTERACTION_CREATE': {
      const interactionId = str(d.id);
      // Type 2 is APPLICATION_COMMAND. Components and modals get their own
      // event types when a phase needs them.
      if (!interactionId || d.type !== 2) return null;
      return {
        id: deriveEventId('interaction.command', interactionId),
        type: 'interaction.command',
        guildId: str(d.guild_id),
        occurredAt: now,
        payload: d,
      };
    }

    default:
      // READY, resumes, heartbeat acks and every dispatch we have no internal
      // meaning for. Silently ignored — not an error.
      return null;
  }
}
