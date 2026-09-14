import { POLL_MAX_DURATION_HOURS, protonFields, snowflakeSchema } from '@proton/core';
import { z } from 'zod';

export const MODULE_ID = 'polls';

export const POLL_MIN_DURATION_HOURS = 1;
export const POLL_DEFAULT_DURATION_HOURS = 24;

export const pollsConfigSchema = z.object({
  enabled: z.boolean().default(false).register(protonFields, {
    label: 'Enabled',
    description: 'Set who can use /poll in Permissions.',
  }),

  announceResults: z.boolean().default(true).register(protonFields, {
    label: 'Announce results',
  }),

  announceChannelId: snowflakeSchema.optional().register(protonFields, {
    field: 'channel-id',
    label: 'Announcement channel',
    description: 'Where Proton announces closed polls.',

    channelTypes: [0, 5, 11, 12],
  }),

  defaultDurationHours: z
    .number()
    .int()
    .min(POLL_MIN_DURATION_HOURS)
    .max(POLL_MAX_DURATION_HOURS)
    .default(POLL_DEFAULT_DURATION_HOURS)
    .register(protonFields, {
      label: 'Default duration',
    }),
});

export type PollsConfig = z.infer<typeof pollsConfigSchema>;

export const pollsDefaultConfig: PollsConfig = {
  enabled: false,
  announceResults: true,
  defaultDurationHours: POLL_DEFAULT_DURATION_HOURS,
};

export const POLLS_SCHEMA_VERSION = 1;

export function pollLink(guildId: string, channelId: string, messageId: string): string {
  return `https://discord.com/channels/${guildId}/${channelId}/${messageId}`;
}

export function unixSeconds(at: Date): number {
  return Math.floor(at.getTime() / 1000);
}
