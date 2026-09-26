import { z } from 'zod';
import { snowflakeSchema } from '../actions/payloads.ts';
import { causationSchema } from './xp.ts';

export const TIER_IDS = ['single', 'bronze', 'silver', 'gold', 'diamond'] as const;

export type TierId = (typeof TIER_IDS)[number];

const achievementIdSchema = z.string().min(1).max(40);

const requestIdSchema = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/);

export const achievementUnlockedSchema = z.object({
  guildId: snowflakeSchema,
  userId: snowflakeSchema,
  achievementId: achievementIdSchema,
  tierId: z.enum(TIER_IDS),
  generation: z.number().int().min(0),
  unlockedAt: z.number().int(),
  final: z.boolean(),
  originChannelId: snowflakeSchema.optional(),
  causation: causationSchema,
});

export type AchievementUnlocked = z.infer<typeof achievementUnlockedSchema>;

export const achievementRewardRefSchema = z.object({
  userId: snowflakeSchema,
  achievementId: achievementIdSchema,
  tierId: z.enum(TIER_IDS),
  generation: z.number().int().min(0),
  rewardKey: z.string().min(1).max(80),
});

export type AchievementRewardRef = z.infer<typeof achievementRewardRefSchema>;

export const ACHIEVEMENT_RETRY_MAX = 50;

export const achievementRewardRetryRequestedSchema = z.object({
  requestId: requestIdSchema,
  guildId: snowflakeSchema,
  actorId: snowflakeSchema,
  rewards: z.array(achievementRewardRefSchema).min(1).max(ACHIEVEMENT_RETRY_MAX),
});

export type AchievementRewardRetryRequested = z.infer<typeof achievementRewardRetryRequestedSchema>;

export const ACHIEVEMENT_JOBS = ['rebuild', 'rebuild_preview', 'recheck'] as const;

export type AchievementJob = (typeof ACHIEVEMENT_JOBS)[number];

export const achievementJobRequestedSchema = z.object({
  requestId: requestIdSchema,
  guildId: snowflakeSchema,
  actorId: snowflakeSchema,
  achievementId: achievementIdSchema,
  job: z.enum(ACHIEVEMENT_JOBS),
  announce: z.boolean(),
  acceptLoss: z.boolean(),
});

export type AchievementJobRequested = z.infer<typeof achievementJobRequestedSchema>;

export const ACHIEVEMENT_RETRY_MAILBOX_PREFIX = 'proton:achievements:retry';

export const ACHIEVEMENT_RETRY_STATUSES = [
  'delivered',
  'requested',
  'failed',
  'skipped',
  'not_found',
  'not_retryable',
] as const;

export type AchievementRetryStatus = (typeof ACHIEVEMENT_RETRY_STATUSES)[number];

export const achievementRetryResultSchema = achievementRewardRefSchema.extend({
  status: z.enum(ACHIEVEMENT_RETRY_STATUSES),
  message: z.string().max(400),
});

export type AchievementRetryResult = z.infer<typeof achievementRetryResultSchema>;

export const achievementRetryOutcomeSchema = z.object({
  results: z.array(achievementRetryResultSchema).max(ACHIEVEMENT_RETRY_MAX),
});

export type AchievementRetryOutcome = z.infer<typeof achievementRetryOutcomeSchema>;
