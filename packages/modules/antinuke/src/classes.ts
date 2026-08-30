import { type AuditLogEventType, type EventType, tryParseDuration } from '@proton/core';
import type { AntinukeConfig } from './config.ts';

export const NUKE_CLASSES = [
  'channelDelete',
  'roleDelete',
  'webhookDelete',
  'emojiDelete',
  'memberRemove',
] as const;

export type NukeClass = (typeof NUKE_CLASSES)[number];

export const CLASS_OF_EVENT = {
  'channel.deleted': 'channelDelete',
  'role.deleted': 'roleDelete',
  'webhook.deleted': 'webhookDelete',
  'emoji.deleted': 'emojiDelete',
  'member.banned': 'memberRemove',
  'member.kicked': 'memberRemove',
} as const satisfies Partial<Record<AuditLogEventType, NukeClass>>;

export type WatchedEventType = keyof typeof CLASS_OF_EVENT;

export const WATCHED_EVENT_TYPES: EventType[] = Object.keys(CLASS_OF_EVENT) as WatchedEventType[];

export function classOfEvent(type: string): NukeClass | null {
  return CLASS_OF_EVENT[type as WatchedEventType] ?? null;
}

export const CLASS_LABELS: Record<NukeClass, string> = {
  channelDelete: 'channel deletions',
  roleDelete: 'role deletions',
  webhookDelete: 'webhook deletions',
  emojiDelete: 'emoji deletions',
  memberRemove: 'bans or kicks',
};

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

  window: string;
}

export function thresholdFor(
  config: AntinukeConfig,
  nukeClass: NukeClass,
): Threshold | { error: string } {
  const fields = THRESHOLD_FIELDS[nukeClass];
  const limit = config[fields.limit];
  const window = config[fields.window];

  if (typeof limit !== 'number' || typeof window !== 'string') {
    return {
      error:
        'its limit is not a whole number, or its window is not a duration. Fix them on the ' +
        'Anti-nuke page of the Proton dashboard.',
    };
  }

  const windowMs = tryParseDuration(window);
  if (windowMs === null) {
    return {
      error: `'${window}' is not a duration I can read. Fix it on the Anti-nuke page of the Proton dashboard.`,
    };
  }

  return { limit, windowMs, window };
}
