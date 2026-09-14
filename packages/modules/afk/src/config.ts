import {
  durationStringSchema,
  parseDuration,
  protonFields,
  snowflakeSchema,
  tryParseDuration,
} from '@proton/core';
import { z } from 'zod';

export const MODULE_ID = 'afk';

export const AFK_SCHEMA_VERSION = 1;

export const REASON_MAX = 100;

export const RECAP_MAX = 25;

export const NOTICE_COOLDOWN_MS = 60_000;

export const AFK_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export const AFK_TOMBSTONE_MS = 24 * 60 * 60 * 1000;

export const TIDY_MIN = '10s';
export const TIDY_MAX = '5m';
export const TIDY_DEFAULT = '15s';

export const IGNORED_CHANNELS_MAX = 50;

export const AFK_EXPIRE_JOB = 'expire';
export const AFK_TIDY_JOB = 'tidy';

const TIDY_MIN_MS = parseDuration(TIDY_MIN);
const TIDY_MAX_MS = parseDuration(TIDY_MAX);
const TIDY_DEFAULT_MS = parseDuration(TIDY_DEFAULT);

export const QUIET_CHANNEL_TYPES = [0, 2, 5, 10, 11, 12, 13, 15, 16];

export const afkConfigSchema = z
  .object({
    enabled: z.boolean().default(false).register(protonFields, {
      label: 'Enabled',
      description: 'Let members mark themselves away with /afk in this server.',
    }),

    nicknameTag: z
      .boolean()
      .default(true)
      .register(protonFields, {
        label: 'Add [AFK] tag',
        description:
          'Put [AFK] in front of an away member’s nickname. Proton needs Manage Nicknames, and ' +
          'Discord never lets bots rename the server owner or anyone ranked at or above Proton.',
      }),

    tidyReplies: z.boolean().default(true).register(protonFields, {
      label: 'Tidy up replies',
      description: 'Delete Proton’s AFK notices and welcome-back notes after a short delay.',
    }),

    tidyAfter: durationStringSchema
      .clone()
      .default(TIDY_DEFAULT)
      .register(protonFields, {
        field: 'duration',
        label: 'Delete after',
        description:
          `How long a reply stays, from ${TIDY_MIN} to ${TIDY_MAX}. Proton needs Manage ` +
          'Messages in the channel, otherwise the reply stays.',
      }),

    recap: z.boolean().default(true).register(protonFields, {
      label: 'Recap by DM',
      description: 'DM members the pings they missed, when they come back by themselves.',
    }),

    ignoredChannelIds: z
      .array(snowflakeSchema.clone())
      .max(IGNORED_CHANNELS_MAX)
      .default([])
      .register(protonFields, {
        field: 'channel-id',
        label: 'Channels without AFK replies',
        description:
          'Proton stays quiet in these channels, and in the threads and posts inside them. Pings ' +
          'there still count for the recap.',
        channelTypes: QUIET_CHANNEL_TYPES,
      }),
  })
  .superRefine((config, ctx) => {
    const ms = tryParseDuration(config.tidyAfter);
    if (ms === null || (ms >= TIDY_MIN_MS && ms <= TIDY_MAX_MS)) return;

    ctx.addIssue({
      code: 'custom',
      path: ['tidyAfter'],
      message: `must be between ${TIDY_MIN} and ${TIDY_MAX}`,
    });
  });

export type AfkConfig = z.infer<typeof afkConfigSchema>;

export const afkDefaultConfig: AfkConfig = {
  enabled: false,
  nicknameTag: true,
  tidyReplies: true,
  tidyAfter: TIDY_DEFAULT,
  recap: true,
  ignoredChannelIds: [],
};

export function tidyDelayMs(config: Pick<AfkConfig, 'tidyAfter'>): number {
  const ms = tryParseDuration(config.tidyAfter) ?? TIDY_DEFAULT_MS;
  return Math.min(Math.max(ms, TIDY_MIN_MS), TIDY_MAX_MS);
}
