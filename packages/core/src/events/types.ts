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

  'moderation.warned',

  'xp.level_gained',

  'proton.config_changed',
  'proton.action_executed',
  'proton.security_tripped',
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

// Published by services rather than by the gateway or a module, so they appear in neither
// NORMALISED_EVENT_TYPES nor any manifest's `emits`. The registry's "somebody emits this" check
// reads this list; without it a serverlog listener for them looks like a typo.
export const SERVICE_EMITTED_EVENT_TYPES = [
  'proton.config_changed',
  'proton.action_executed',
] as const satisfies readonly EventType[];

export type ServiceEmittedEventType = (typeof SERVICE_EMITTED_EVENT_TYPES)[number];

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
