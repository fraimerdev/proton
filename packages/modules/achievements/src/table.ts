import { guilds } from '@proton/db';
import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

function instant(name: string) {
  return timestamp(name, { withTimezone: true, precision: 3 });
}

function guildId() {
  return text('guild_id')
    .notNull()
    .references(() => guilds.id, { onDelete: 'cascade' });
}

export const achievementSeen = pgTable(
  'achievement_seen',
  {
    guildId: guildId(),
    metric: text('metric').notNull(),
    sourceKey: text('source_key').notNull(),
    userId: text('user_id').notNull(),
    occurredAt: instant('occurred_at').notNull(),
    state: text('state').notNull().default('counted'),
    groupKey: text('group_key'),
    channelId: text('channel_id'),
    parentId: text('parent_id'),
    categoryId: text('category_id'),
    seenAt: instant('seen_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: 'achievement_seen_pk', columns: [t.guildId, t.metric, t.sourceKey] }),
    index('achievement_seen_group_idx')
      .on(t.guildId, t.groupKey)
      .where(sql`${t.groupKey} is not null`),
  ],
);

export type AchievementSeenRow = typeof achievementSeen.$inferSelect;

export const achievementActivity = pgTable(
  'achievement_activity',
  {
    guildId: guildId(),
    userId: text('user_id').notNull(),
    metric: text('metric').notNull(),
    hour: instant('hour').notNull(),
    channelKey: text('channel_key').notNull().default(''),
    channelId: text('channel_id'),
    parentId: text('parent_id'),
    categoryId: text('category_id'),
    temporary: boolean('temporary').notNull().default(false),
    xpSource: text('xp_source').notNull().default(''),
    amountSum: bigint('amount_sum', { mode: 'number' }).notNull().default(0),
    amountMax: integer('amount_max').notNull().default(0),
    spanStart: instant('span_start'),
    events: integer('events').notNull().default(0),
  },
  (t) => [
    primaryKey({
      name: 'achievement_activity_pk',
      columns: [t.guildId, t.userId, t.metric, t.hour, t.channelKey, t.temporary, t.xpSource],
    }),
    index('achievement_activity_guild_metric_hour_idx').on(t.guildId, t.metric, t.hour),
    index('achievement_activity_hour_idx').on(t.hour),
  ],
);

export type AchievementActivityRow = typeof achievementActivity.$inferSelect;

export const achievementProgress = pgTable(
  'achievement_progress',
  {
    guildId: guildId(),
    achievementId: text('achievement_id').notNull(),
    requirementId: text('requirement_id').notNull(),
    userId: text('user_id').notNull(),
    value: bigint('value', { mode: 'number' }).notNull().default(0),
    version: integer('version').notNull(),
    generation: integer('generation').notNull().default(0),
    updatedAt: instant('updated_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({
      name: 'achievement_progress_pk',
      columns: [t.guildId, t.achievementId, t.userId, t.requirementId],
    }),
  ],
);

export type AchievementProgressRow = typeof achievementProgress.$inferSelect;

export const achievementMembers = pgTable(
  'achievement_members',
  {
    guildId: guildId(),
    achievementId: text('achievement_id').notNull(),
    userId: text('user_id').notNull(),
    generation: integer('generation').notNull().default(0),
    rewardEpoch: integer('reward_epoch').notNull().default(0),
    countedFrom: instant('counted_from'),
    resetAt: instant('reset_at'),
    resetBy: text('reset_by'),
    almostNotified: text('almost_notified').array().notNull().default(sql`ARRAY[]::text[]`),
    almostNotifiedAt: instant('almost_notified_at'),
    createdAt: instant('created_at').notNull().defaultNow(),
    updatedAt: instant('updated_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({
      name: 'achievement_members_pk',
      columns: [t.guildId, t.achievementId, t.userId],
    }),
  ],
);

export type AchievementMemberRow = typeof achievementMembers.$inferSelect;

export const achievementState = pgTable(
  'achievement_state',
  {
    guildId: guildId(),
    achievementId: text('achievement_id').notNull(),
    generation: integer('generation').notNull().default(0),
    rewardEpoch: integer('reward_epoch').notNull().default(0),
    countedFrom: instant('counted_from'),
    resetAt: instant('reset_at'),
    resetBy: text('reset_by'),
    firstActiveAt: instant('first_active_at'),
    job: text('job'),
    jobStatus: text('job_status'),
    jobCursor: text('job_cursor'),
    jobRequestedAt: instant('job_requested_at'),
    jobRequestedBy: text('job_requested_by'),
    jobFinishedAt: instant('job_finished_at'),
    jobResult: jsonb('job_result'),
    jobAnnounce: boolean('job_announce').notNull().default(false),
    jobAcceptLoss: boolean('job_accept_loss').notNull().default(false),
    updatedAt: instant('updated_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ name: 'achievement_state_pk', columns: [t.guildId, t.achievementId] })],
);

export type AchievementStateRow = typeof achievementState.$inferSelect;

export const achievementPeriods = pgTable(
  'achievement_periods',
  {
    guildId: guildId(),
    achievementId: text('achievement_id').notNull(),
    startedAt: instant('started_at').notNull(),
    endedAt: instant('ended_at'),
  },
  (t) => [
    primaryKey({
      name: 'achievement_periods_pk',
      columns: [t.guildId, t.achievementId, t.startedAt],
    }),
    uniqueIndex('achievement_periods_open_uq')
      .on(t.guildId, t.achievementId)
      .where(sql`${t.endedAt} is null`),
  ],
);

export type AchievementPeriodRow = typeof achievementPeriods.$inferSelect;

export const achievementUnlocks = pgTable(
  'achievement_unlocks',
  {
    guildId: guildId(),
    userId: text('user_id').notNull(),
    achievementId: text('achievement_id').notNull(),
    tierId: text('tier_id').notNull(),
    generation: integer('generation').notNull(),
    tierIndex: integer('tier_index').notNull(),
    unlockedAt: instant('unlocked_at').notNull(),
    revision: text('revision').notNull(),
    definition: jsonb('definition').notNull(),
    progress: jsonb('progress').notNull().default(sql`'{}'::jsonb`),
    cause: jsonb('cause').notNull(),
    originChannelId: text('origin_channel_id'),
    announceGroup: text('announce_group').notNull(),
    announceStatus: text('announce_status').notNull().default('pending'),
    announceAttempts: integer('announce_attempts').notNull().default(0),
    announceLeaseUntil: instant('announce_lease_until'),
    announceError: text('announce_error'),
    announcedAt: instant('announced_at'),
    announceMessageId: text('announce_message_id'),
    publishedAt: instant('published_at'),
    voidedAt: instant('voided_at'),
    voidedBy: text('voided_by'),
  },
  (t) => [
    primaryKey({
      name: 'achievement_unlocks_pk',
      columns: [t.guildId, t.userId, t.achievementId, t.tierId, t.generation],
    }),
    index('achievement_unlocks_guild_achievement_tier_idx').on(
      t.guildId,
      t.achievementId,
      t.tierId,
    ),
    index('achievement_unlocks_pending_announce_idx')
      .on(t.guildId, t.announceStatus)
      .where(sql`${t.announceStatus} = 'pending'`),
    index('achievement_unlocks_unpublished_idx').on(t.guildId).where(sql`${t.publishedAt} is null`),
  ],
);

export type AchievementUnlockRow = typeof achievementUnlocks.$inferSelect;

export const achievementRewards = pgTable(
  'achievement_rewards',
  {
    guildId: guildId(),
    userId: text('user_id').notNull(),
    achievementId: text('achievement_id').notNull(),
    tierId: text('tier_id').notNull(),
    generation: integer('generation').notNull(),
    rewardKey: text('reward_key').notNull(),
    rewardEpoch: integer('reward_epoch').notNull(),
    kind: text('kind').notNull(),
    roleId: text('role_id'),
    amount: integer('amount'),
    status: text('status').notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    leaseUntil: instant('lease_until'),
    nextAttemptAt: instant('next_attempt_at'),
    transient: boolean('transient').notNull().default(false),
    errorCode: text('error_code'),
    error: text('error'),
    requestedAt: instant('requested_at'),
    deliveredAt: instant('delivered_at'),
    createdAt: instant('created_at').notNull().defaultNow(),
    updatedAt: instant('updated_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({
      name: 'achievement_rewards_pk',
      columns: [t.guildId, t.userId, t.achievementId, t.tierId, t.generation, t.rewardKey],
    }),
    index('achievement_rewards_guild_status_due_idx').on(t.guildId, t.status, t.nextAttemptAt),
    index('achievement_rewards_epoch_idx').on(
      t.guildId,
      t.userId,
      t.achievementId,
      t.tierId,
      t.rewardKey,
      t.rewardEpoch,
    ),
  ],
);

export type AchievementRewardRow = typeof achievementRewards.$inferSelect;

export const achievementMemberFacts = pgTable(
  'achievement_member_facts',
  {
    guildId: guildId(),
    userId: text('user_id').notNull(),
    joinedAt: instant('joined_at'),
    premiumSince: instant('premium_since'),
    leftAt: instant('left_at'),
    updatedAt: instant('updated_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: 'achievement_member_facts_pk', columns: [t.guildId, t.userId] }),
    index('achievement_member_facts_joined_idx').on(t.guildId, t.joinedAt),
  ],
);

export type AchievementMemberFactsRow = typeof achievementMemberFacts.$inferSelect;

export const achievementBadges = pgTable(
  'achievement_badges',
  {
    guildId: guildId(),
    assetId: text('asset_id').notNull(),
    contentType: text('content_type').notNull(),
    base64: text('base64').notNull(),
    byteSize: integer('byte_size').notNull(),
    uploadedBy: text('uploaded_by').notNull(),
    uploadedAt: instant('uploaded_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ name: 'achievement_badges_pk', columns: [t.guildId, t.assetId] })],
);

export type AchievementBadgeRow = typeof achievementBadges.$inferSelect;
