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
  'member.banned',
  'member.unbanned',

  'message.created',
  'message.updated',
  'message.deleted',
  'message.bulk_deleted',

  'interaction.command',

  /**
   * Internal, not from Discord. Emitted when a warn case is recorded, so the
   * warn-escalation ladder is an ordinary rule (§4-P2) rather than logic
   * hardcoded inside the cases module.
   */
  'moderation.warned',
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
