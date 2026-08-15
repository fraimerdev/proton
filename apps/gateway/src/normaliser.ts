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

/**
 * Discord audit-log action types → internal events.
 *
 * The numbers come from `discord-api-types`' `AuditLogEvent` enum rather than
 * from literals, and the test suite pins each one against the value published at
 * docs.discord.com/developers/resources/audit-log. Both halves matter: a number
 * that is wrong by one produces no error anywhere, it simply means the entry
 * falls through to `default` and anti-nuke never fires. That is the one failure
 * in this file that nothing downstream can detect.
 *
 * Only destructive actions and their creates are here. Every other action type —
 * including WEBHOOK_CREATE and EMOJI_CREATE — is deliberately unmapped: nothing
 * in Phase 2 counts them, and an event with no consumer is a stream to pay for.
 *
 * MEMBER_BAN_ADD/REMOVE are mapped here rather than from GUILD_BAN_ADD and
 * GUILD_BAN_REMOVE, which stay unmapped on purpose. Those dispatches carry the
 * banned user but not who banned them, so mapping both would emit the same fact
 * twice under two ids, one of them missing the actor the mass-ban breaker needs.
 */
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

/**
 * Every event type `normalise` can actually produce.
 *
 * This exists to be asserted against. `EventType` is the vocabulary Proton is
 * *allowed* to speak; this is the subset anything currently says out loud, and
 * the gap between them is invisible to the compiler — a module subscribing to a
 * declared-but-unemitted type typechecks, registers, reports itself healthy and
 * receives nothing, forever. That is not hypothetical: before this constant
 * existed, `logging` was subscribed to three types the normaliser never emitted
 * and `phishing` to one, so the module framework's entire message-edit path was
 * dead with no failing test anywhere.
 *
 * `packages/modules/registry` asserts every manifest's listener types against
 * this, which turns that whole failure class into a unit-test failure naming the
 * module and the type. Keep it beside the switch: an arm added without a line
 * here fails its own test in this file.
 *
 * Two declared types are deliberately absent, and both are internal:
 * `moderation.warned` and `xp.level_gained` are published by modules through the
 * `emits` allowlist rather than by Discord, so the registry's assertion unions
 * this set with `registry.emittedTypes()`.
 */
export const NORMALISED_EVENT_TYPES: readonly EventType[] = [
  'guild.available',
  'guild.unavailable',
  'member.joined',
  'member.left',

  // From GUILD_AUDIT_LOG_ENTRY_CREATE, via AUDIT_LOG_ACTIONS above.
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

    /**
     * The audit log — the only dispatch that names who did something.
     *
     * Delivered only to bots holding VIEW_AUDIT_LOG, and only under the
     * GUILD_MODERATION intent. When either is missing Discord sends nothing at
     * all, so silence here is indistinguishable from a quiet guild; the registry
     * is what turns that into an admin-readable reason (§7).
     */
    case 'GUILD_AUDIT_LOG_ENTRY_CREATE': {
      // -1 is not a key, so a missing or non-numeric action_type takes the same
      // path as an unmapped one. Discord ships ~50 action types and keeps adding
      // more; the ones nothing consumes are ignored like any other dispatch.
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
        // The entry id is a snowflake, so it dates itself. Using it rather than
        // the clock keeps `occurredAt` identical on a RESUME redelivery, and
        // audit-log delivery lags reality by enough that `now` would compress a
        // burst that was actually spread out — or stretch one that was not.
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

    /**
     * An edit, watched because editing a scam link into an innocuous message is
     * the oldest way past a filter that only reads MESSAGE_CREATE.
     *
     * The natural key carries `edited_timestamp` for two reasons. It must differ
     * from the create event's id, or the first edit would dedupe against the
     * original post and never be handled at all (I4); and successive edits must
     * differ from each other, or only the first would ever be checked. Discord
     * also raises MESSAGE_UPDATE for its own embed resolution, which carries a
     * null `edited_timestamp` — those collapse onto one id, which is right,
     * because they are not edits by anyone.
     */
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

    /**
     * A deletion. The dispatch carries no timestamp of its own — only the ids —
     * so `occurredAt` is the clock. That is unavoidable rather than sloppy: the
     * message snowflake dates the *message*, not its removal, and a log that
     * timestamped a deletion by when the message was written would be wrong by
     * however long it survived.
     */
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

    /**
     * A bulk deletion — a purge, or another bot's.
     *
     * The natural key covers the whole id *set*, sorted first so it does not
     * depend on the order Discord happened to list them in: a RESUME can
     * redeliver the same purge with the array shuffled, and a key built from the
     * raw array would read as a second, distinct purge.
     *
     * Sorted ids are hashed rather than concatenated because Discord allows up
     * to 100 per bulk delete, and a key holding all of them would be ~2KB
     * repeated into every derived `cases.idempotency_key`. A `{first, last,
     * count}` digest would be shorter still and is what this used to do, but two
     * different purges in one channel can share those three values — and a
     * collision here means the second purge is silently treated as a redelivery
     * of the first and never logged.
     */
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

    /**
     * A member's roles, nickname or timeout changed.
     *
     * Watched because `GUILD_MEMBER_REMOVE` carries **no roles** — it is the user
     * and the guild id and nothing else. So a member's roles are only knowable
     * while they are still present, which makes sticky roles (§8 Phase 3) a
     * matter of keeping a running snapshot rather than reading one at the moment
     * of departure. By then the member is gone and `GET member` answers 404.
     *
     * The natural key is a digest of the *resulting state*, not a counter. An
     * update that reports the same roles, nick and timeout as the last one says
     * nothing new, so it collapses onto the same id and dedupes — which is right,
     * because Discord raises this dispatch for changes Proton does not model
     * (avatar, banner, boost status) and a snapshot writer would otherwise rewrite
     * an identical row on every avatar change in the guild.
     */
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

    /**
     * A reaction was added or removed.
     *
     * **These dispatches have no id of their own**, and there is nothing stable to
     * derive one from beyond who reacted with what, where. The consequence is
     * real and deliberate: a genuine react → unreact → react inside the executor's
     * dedupe TTL produces the same id as a RESUME redelivery, and the second add
     * is discarded.
     *
     * Both consumers are built so that this is the correct outcome rather than a
     * tolerated one. A role toggle is idempotent — granting a role someone
     * already holds is a no-op — and starboard never counts the events at all: it
     * re-reads the message and counts the reactions on it, so an event is a
     * trigger and never a datum. Do not "fix" this by folding `raw.s` into the
     * key. The sequence number changes on every redelivery, which would defeat I4
     * for the one event type that fires in bursts.
     */
    case 'MESSAGE_REACTION_ADD':
    case 'MESSAGE_REACTION_REMOVE': {
      const channelId = str(d.channel_id);
      const messageId = str(d.message_id);
      const userId = str(d.user_id);
      if (!channelId || !messageId || !userId) return null;

      // A custom emoji has an id and a name; a unicode one has only a name.
      // Preferring the id keeps two custom emoji with the same name distinct.
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

    /**
     * Someone joined, left or moved a voice channel — the input to voice XP.
     *
     * `channel_id: null` means they disconnected from voice in this guild
     * entirely, which is why the key spells that case rather than letting the
     * template produce the string "null" by accident.
     *
     * Like the reaction dispatches, a repeat collapses onto the same id. The voice
     * session tracker is written to be idempotent for exactly that reason: it
     * stores "in channel X since T" rather than accumulating, so re-applying a
     * transition changes nothing.
     */
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

      // 2 is APPLICATION_COMMAND, 3 is MESSAGE_COMPONENT. Autocomplete (4) and
      // modal submit (5) get their own types when a phase needs them.
      const type: EventType | null =
        d.type === 2 ? 'interaction.command' : d.type === 3 ? 'interaction.component' : null;
      if (!type) return null;

      return {
        // The interaction id is a snowflake and unique per interaction, so this
        // is the one interaction key that needs nothing added to it.
        id: deriveEventId(type, interactionId),
        type,
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
