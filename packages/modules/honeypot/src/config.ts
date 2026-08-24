import { durationStringSchema, limitFor, protonFields, snowflakeSchema } from '@proton/core';
import { z } from 'zod';

export const MODULE_ID = 'honeypot';

export const HONEYPOT_ACTOR = 'proton:honeypot';

export const HONEYPOT_ACTIONS = ['softban', 'ban', 'kick', 'timeout', 'warn', 'none'] as const;
export type HoneypotAction = (typeof HONEYPOT_ACTIONS)[number];

export const DELETE_SECONDS_MAX = 604_800;

export const SECONDS_PER_DAY = 86_400;

// The PRO ceiling, not this guild's. The per-guild cap is enforced at save time from configLimits;
// this only stops a hand-edited config from being unbounded.
export const CHANNELS_CEILING = limitFor('pro', 'honeypotChannels');

export const honeypotChannelSchema = z.object({
  channelId: snowflakeSchema,

  // Per channel, so a trap can be taken out of service without losing how it was set up.
  enabled: z.boolean().default(true),

  action: z.enum(HONEYPOT_ACTIONS).default('softban'),

  deleteMessageSeconds: z.number().int().min(0).max(DELETE_SECONDS_MAX).default(DELETE_SECONDS_MAX),

  timeoutDuration: durationStringSchema.default('1h'),
});

export type HoneypotChannel = z.infer<typeof honeypotChannelSchema>;

export const honeypotChannelsSchema = z
  .array(honeypotChannelSchema)
  .max(CHANNELS_CEILING)
  .default([])
  .superRefine((channels, ctx) => {
    const seen = new Set<string>();

    for (const [index, channel] of channels.entries()) {
      if (seen.has(channel.channelId)) {
        ctx.addIssue({
          code: 'custom',
          path: [index, 'channelId'],
          message:
            'This channel is already a honeypot. Edit the row above instead of adding it twice.',
        });
      }
      seen.add(channel.channelId);
    }
  });

const settings = {
  enabled: z.boolean().default(false).register(protonFields, { label: 'Enabled' }),

  logChannelId: snowflakeSchema.optional().register(protonFields, {
    field: 'channel-id',
    label: 'Incident log',
    description: 'Where Proton reports every trap it springs',

    channelTypes: [0, 5, 11, 12],
  }),

  includeThreads: z.boolean().default(true).register(protonFields, {
    label: 'Threads count too',
    description: 'A thread under a honeypot channel is part of the trap',
  }),
};

export const honeypotConfigSchema = z.object({
  ...settings,
  channels: honeypotChannelsSchema,
});

// The form generator refuses arrays of objects by design (PLAN.md §9), so the channel list gets a
// bespoke dashboard editor and is omitted here rather than crashing the settings page.
export const honeypotFormSchema = z.object(settings);

export type HoneypotConfig = z.infer<typeof honeypotConfigSchema>;

export const honeypotDefaultConfig: HoneypotConfig = {
  enabled: false,
  includeThreads: true,
  channels: [],
};

export const HONEYPOT_SCHEMA_VERSION = 1;

export function channelFor(
  config: HoneypotConfig,
  channelId: string,
  parentId?: string | null,
): HoneypotChannel | undefined {
  const match = config.channels.find(
    (channel) =>
      channel.channelId === channelId ||
      (config.includeThreads && parentId != null && channel.channelId === parentId),
  );

  return match?.enabled === true ? match : undefined;
}

export function describeWindow(seconds: number): string {
  if (seconds === 0) return 'no messages';
  if (seconds % SECONDS_PER_DAY === 0) {
    const days = seconds / SECONDS_PER_DAY;
    return days === 1 ? 'the last day' : `the last ${days} days`;
  }

  const hours = Math.round(seconds / 3600);
  return hours === 1 ? 'the last hour' : `the last ${hours} hours`;
}
