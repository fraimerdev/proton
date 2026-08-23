import { protonFields, snowflakeSchema, tryParseDuration } from '@proton/core';
import { z } from 'zod';

export const MODULE_ID = 'giveaways';

export const TITLE_MAX = 200;
export const DESCRIPTION_MAX = 1500;
export const WINNER_COUNT_MAX = 50;
export const REQUIREMENTS_MAX = 10;
export const MULTIPLIERS_MAX = 10;
export const GIVEAWAY_LIST_MAX = 25;
export const TOP_ENTRANTS = 10;
export const MAX_ENTRIES_PER_USER_MAX = 1000;

export const DAY_MS = 24 * 60 * 60 * 1000;

export const MIN_DURATION_MS = 60_000;
export const MAX_DURATION_MS = 56 * DAY_MS;

export const DEFAULT_CLAIM_WINDOW_SECONDS = 24 * 60 * 60;

// One edit per five seconds per message is Proton's own budget, not a documented Discord limit —
// docs.discord.com says rate limits must not be hard coded and to read the response headers. The
// proxy does that; this only stops a busy giveaway from queueing behind itself.
export const COUNT_FLUSH_INTERVAL_MS = 5_000;

export function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

export function describeWait(ms: number): string {
  if (ms <= 0) return 'no time at all';

  const minutes = Math.ceil(ms / 60_000);
  if (minutes < 60) return plural(minutes, 'minute');

  const hours = Math.ceil(minutes / 60);
  if (hours < 48) return plural(hours, 'hour');

  return plural(Math.ceil(hours / 24), 'day');
}

export type DurationResult = { ok: true; ms: number } | { ok: false; humanReason: string };

export function parseGiveawayDuration(raw: string): DurationResult {
  const ms = tryParseDuration(raw);

  if (ms === null) {
    return {
      ok: false,
      humanReason:
        `“${raw}” is not a length of time I understand. Give a number followed by s, m, h, d ` +
        'or w — for example 30m, 12h or 7d.',
    };
  }

  if (ms < MIN_DURATION_MS) {
    return {
      ok: false,
      humanReason:
        `A giveaway has to run for at least ${describeWait(MIN_DURATION_MS)}, and “${raw}” is ` +
        'shorter than that. Anything briefer ends before most members have seen it.',
    };
  }

  if (ms > MAX_DURATION_MS) {
    return {
      ok: false,
      humanReason:
        `A giveaway can run for at most ${describeWait(MAX_DURATION_MS)}, and “${raw}” is ` +
        'longer than that. Pick a shorter one, or run a second giveaway afterwards.',
    };
  }

  return { ok: true, ms };
}

export const giveawaysConfigSchema = z.object({
  enabled: z.boolean().default(false).register(protonFields, {
    label: 'Enabled',
    description: 'Who may run each /giveaway command is set in the Permissions module',
  }),

  defaultWinnerCount: z
    .number()
    .int()
    .min(1)
    .max(WINNER_COUNT_MAX)
    .default(1)
    .register(protonFields, {
      label: 'Default number of winners',
    }),

  announceInChannel: z.boolean().default(true).register(protonFields, {
    label: 'Announce the winners in the channel',
  }),

  dmWinners: z.boolean().default(false).register(protonFields, {
    label: 'Also DM the winners',
  }),

  // Off by default: a host who never touches this setting should not ship a giveaway that can
  // quietly reroll away a legitimate winner who was asleep.
  claimWindowSeconds: z
    .number()
    .int()
    .min(60)
    .max(7 * 24 * 60 * 60)
    .optional()
    .register(protonFields, {
      label: 'Claim window (seconds)',
      description: 'Unclaimed wins are forfeited and rerolled',
    }),

  logChannelId: snowflakeSchema.optional().register(protonFields, {
    field: 'channel-id',
    label: 'Giveaway warning channel',
  }),

  embedColor: z.number().int().min(0).max(0xffffff).default(0x5865f2).register(protonFields, {
    label: 'Accent colour',
  }),
});

export type GiveawaysConfig = z.infer<typeof giveawaysConfigSchema>;

export const giveawaysDefaultConfig: GiveawaysConfig = {
  enabled: false,
  defaultWinnerCount: 1,
  announceInChannel: true,
  dmWinners: false,
  embedColor: 0x5865f2,
};

export const GIVEAWAYS_SCHEMA_VERSION = 2;
