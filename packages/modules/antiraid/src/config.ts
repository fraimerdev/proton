import {
  durationStringSchema,
  protonFields,
  snowflakeSchema,
  tryParseDuration,
} from '@proton/core';
import { z } from 'zod';
import { MAX_JOIN_SCORE, MIN_ACTIONABLE_SCORE, type ScoreSettings } from './score.ts';

export const RAID_RESPONSES = ['verify', 'quarantine', 'kick'] as const;

export type RaidResponse = (typeof RAID_RESPONSES)[number];

export const antiraidConfigSchema = z
  .object({
    enabled: z.boolean().default(false).register(protonFields, {
      label: 'Enabled',
      description: 'Screen joins for raid patterns in this server.',
    }),

    joinWindow: durationStringSchema.default('10s').register(protonFields, {
      field: 'duration',
      label: 'Join window',
      description: 'How far back the join-rate counter looks. Joins older than this stop counting.',
    }),

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

  response: 'verify',
};

export const ANTIRAID_SCHEMA_VERSION = 1;

export type ScoreSettingsResult =
  | { settings: ScoreSettings; joinWindowMs: number }
  | { invalid: string };

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
