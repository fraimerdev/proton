export const EVENT_TYPES = [
  'guild.available',
  'guild.unavailable',

  'member.joined',
  'member.left',
  'member.updated',

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

  'reaction.added',
  'reaction.removed',

  'voice.state_updated',

  'interaction.command',

  'interaction.component',

  'moderation.warned',

  'xp.level_gained',
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

const EVENT_TYPE_SET: ReadonlySet<string> = new Set(EVENT_TYPES);

export function isEventType(value: string): value is EventType {
  return EVENT_TYPE_SET.has(value);
}

export interface ProtonEvent<T = unknown> {
  id: string;
  type: EventType;
  guildId: string | null;
  occurredAt: number;
  payload: T;
}
