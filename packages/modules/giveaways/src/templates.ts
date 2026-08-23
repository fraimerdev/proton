import { z } from 'zod';
import {
  MAX_DURATION_MS,
  MIN_DURATION_MS,
  MULTIPLIERS_MAX,
  REQUIREMENTS_MAX,
  TITLE_MAX,
  WINNER_COUNT_MAX,
} from './config.ts';
import { REQUIREMENT_LOGICS, VERIFY_ON } from './store.ts';

const itemSchema = z.object({
  providerId: z.string().min(1).max(100),
  config: z.record(z.string(), z.unknown()).default({}),
});

const multiplierSchema = itemSchema.extend({
  mode: z.enum(['add', 'multiply', 'max'] as const).default('add'),
});

// Validated on read, not trusted: a template saved under an older shape must fail loudly and be
// re-saved rather than half-populate a builder with fields nobody can see (PLAN.md I5).
export const templatePayloadSchema = z.object({
  title: z.string().min(1).max(TITLE_MAX),
  description: z.string().max(1500).nullable().default(null),
  durationMs: z.number().int().min(MIN_DURATION_MS).max(MAX_DURATION_MS),
  winnerCount: z.number().int().min(1).max(WINNER_COUNT_MAX),

  requirementLogic: z.enum(REQUIREMENT_LOGICS).default('all'),
  verifyOn: z.enum(VERIFY_ON).default('both'),
  maxEntriesPerUser: z.number().int().min(1).nullable().default(null),
  claimWindowSeconds: z.number().int().min(60).nullable().default(null),

  requirements: z.array(itemSchema).max(REQUIREMENTS_MAX).default([]),
  multipliers: z.array(multiplierSchema).max(MULTIPLIERS_MAX).default([]),
});

export type TemplatePayload = z.infer<typeof templatePayloadSchema>;
