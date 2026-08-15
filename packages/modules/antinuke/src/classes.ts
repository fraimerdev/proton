import { type AuditLogEventType, type EventType, tryParseDuration } from '@proton/core';
import type { AntinukeConfig } from './config.ts';

/**
 * The classes of destructive act the breaker counts separately (PLAN.md §8:
 * "per-actor sliding windows on channel/role/webhook/emoji delete + mass
 * ban/kick").
 *
 * Separate windows because the acts are not interchangeable: three channel
 * deletions in half a minute is an emergency, three emoji deletions is a Tuesday.
 * One shared counter would have to be tuned for the loosest of them and would
 * then miss the tightest.
 *
 * Bans and kicks share `memberRemove` for the opposite reason — they are
 * interchangeable. An attacker facing one limit on bans and another on kicks
 * simply alternates and stays under both, while the server empties at the sum of
 * the two rates.
 */
export const NUKE_CLASSES = [
  'channelDelete',
  'roleDelete',
  'webhookDelete',
  'emojiDelete',
  'memberRemove',
] as const;

export type NukeClass = (typeof NUKE_CLASSES)[number];

/**
 * Which audit-derived event belongs to which class.
 *
 * Keyed by our own event vocabulary rather than by Discord's numeric
 * `action_type`: the normaliser already made that translation once (P1), and a
 * second copy of the numbers here would be a second thing to get wrong when
 * Discord adds an action.
 *
 * `channel.created` and `role.created` are mapped by the normaliser but are
 * deliberately absent. Creation is not destruction — a burst of new channels is
 * spam, which is the automod's problem, and counting it here would trip the
 * breaker on a template bot building out a server.
 */
export const CLASS_OF_EVENT = {
  'channel.deleted': 'channelDelete',
  'role.deleted': 'roleDelete',
  'webhook.deleted': 'webhookDelete',
  'emoji.deleted': 'emojiDelete',
  'member.banned': 'memberRemove',
  'member.kicked': 'memberRemove',
} as const satisfies Partial<Record<AuditLogEventType, NukeClass>>;

export type WatchedEventType = keyof typeof CLASS_OF_EVENT;

/**
 * What the manifest declares as its listener's `types`.
 *
 * Derived from the map rather than written out again, so a class that gains an
 * event type is subscribed to automatically and the two cannot drift into a
 * module that counts an event it never receives.
 */
export const WATCHED_EVENT_TYPES: EventType[] = Object.keys(CLASS_OF_EVENT) as WatchedEventType[];

export function classOfEvent(type: string): NukeClass | null {
  return CLASS_OF_EVENT[type as WatchedEventType] ?? null;
}

/** How the class reads in a sentence an admin has to act on. */
export const CLASS_LABELS: Record<NukeClass, string> = {
  channelDelete: 'channel deletions',
  roleDelete: 'role deletions',
  webhookDelete: 'webhook deletions',
  emojiDelete: 'emoji deletions',
  memberRemove: 'bans or kicks',
};

/** The two config keys that hold each class's threshold. */
const THRESHOLD_FIELDS: Record<
  NukeClass,
  { limit: keyof AntinukeConfig; window: keyof AntinukeConfig }
> = {
  channelDelete: { limit: 'channelDeleteLimit', window: 'channelDeleteWindow' },
  roleDelete: { limit: 'roleDeleteLimit', window: 'roleDeleteWindow' },
  webhookDelete: { limit: 'webhookDeleteLimit', window: 'webhookDeleteWindow' },
  emojiDelete: { limit: 'emojiDeleteLimit', window: 'emojiDeleteWindow' },
  memberRemove: { limit: 'memberRemoveLimit', window: 'memberRemoveWindow' },
};

export interface Threshold {
  limit: number;
  windowMs: number;
  /** The duration as the admin wrote it, for the sentence the alert carries. */
  window: string;
}

/**
 * Read a class's threshold out of validated config.
 *
 * Returns a reason rather than throwing on an unreadable duration: the config
 * schema already refuses one on write (I5), so reaching here means a row written
 * by an older build, and a security module must say what it could not evaluate
 * instead of dying inside an event handler.
 */
export function thresholdFor(
  config: AntinukeConfig,
  nukeClass: NukeClass,
): Threshold | { error: string } {
  const fields = THRESHOLD_FIELDS[nukeClass];
  const limit = config[fields.limit];
  const window = config[fields.window];

  if (typeof limit !== 'number' || typeof window !== 'string') {
    return {
      error: `the ${nukeClass} threshold in this server's anti-nuke config is not a number and a duration.`,
    };
  }

  const windowMs = tryParseDuration(window);
  if (windowMs === null) {
    return {
      error: `'${window}' is not a duration I can read, so ${nukeClass} is not being watched in this server. Fix it in the Proton dashboard.`,
    };
  }

  return { limit, windowMs, window };
}
