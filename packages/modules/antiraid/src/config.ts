import {
  durationStringSchema,
  protonFields,
  snowflakeSchema,
  tryParseDuration,
} from '@proton/core';
import { z } from 'zod';
import { MAX_JOIN_SCORE, MIN_ACTIONABLE_SCORE, type ScoreSettings } from './score.ts';

/**
 * The response ladder, least severe first (PLAN.md §8 Phase 2: verification
 * gate, quarantine, kick).
 *
 * A guild picks the rung it has opted into and the module applies exactly that
 * one. It never escalates a rung on its own, which is a deliberate refusal: a
 * module that promoted itself from "add a role" to "kick" when it felt more
 * certain would turn a scoring bug into a mass kick, and §15 is explicit that
 * Proton is itself an attack vector. Escalation is a decision an admin makes in
 * the dashboard, once, in the quiet before a raid.
 *
 * `ban` is not on the ladder. A kicked raid account can rejoin, which is
 * precisely why kick is the right removal here: it costs a raider a re-invite
 * and costs a false positive nothing but a rejoin, whereas a wrongly banned
 * member needs a staff member to notice and undo it.
 */
export const RAID_RESPONSES = ['verify', 'quarantine', 'kick'] as const;

export type RaidResponse = (typeof RAID_RESPONSES)[number];

export const antiraidConfigSchema = z
  .object({
    /**
     * Off until configured, unlike most modules.
     *
     * The two least severe rungs apply a role that the guild has to create and
     * name here first, so an antiraid switched on out of the box could only log
     * "I would have acted but no role is configured" once per suspicious join.
     * Turning it on and choosing a rung is the same visit to the dashboard, and
     * a module that says it is off is honest in a way one that says it is on and
     * does nothing is not (§1).
     */
    enabled: z.boolean().default(false).register(protonFields, {
      label: 'Enabled',
      description: 'Screen joins for raid patterns in this server.',
    }),

    joinWindow: durationStringSchema.default('10s').register(protonFields, {
      field: 'duration',
      label: 'Join window',
      description: 'How far back the join-rate counter looks. Joins older than this stop counting.',
    }),

    /**
     * Two is the floor for the same reason `rate-over-window` uses it: one join
     * inside a window is not a rate, it is the join, and a threshold of one would
     * mark every server as permanently under attack.
     */
    joinThreshold: z
      .number()
      .int()
      .min(2)
      .max(500)
      .default(10)
      .register(protonFields, {
        label: 'Joins per window',
        description:
          'How many joins inside the window count as a burst. Set this above the busiest ' +
          'legitimate join wave this server sees — a growing server is not a raid.',
      }),

    newAccountAge: durationStringSchema.default('7d').register(protonFields, {
      field: 'duration',
      label: 'New account age',
      description: 'Accounts younger than this are treated as new.',
    }),

    brandNewAccountAge: durationStringSchema.default('1d').register(protonFields, {
      field: 'duration',
      label: 'Brand-new account age',
      description:
        'Accounts younger than this score higher than merely new ones. Must not exceed the ' +
        'new-account age.',
    }),

    /**
     * The floor is not a suggestion: `MIN_ACTIONABLE_SCORE` is one above the
     * heaviest single signal, so no configuration reachable through this schema
     * can act on a member for one signal alone.
     */
    scoreThreshold: z
      .number()
      .int()
      .min(MIN_ACTIONABLE_SCORE)
      .max(MAX_JOIN_SCORE)
      .default(MIN_ACTIONABLE_SCORE)
      .register(protonFields, {
        label: 'Score to act',
        description:
          `Suspicion score at which the response is applied, ${MIN_ACTIONABLE_SCORE}-${MAX_JOIN_SCORE}. ` +
          'Lower is more aggressive; the minimum still requires at least two signals.',
      }),

    response: z
      .enum(RAID_RESPONSES)
      .default('verify')
      .register(protonFields, {
        label: 'Response',
        description:
          'What happens to a join that scores at or above the threshold: verify applies the ' +
          'verification role, quarantine applies the quarantine role and alerts staff, kick ' +
          'removes the account.',
      }),

    verificationRoleId: snowflakeSchema.optional().register(protonFields, {
      field: 'role-id',
      label: 'Verification role',
      description:
        'Applied by the verify response. The role that gates access until the member passes ' +
        'this server’s verification — Proton only applies it, the role’s own permissions and ' +
        'channel overwrites decide what it means.',
    }),

    quarantineRoleId: snowflakeSchema.optional().register(protonFields, {
      field: 'role-id',
      label: 'Quarantine role',
      description:
        'Applied by the quarantine response. Isolates the account until a staff member ' +
        'reviews it and removes the role.',
    }),

    alertChannelId: snowflakeSchema.optional().register(protonFields, {
      field: 'channel-id',
      label: 'Alert channel',
      description:
        'Where Proton posts one message when the join rate crosses the threshold. Left empty, ' +
        'raids are still handled but nobody is told.',
    }),
  })
  /**
   * Brand new has to be a subset of new, or the grading inverts: an account
   * younger than the "new" cutoff but older than the "brand new" one would score
   * the heavier weight, and the two settings would read as the opposite of what
   * they do. Refused on write, where an admin can see the message, rather than
   * quietly reinterpreted at scoring time.
   */
  .superRefine((config, ctx) => {
    const brandNew = tryParseDuration(config.brandNewAccountAge);
    const isNew = tryParseDuration(config.newAccountAge);
    if (brandNew === null || isNew === null || brandNew <= isNew) return;

    ctx.addIssue({
      code: 'custom',
      path: ['brandNewAccountAge'],
      message:
        `must not be longer than the new-account age (${config.newAccountAge}) — brand-new ` +
        'accounts are a subset of new ones, and the heavier score belongs to the younger set',
    });
  });

export type AntiraidConfig = z.infer<typeof antiraidConfigSchema>;

export const antiraidDefaultConfig: AntiraidConfig = {
  enabled: false,
  joinWindow: '10s',
  joinThreshold: 10,
  newAccountAge: '7d',
  brandNewAccountAge: '1d',
  scoreThreshold: MIN_ACTIONABLE_SCORE,
  // The least severe rung by default. A default that kicked would make installing
  // Proton the raid (§15).
  response: 'verify',
};

/** Bumped whenever the shape above changes (I5). */
export const ANTIRAID_SCHEMA_VERSION = 1;

export type ScoreSettingsResult =
  | { settings: ScoreSettings; joinWindowMs: number }
  | { invalid: string };

/**
 * Turn the authored durations into the milliseconds the window and the scorer
 * work in — all three in one place, so no caller parses a duration by hand.
 *
 * The schema already refuses an unparseable duration, so `invalid` should be
 * unreachable — but the handler must not throw on a row written by an older
 * build: an exception inside a listener leaves the bus message unacknowledged,
 * and the same poison event is then redelivered forever. Naming the fields beats
 * a stack trace nobody can act on.
 */
export function readScoreSettings(config: AntiraidConfig): ScoreSettingsResult {
  const joinWindowMs = tryParseDuration(config.joinWindow);
  const newAccountMs = tryParseDuration(config.newAccountAge);
  const brandNewAccountMs = tryParseDuration(config.brandNewAccountAge);

  if (joinWindowMs === null || newAccountMs === null || brandNewAccountMs === null) {
    return {
      invalid:
        'Anti-raid is enabled but its stored configuration is unreadable: ' +
        `joinWindow='${config.joinWindow}', newAccountAge='${config.newAccountAge}', ` +
        `brandNewAccountAge='${config.brandNewAccountAge}'. Each must be a number followed by ` +
        's, m, h, d or w — fix them on the Anti-raid page of the Proton dashboard.',
    };
  }

  return {
    joinWindowMs,
    settings: {
      joinThreshold: config.joinThreshold,
      joinWindow: config.joinWindow,
      newAccountMs,
      brandNewAccountMs,
    },
  };
}
