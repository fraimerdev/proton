import {
  ACHIEVEMENT_JOBS,
  ACHIEVEMENT_RETRY_MAX,
  achievementRetryOutcomeSchema,
  achievementRewardRefSchema,
  snowflakeSchema,
  TIER_IDS,
  XP_SOURCES,
} from '@proton/core';
import { z } from 'zod';
import { ACHIEVEMENT_ID, ACHIEVEMENT_KINDS, BADGE_ASSET_ID, rewardSchema } from './config.ts';
import { REWARD_KIND_IDS } from './triggers.ts';

export const REQUEST_ID = /^[A-Za-z0-9_-]{8,64}$/;

export const PAGE_SIZE_DEFAULT = 25;
export const PAGE_SIZE_MAX = 100;

export const REWARD_STATUSES = [
  'pending',
  'delivering',
  'requested',
  'delivered',
  'failed',
  'skipped',
  'cancelled',
] as const;

export type RewardStatus = (typeof REWARD_STATUSES)[number];

export const ANNOUNCE_STATUSES = ['pending', 'sent', 'failed', 'skipped', 'suppressed'] as const;

export type AnnounceStatus = (typeof ANNOUNCE_STATUSES)[number];

export const JOB_STATUSES = ['queued', 'running', 'done', 'failed'] as const;

export type JobStatus = (typeof JOB_STATUSES)[number];

export const RESET_SCOPES = ['member_achievement', 'member_all', 'achievement'] as const;

export type ResetScope = (typeof RESET_SCOPES)[number];

export const REWARD_LIST_STATUSES = ['failed', 'pending'] as const;

export const BADGE_UPLOAD_MAX_BYTES = 256 * 1024;

export const BADGE_CONTENT_TYPES = ['image/png', 'image/jpeg', 'image/gif'] as const;

const count = z.number().int().min(0);
const instant = z.number().int();
const tierIdSchema = z.enum(TIER_IDS);
const tierCounts = z.record(tierIdSchema, count);
const achievementIdSchema = z.string().regex(ACHIEVEMENT_ID);
const requestIdSchema = z.string().regex(REQUEST_ID);

function blankless<T extends z.ZodType>(schema: T) {
  return z.preprocess((value) => (value === '' ? undefined : value), schema.optional());
}

const pageQuery = {
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(PAGE_SIZE_MAX).default(PAGE_SIZE_DEFAULT),
};

const pageResult = {
  total: count,
  page: z.number().int().min(1),
  pageSize: z.number().int().min(1),
};

const auditStamp = {
  actorId: snowflakeSchema,
  source: z.literal('dashboard'),
  ipHash: z.string().min(1).max(128).optional(),
};

export const intervalSchema = z.object({ start: instant, end: instant.nullable() });

export const jobResultSchema = z.object({
  members: count,
  changed: count,
  lost: count,
  newlyEarned: tierCounts,
  reason: z.string().max(400).optional(),
});

export type JobResult = z.infer<typeof jobResultSchema>;

export const jobViewSchema = z.object({
  kind: z.enum(ACHIEVEMENT_JOBS),
  status: z.enum(JOB_STATUSES),
  requestedAt: instant.nullable(),
  finishedAt: instant.nullable(),
  result: jobResultSchema.nullable(),
});

export type JobView = z.infer<typeof jobViewSchema>;

export const overviewAchievementSchema = z.object({
  id: achievementIdSchema,
  firstActiveAt: instant.nullable(),
  // A re-check queued for an achievement that has not started yet waits here, sometimes for days,
  // so every caller needs the start date to tell waiting apart from stuck.
  startsAt: instant.nullable(),
  holders: tierCounts,
  inProgress: count,
  rewards: z.object({ pending: count, failed: count }),
  job: jobViewSchema.nullable(),
});

export type OverviewAchievement = z.infer<typeof overviewAchievementSchema>;

export const achievementsOverviewSchema = z.object({
  recordingSince: instant.nullable(),
  periods: z.object({ module: z.array(intervalSchema) }),
  achievements: z.array(overviewAchievementSchema),
});

export type AchievementsOverview = z.infer<typeof achievementsOverviewSchema>;

export const snapshotRequirementSchema = z.object({
  id: z.string(),
  version: z.number().int().min(1),
  trigger: z.string(),
  target: z.number().int().min(1),
  channelIds: z.array(z.string()),
  excludedChannelIds: z.array(z.string()),
  xpSources: z.array(z.enum(XP_SOURCES)).optional(),
  achievementId: z.string().optional(),
  tierId: tierIdSchema.optional(),
});

export type SnapshotRequirement = z.infer<typeof snapshotRequirementSchema>;

export const unlockDefinitionSchema = z.object({
  name: z.string(),
  kind: z.enum(ACHIEVEMENT_KINDS),
  requirements: z.array(snapshotRequirementSchema),
  rewards: z.array(rewardSchema),
  revision: z.string(),
});

export type UnlockDefinition = z.infer<typeof unlockDefinitionSchema>;

export const unlockProgressSchema = z.record(z.string(), count);

export type UnlockProgress = z.infer<typeof unlockProgressSchema>;

export const unlockCauseSchema = z.object({
  metric: z.string(),
  occurredAt: instant,
  sourceModule: z.string(),
  depth: count,
});

export type UnlockCause = z.infer<typeof unlockCauseSchema>;

export const unlockViewSchema = z.object({
  userId: snowflakeSchema,
  achievementId: z.string(),
  tierId: tierIdSchema,
  generation: count,
  tierIndex: count,
  unlockedAt: instant,
  revision: z.string(),
  definition: unlockDefinitionSchema,
  progress: unlockProgressSchema,
  cause: unlockCauseSchema,
  originChannelId: snowflakeSchema.nullable(),
  announceGroup: z.string(),
  announceStatus: z.enum(ANNOUNCE_STATUSES),
  announceAttempts: count,
  announceError: z.string().nullable(),
  announcedAt: instant.nullable(),
  announceMessageId: z.string().nullable(),
  publishedAt: instant.nullable(),
  voidedAt: instant.nullable(),
  voidedBy: z.string().nullable(),
});

export type UnlockView = z.infer<typeof unlockViewSchema>;

export const rewardViewSchema = z.object({
  userId: snowflakeSchema,
  achievementId: z.string(),
  tierId: tierIdSchema,
  generation: count,
  rewardKey: z.string().min(1).max(80),
  rewardEpoch: count,
  kind: z.enum(REWARD_KIND_IDS),
  roleId: snowflakeSchema.nullable(),
  amount: z.number().int().nullable(),
  status: z.enum(REWARD_STATUSES),
  attempts: count,
  nextAttemptAt: instant.nullable(),
  transient: z.boolean(),
  errorCode: z.string().nullable(),
  error: z.string().nullable(),
  requestedAt: instant.nullable(),
  deliveredAt: instant.nullable(),
  createdAt: instant,
  updatedAt: instant,
});

export type RewardView = z.infer<typeof rewardViewSchema>;

export const memberFactsViewSchema = z.object({
  joinedAt: instant.nullable(),
  premiumSince: instant.nullable(),
  leftAt: instant.nullable(),
  updatedAt: instant,
});

export type MemberFactsView = z.infer<typeof memberFactsViewSchema>;

export const memberAchievementViewSchema = z.object({
  achievementId: z.string(),
  generation: count,
  rewardEpoch: count,
  countedFrom: instant.nullable(),
  resetAt: instant.nullable(),
  resetBy: z.string().nullable(),
  values: z.record(z.string(), count),
  unlocked: z.array(tierIdSchema),
  almostNotified: z.array(tierIdSchema),
  almostNotifiedAt: instant.nullable(),
});

export type MemberAchievementView = z.infer<typeof memberAchievementViewSchema>;

export const memberDetailSchema = z.object({
  userId: snowflakeSchema,
  facts: memberFactsViewSchema.nullable(),
  achievements: z.array(memberAchievementViewSchema),
  unlocks: z.array(unlockViewSchema),
  voided: z.array(unlockViewSchema),
  rewards: z.array(rewardViewSchema),
});

export type MemberDetail = z.infer<typeof memberDetailSchema>;

export const unlockListQuerySchema = z.object({
  achievementId: blankless(achievementIdSchema),
  ...pageQuery,
});

export type UnlockListQuery = z.infer<typeof unlockListQuerySchema>;
export type UnlockListQueryInput = z.input<typeof unlockListQuerySchema>;

export const unlockListResultSchema = z.object({
  items: z.array(unlockViewSchema),
  ...pageResult,
});

export type UnlockListResult = z.infer<typeof unlockListResultSchema>;

export const rewardListQuerySchema = z.object({
  status: blankless(z.enum(REWARD_LIST_STATUSES)),
  achievementId: blankless(achievementIdSchema),
  ...pageQuery,
});

export type RewardListQuery = z.infer<typeof rewardListQuerySchema>;
export type RewardListQueryInput = z.input<typeof rewardListQuerySchema>;

export const rewardListResultSchema = z.object({
  items: z.array(rewardViewSchema),
  ...pageResult,
});

export type RewardListResult = z.infer<typeof rewardListResultSchema>;

const rewardRetryShape = {
  requestId: requestIdSchema,
  rewards: z.array(achievementRewardRefSchema).min(1).max(ACHIEVEMENT_RETRY_MAX),
};

export const rewardRetryRequestSchema = z.object(rewardRetryShape);

export type RewardRetryRequest = z.infer<typeof rewardRetryRequestSchema>;

export const rewardRetryBodySchema = z.object({ ...rewardRetryShape, ...auditStamp });

export type RewardRetryBody = z.infer<typeof rewardRetryBodySchema>;

export const rewardRetryOutcomeSchema = achievementRetryOutcomeSchema;

export type RewardRetryOutcome = z.infer<typeof rewardRetryOutcomeSchema>;

const memberAchievementReset = {
  scope: z.literal('member_achievement'),
  requestId: requestIdSchema,
  userId: snowflakeSchema,
  achievementId: achievementIdSchema,
  allowRewardsAgain: z.boolean().default(false),
};

const memberAllReset = {
  scope: z.literal('member_all'),
  requestId: requestIdSchema,
  userId: snowflakeSchema,
  allowRewardsAgain: z.boolean().default(false),
};

const achievementReset = {
  scope: z.literal('achievement'),
  requestId: requestIdSchema,
  achievementId: achievementIdSchema,
  allowRewardsAgain: z.boolean().default(false),
  confirmation: z.string().max(80),
};

export const resetRequestSchema = z.discriminatedUnion('scope', [
  z.object(memberAchievementReset),
  z.object(memberAllReset),
  z.object(achievementReset),
]);

export type ResetRequest = z.infer<typeof resetRequestSchema>;
export type ResetRequestInput = z.input<typeof resetRequestSchema>;

export const resetBodySchema = z.discriminatedUnion('scope', [
  z.object({ ...memberAchievementReset, ...auditStamp }),
  z.object({ ...memberAllReset, ...auditStamp }),
  z.object({ ...achievementReset, ...auditStamp }),
]);

export type ResetBody = z.infer<typeof resetBodySchema>;

export const resetResultSchema = z.object({ achievements: count, members: count });

export type ResetResult = z.infer<typeof resetResultSchema>;

const jobRequestShape = {
  requestId: requestIdSchema,
  achievementId: achievementIdSchema,
  job: z.enum(ACHIEVEMENT_JOBS),
  announce: z.boolean().default(false),
  acceptLoss: z.boolean().default(false),
};

export const jobRequestSchema = z.object(jobRequestShape);

export type JobRequest = z.infer<typeof jobRequestSchema>;
export type JobRequestInput = z.input<typeof jobRequestSchema>;

export const jobBodySchema = z.object({ ...jobRequestShape, ...auditStamp });

export type JobBody = z.infer<typeof jobBodySchema>;

export const jobQueuedSchema = z.object({ status: z.literal('queued') });

export type JobQueued = z.infer<typeof jobQueuedSchema>;

export const badgeUploadResultSchema = z.object({
  assetId: z.string().regex(BADGE_ASSET_ID),
  contentType: z.enum(BADGE_CONTENT_TYPES),
  byteSize: z.number().int().min(1).max(BADGE_UPLOAD_MAX_BYTES),
});

export type BadgeUploadResult = z.infer<typeof badgeUploadResultSchema>;
