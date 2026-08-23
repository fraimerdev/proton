import { POLL_MAX_DURATION_HOURS, protonFields, snowflakeSchema } from '@proton/core';
import { z } from 'zod';

export const MODULE_ID = 'polls';

export const POLL_MIN_DURATION_HOURS = 1;
export const POLL_DEFAULT_DURATION_HOURS = 24;

export const pollsConfigSchema = z.object({
  enabled: z.boolean().default(false).register(protonFields, {
    label: 'Enabled',
    description: 'Who may run /poll is set in the Permissions module',
  }),

  announceResults: z.boolean().default(true).register(protonFields, {
    label: 'Announce when a poll closes',
  }),

  announceChannelId: snowflakeSchema.optional().register(protonFields, {
    field: 'channel-id',
    label: 'Announce in',
    description: 'Empty announces in the channel the poll was started in',

    channelTypes: [0, 5, 11, 12],
  }),

  defaultDurationHours: z
    .number()
    .int()
    .min(POLL_MIN_DURATION_HOURS)
    .max(POLL_MAX_DURATION_HOURS)
    .default(POLL_DEFAULT_DURATION_HOURS)
    .register(protonFields, {
      label: 'Default length in hours',
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
