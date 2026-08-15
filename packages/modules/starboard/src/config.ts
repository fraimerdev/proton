import { protonFields, snowflakeSchema } from '@proton/core';
import { z } from 'zod';

export const DEFAULT_STAR_EMOJI = '⭐';

const SOURCE_CHANNEL_MAX = 50;

export const starboardConfigSchema = z.object({
  enabled: z
    .boolean()
    .default(false)
    .register(protonFields, {
      label: 'Enabled',
      description:
        'Repost messages to a board channel once enough members react with the star emoji. ' +
        'Pick a board channel before turning this on.',
    }),

  boardChannelId: snowflakeSchema.optional().register(protonFields, {
    field: 'channel-id',
    label: 'Board channel',
    description:
      'Where starred messages are reposted. Reactions inside this channel are ignored, so ' +
      'the board can never star its own posts.',

    channelTypes: [0, 5, 11, 12],
  }),

  emoji: z
    .string()
    .min(1)
    .max(64)
    .default(DEFAULT_STAR_EMOJI)
    .register(protonFields, {
      label: 'Star emoji',
      description:
        'The reaction members use to nominate a message. A normal emoji, or a custom one ' +
        'from this server pasted straight from chat.',
    }),

  threshold: z
    .number()
    .int()
    .min(1)
    .max(100)
    .default(3)
    .register(protonFields, {
      label: 'Stars needed',
      description:
        'How many stars a message needs before it is posted to the board. A message that ' +
        'falls back below this number has its board post removed again.',
    }),

  sourceChannelIds: z
    .array(snowflakeSchema)
    .max(SOURCE_CHANNEL_MAX)
    .default([])
    .register(protonFields, {
      field: 'channel-id',
      label: 'Source channels',
      description:
        'Only messages in these channels can reach the board. Leave it empty to watch every ' +
        'channel the bot can see.',
      channelTypes: [0, 5, 11, 12],
    }),

  ignoreBots: z
    .boolean()
    .default(true)
    .register(protonFields, {
      label: 'Ignore bot messages',
      description:
        'Messages posted by bots and webhooks are never starred, however many stars they ' +
        'collect. On by default — a board full of the bot’s own embeds is the usual first ' +
        'complaint about a starboard.',
    }),

  selfStarAllowed: z
    .boolean()
    .default(false)
    .register(protonFields, {
      label: 'Count self-stars',
      description:
        'Whether a member starring their own message counts toward the threshold. Off means ' +
        'the author can still react — their star just does not count.',
    }),

  ignoreNsfw: z
    .boolean()
    .default(true)
    .register(protonFields, {
      label: 'Ignore age-restricted channels',
      description:
        'Messages in age-restricted channels are never reposted. The board channel is ' +
        'usually not age-restricted, so reposting would put that content in front of ' +
        'members who never opted in.',
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
