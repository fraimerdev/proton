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
    enabled: z.boolean().default(false).register(protonFields, { label: 'Enabled' }),

    joinWindow: durationStringSchema.default('10s').register(protonFields, {
      field: 'duration',
      label: 'Join window',
    }),

    joinThreshold: z
      .number()
      .int()
      .min(2)
      .max(500)
      .default(10)
      .register(protonFields, { label: 'Joins per window' }),

    newAccountAge: durationStringSchema.default('7d').register(protonFields, {
      field: 'duration',
      label: 'New account age',
    }),

    brandNewAccountAge: durationStringSchema.default('1d').register(protonFields, {
      field: 'duration',
      label: 'Brand-new account age',
    }),

    scoreThreshold: z
      .number()
      .int()
      .min(MIN_ACTIONABLE_SCORE)
      .max(MAX_JOIN_SCORE)
      .default(MIN_ACTIONABLE_SCORE)
      .register(protonFields, { label: 'Score to act' }),

    response: z
      .enum(RAID_RESPONSES)
      .default('verify')
      .register(protonFields, { label: 'Response' }),

    verificationRoleId: snowflakeSchema.optional().register(protonFields, {
      field: 'role-id',
      label: 'Verification role',
      description: 'Gates nothing unless the role’s own permissions deny access',
    }),

    quarantineRoleId: snowflakeSchema.optional().register(protonFields, {
      field: 'role-id',
      label: 'Quarantine role',
      description: 'Stays on until a staff member takes it off',
    }),

    alertChannelId: snowflakeSchema.optional().register(protonFields, {
      field: 'channel-id',
      label: 'Alert channel',
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
