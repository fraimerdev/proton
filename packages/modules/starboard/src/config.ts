import { protonFields, snowflakeSchema } from '@proton/core';
import { z } from 'zod';

export const DEFAULT_STAR_EMOJI = '⭐';

const SOURCE_CHANNEL_MAX = 50;

export const starboardConfigSchema = z.object({
  enabled: z.boolean().default(false).register(protonFields, {
    label: 'Enabled',
  }),

  boardChannelId: snowflakeSchema.optional().register(protonFields, {
    field: 'channel-id',
    label: 'Board channel',
    channelTypes: [0, 5, 11, 12],
  }),

  emoji: z.string().min(1).max(64).default(DEFAULT_STAR_EMOJI).register(protonFields, {
    label: 'Star emoji',
    description: 'Unicode emoji, or a custom one pasted straight from chat',
  }),

  threshold: z.number().int().min(1).max(100).default(3).register(protonFields, {
    label: 'Stars needed',
  }),

  sourceChannelIds: z
    .array(snowflakeSchema)
    .max(SOURCE_CHANNEL_MAX)
    .default([])
    .register(protonFields, {
      field: 'channel-id',
      label: 'Source channels',
      description: 'Empty watches every channel Proton can see',
      channelTypes: [0, 5, 11, 12],
    }),

  ignoreBots: z.boolean().default(true).register(protonFields, {
    label: 'Ignore bot messages',
  }),

  selfStarAllowed: z.boolean().default(false).register(protonFields, {
    label: 'Count self-stars',
  }),

  ignoreNsfw: z.boolean().default(true).register(protonFields, {
    label: 'Ignore age-restricted channels',
  }),
});

export type StarboardConfig = z.infer<typeof starboardConfigSchema>;

export const starboardDefaultConfig: StarboardConfig = {
  enabled: false,
  emoji: DEFAULT_STAR_EMOJI,
  threshold: 3,
  sourceChannelIds: [],
  ignoreBots: true,
  selfStarAllowed: false,
  ignoreNsfw: true,
};

export const STARBOARD_SCHEMA_VERSION = 1;
