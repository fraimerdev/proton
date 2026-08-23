import type { ChannelState } from './types.ts';

export const CHANNEL_TYPES = {
  guildText: 0,
  dm: 1,
  guildVoice: 2,
  groupDm: 3,
  guildCategory: 4,
  guildAnnouncement: 5,
  announcementThread: 10,
  publicThread: 11,
  privateThread: 12,
  guildStageVoice: 13,
  guildDirectory: 14,
  guildForum: 15,
  guildMedia: 16,
} as const;

export type ChannelType = (typeof CHANNEL_TYPES)[keyof typeof CHANNEL_TYPES];

const IS_THREAD: Record<ChannelType, boolean> = {
  [CHANNEL_TYPES.guildText]: false,
  [CHANNEL_TYPES.dm]: false,
  [CHANNEL_TYPES.guildVoice]: false,
  [CHANNEL_TYPES.groupDm]: false,
  [CHANNEL_TYPES.guildCategory]: false,
  [CHANNEL_TYPES.guildAnnouncement]: false,
  [CHANNEL_TYPES.announcementThread]: true,
  [CHANNEL_TYPES.publicThread]: true,
  [CHANNEL_TYPES.privateThread]: true,
  [CHANNEL_TYPES.guildStageVoice]: false,
  [CHANNEL_TYPES.guildDirectory]: false,
  [CHANNEL_TYPES.guildForum]: false,
  [CHANNEL_TYPES.guildMedia]: false,
};

const THREAD_TYPES: ReadonlySet<number> = new Set(
  Object.entries(IS_THREAD)
    .filter(([, thread]) => thread)
    .map(([type]) => Number(type)),
);

export function isThreadType(type: number): boolean {
  return THREAD_TYPES.has(type);
}

export function isThreadChannel(channel: ChannelState | null | undefined): boolean {
  return channel?.type !== undefined && isThreadType(channel.type);
}
