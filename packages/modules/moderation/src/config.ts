import { durationStringSchema, protonFields } from '@proton/core';
import { z } from 'zod';

export const moderationConfigSchema = z.object({
  enabled: z.boolean().default(true).register(protonFields, {
    label: 'Enabled',
  }),

  requireReason: z.boolean().default(false).register(protonFields, {
    label: 'Require a reason',
  }),

  publicReplies: z.boolean().default(false).register(protonFields, {
    label: 'Announce outcomes in the channel',
  }),

  defaultTimeoutDuration: durationStringSchema.default('1h').register(protonFields, {
    field: 'duration',
    label: 'Default timeout length',
    description: 'Discord caps timeouts at 28 days',
  }),

  defaultBanDeleteDays: z.number().int().min(0).max(7).default(0).register(protonFields, {
    label: 'Default message deletion on ban (days)',
  }),
});

export type ModerationConfig = z.infer<typeof moderationConfigSchema>;

export const moderationDefaultConfig: ModerationConfig = {
  enabled: true,
  requireReason: false,
  publicReplies: false,
  defaultTimeoutDuration: '1h',
  defaultBanDeleteDays: 0,
};

export const MODERATION_SCHEMA_VERSION = 1;
