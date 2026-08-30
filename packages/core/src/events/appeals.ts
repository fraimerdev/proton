import { z } from 'zod';
import { snowflakeSchema } from '../actions/payloads.ts';

export const APPEAL_DECISIONS = ['approved', 'denied'] as const;
export type AppealDecision = (typeof APPEAL_DECISIONS)[number];

export const appealSubmittedSchema = z.object({
  guildId: snowflakeSchema,
  userId: snowflakeSchema,

  appealId: z.string().min(1).max(64),
  panelId: z.string().min(1).max(32),

  origin: z.string().min(1).max(32),
  jti: z.string().min(1).max(64),

  submittedAt: z.number().int().nonnegative(),
});

export type AppealSubmitted = z.infer<typeof appealSubmittedSchema>;

export const appealDecidedSchema = z.object({
  guildId: snowflakeSchema,
  userId: snowflakeSchema,

  appealId: z.string().min(1).max(64),
  panelId: z.string().min(1).max(32),

  decision: z.enum(APPEAL_DECISIONS),
  decidedBy: snowflakeSchema,
  decidedAt: z.number().int().nonnegative(),
});

export type AppealDecided = z.infer<typeof appealDecidedSchema>;
