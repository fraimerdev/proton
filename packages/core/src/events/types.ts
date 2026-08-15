/**
 * Internal event vocabulary (PLAN.md P1).
 *
 * These are Proton's own names, not Discord's. The gateway normaliser is the
 * only place that knows about raw dispatch shapes, so a Discord payload change
 * touches one adapter rather than every consumer.
 */
export const EVENT_TYPES = [
  'guild.available',
  'guild.unavailable',

  'member.joined',
  'member.left',
  'member.updated',

  /**
   * Attributed moderation and guild-structure changes, every one of them sourced
   * from GUILD_AUDIT_LOG_ENTRY_CREATE (§8 Phase 2).
   *
   * The audit log is the only place Discord names an actor. CHANNEL_DELETE says
   * a channel vanished; the audit entry says who deleted it — and anti-nuke is
   * defined entirely in terms of "one actor, N destructive acts, T seconds", so
   * an unattributed event would be worthless to it.
   *
   * `member.left` is deliberately not one of these: GUILD_MEMBER_REMOVE fires for
   * a voluntary leave and a kick alike, so a kick is only knowable from the audit
   * entry, and the two events answer different questions.
   */
  'member.banned',
  'member.unbanned',
  'member.kicked',

  'channel.created',
  'channel.deleted',
  'role.created',
  'role.deleted',
  'webhook.deleted',
  'emoji.deleted',

  'message.created',
  'message.updated',
  'message.deleted',
  'message.bulk_deleted',

  /**
   * A reaction was added or removed (§8 Phase 3: reaction roles, starboard).
   *
   * Under the GUILD_MESSAGE_REACTIONS intent, which is not privileged. Note that
   * neither dispatch carries the message itself — only its id — so a consumer
   * that needs the message body or its reaction counts has to read it back.
   * Starboard does exactly that, deliberately; see `deriveEventId`'s note on why
   * a reaction has no id of its own to dedupe against.
   */
  'reaction.added',
  'reaction.removed',

  /**
   * Someone joined, left or moved a voice channel — the input to voice XP.
   *
   * Under GUILD_VOICE_STATES, also not privileged. A `channel_id` of null means
   * they disconnected from voice in that guild entirely.
   */
  'voice.state_updated',

  'interaction.command',
  /** A button press or select-menu choice (INTERACTION_CREATE type 3). */
  'interaction.component',

  /**
   * Internal, not from Discord. Emitted when a warn case is recorded, so the
   * warn-escalation ladder is an ordinary rule (§4-P2) rather than logic
   * hardcoded inside the cases module.
   */
  'moderation.warned',

  /**
   * Internal. A member crossed into a new level (§4-P1 names this event).
   *
   * Published by `leveling` through the manifest's `emits` allowlist, so other
   * modules and the future rule builder can react to a level-up without
   * importing the module that computes it (I3).
   */
  'xp.level_gained',
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

const EVENT_TYPE_SET: ReadonlySet<string> = new Set(EVENT_TYPES);

export function isEventType(value: string): value is EventType {
  return EVENT_TYPE_SET.has(value);
}

/** Verbatim from PLAN.md §4-P1 — deliberately not extended. */
export interface ProtonEvent<T = unknown> {
  /** ulid — also the dedupe key (I4). */
  id: string;
  type: EventType;
  guildId: string | null;
  occurredAt: number;
  payload: T;
}
