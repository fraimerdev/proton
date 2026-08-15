import { durationStringSchema, protonFields } from '@proton/core';
import { z } from 'zod';

/**
 * Text and announcement channels — the only places an alert can be posted.
 */
const ALERT_CHANNEL_TYPES = [0, 5];

/**
 * A threshold's count.
 *
 * The floor is 2 for the same reason the escalation ladder's is: the sliding
 * window trips on the call where `count` reaches `limit`, so a limit of 1 fires
 * on the first deletion anybody ever makes. That is not a rate, it is a ban on
 * the operation, and a guild that wants one should remove the permission rather
 * than have a security module masquerade as a permission system.
 */
function limitField(label: string, description: string, defaultValue: number) {
  return z
    .number()
    .int()
    .min(2)
    .max(100)
    .default(defaultValue)
    .register(protonFields, { label, description });
}

function windowField(label: string, description: string, defaultValue: string) {
  return durationStringSchema
    .default(defaultValue)
    .register(protonFields, { field: 'duration', label, description });
}

/** What the breaker does *after* the roles are off. */
export const AFTER_STRIP_ACTIONS = ['none', 'kick', 'ban'] as const;

export type AfterStripAction = (typeof AFTER_STRIP_ACTIONS)[number];

/**
 * Anti-nuke configuration (PLAN.md §8 phase 2).
 *
 * Flat on purpose. A nested `thresholds: { channelDelete: { limit, window } }`
 * would read better in source and would be outside the v1 form vocabulary the
 * moment it nested twice (§9), so the pairs are spelled out and
 * `THRESHOLD_FIELDS` in `classes.ts` is the single place that knows which two
 * keys belong to which class.
 */
export const antinukeConfigSchema = z.object({
  enabled: z.boolean().default(true).register(protonFields, {
    label: 'Enabled',
    description: 'Watch the audit log for destructive bursts and trip the breaker.',
  }),

  channelDeleteLimit: limitField(
    'Channel deletions before the breaker trips',
    'How many channels one member may delete inside the window below.',
    3,
  ),
  channelDeleteWindow: windowField(
    'Channel deletion window',
    'The period the deletions above are counted over.',
    '30s',
  ),

  roleDeleteLimit: limitField(
    'Role deletions before the breaker trips',
    'How many roles one member may delete inside the window below.',
    3,
  ),
  roleDeleteWindow: windowField(
    'Role deletion window',
    'The period the deletions above are counted over.',
    '30s',
  ),

  webhookDeleteLimit: limitField(
    'Webhook deletions before the breaker trips',
    'How many webhooks one member may delete inside the window below.',
    5,
  ),
  webhookDeleteWindow: windowField(
    'Webhook deletion window',
    'The period the deletions above are counted over.',
    '30s',
  ),

  emojiDeleteLimit: limitField(
    'Emoji deletions before the breaker trips',
    'How many emoji one member may delete inside the window below. Emoji are cosmetic and ' +
      'are often tidied in bulk, so this is deliberately looser than the others.',
    10,
  ),
  emojiDeleteWindow: windowField(
    'Emoji deletion window',
    'The period the deletions above are counted over.',
    '1m',
  ),

  memberRemoveLimit: limitField(
    'Bans and kicks before the breaker trips',
    'How many members one moderator may ban or kick inside the window below. Bans and kicks ' +
      'share one counter: they empty a server equally well, and two separate limits would let ' +
      'someone alternate between them and stay under both.',
    5,
  ),
  memberRemoveWindow: windowField(
    'Ban and kick window',
    'The period the bans and kicks above are counted over.',
    '30s',
  ),

  /**
   * Deliberately `none` by default.
   *
   * Stripping roles is reversible and is recorded precisely enough to undo; a
   * ban is neither. A security module that bans on its own out of the box makes
   * Proton itself the attack vector §15 warns about, so the irreversible half is
   * something a guild opts into with its eyes open.
   */
  afterStrip: z
    .enum(AFTER_STRIP_ACTIONS)
    .default('none')
    .register(protonFields, {
      label: 'After stripping roles',
      description:
        'What to do once the roles are off. Stripping always happens first — it is instant ' +
        'and reversible. Anything here is not.',
    }),

  alertChannelId: z
    .string()
    .optional()
    .register(protonFields, {
      field: 'channel-id',
      label: 'Alert channel',
      description:
        'Where the breaker reports what it did. Leave empty and the report only reaches the ' +
        'logs — somebody has to be told, because the breaker stops the bleeding and a human ' +
        'still has to investigate.',
      channelTypes: ALERT_CHANNEL_TYPES,
    }),

  /**
   * The cap on how long maintenance mode may be switched on for.
   *
   * Maintenance mode is a hole in the only control standing between a
   * compromised admin and an empty server, so it is time-boxed by construction:
   * `/antinuke maintenance` refuses anything longer than this, and the window
   * carries an absolute expiry that nothing extends. An indefinite flag is a
   * permanent hole that somebody forgets to close.
   */
  maintenanceMaxDuration: windowField(
    'Longest maintenance window',
    'The most time /antinuke maintenance may switch the breaker off for in one go.',
    '1h',
  ),
});

export type AntinukeConfig = z.infer<typeof antinukeConfigSchema>;

export const antinukeDefaultConfig: AntinukeConfig = {
  enabled: true,
  channelDeleteLimit: 3,
  channelDeleteWindow: '30s',
  roleDeleteLimit: 3,
  roleDeleteWindow: '30s',
  webhookDeleteLimit: 5,
  webhookDeleteWindow: '30s',
  emojiDeleteLimit: 10,
  emojiDeleteWindow: '1m',
  memberRemoveLimit: 5,
  memberRemoveWindow: '30s',
  afterStrip: 'none',
  // No `alertChannelId`: there is no channel every guild has, and inventing one
  // would have the breaker post its findings somewhere nobody chose.
  maintenanceMaxDuration: '1h',
};

/** Bumped whenever the shape above changes (I5). */
export const ANTINUKE_SCHEMA_VERSION = 1;
