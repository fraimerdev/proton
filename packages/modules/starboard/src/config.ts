import { protonFields, snowflakeSchema } from '@proton/core';
import { z } from 'zod';

/**
 * The default star. A plain unicode emoji rather than a custom one, because a
 * custom emoji id is per-guild and a default naming one would resolve to nothing
 * in every server but the one it came from.
 */
export const DEFAULT_STAR_EMOJI = '⭐';

/** Room for a per-channel starboard without letting one config row become a channel list. */
const SOURCE_CHANNEL_MAX = 50;

export const starboardConfigSchema = z.object({
  /**
   * Off until an admin picks a board channel.
   *
   * Every other module in this repo that posts something a whole server sees
   * defaults off for the same reason: a starboard switched on by an upgrade
   * would start reposting old conversations into whichever channel happened to
   * be configured, and there is no undo for that.
   */
  enabled: z
    .boolean()
    .default(false)
    .register(protonFields, {
      label: 'Enabled',
      description:
        'Repost messages to a board channel once enough members react with the star emoji. ' +
        'Pick a board channel before turning this on.',
    }),

  /**
   * Where board posts go.
   *
   * Optional in the schema and required in practice: the listener refuses to act
   * without it and says so by name, rather than silently doing nothing. It
   * cannot be a required field because `defaultConfig` has to satisfy the schema
   * and there is no channel id that is right for every guild.
   */
  boardChannelId: snowflakeSchema.optional().register(protonFields, {
    field: 'channel-id',
    label: 'Board channel',
    description:
      'Where starred messages are reposted. Reactions inside this channel are ignored, so ' +
      'the board can never star its own posts.',
    // Text and announcement channels, and their public/private threads.
    channelTypes: [0, 5, 11, 12],
  }),

  /**
   * The reaction that counts.
   *
   * A unicode character, or a custom emoji as `name:id`. `<:name:id>` — what
   * Discord's own client copies into the message box — is accepted too and
   * normalised on read, because an admin pasting the emoji from chat is the
   * likeliest way this field is ever filled in.
   */
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

  /**
   * Which channels can produce board posts. Empty means every channel.
   *
   * A flat array of ids rather than an include/exclude object, because the v1
   * form generator renders flat arrays of scalars and refuses arrays of objects
   * (§9) — and because "these channels" is the question an admin actually asks.
   */
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

  /**
   * Whether the author's own star counts toward the threshold.
   *
   * False by default: a member who can star themselves onto the board with the
   * last needed star turns the threshold into "threshold minus one, for me".
   * Enforcing it costs a second read — see `SourceMessageRequest.withReactors`,
   * which explains why Discord's message object cannot answer this on its own.
   */
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

/** Bumped whenever the shape above changes (I5). */
export const STARBOARD_SCHEMA_VERSION = 1;
