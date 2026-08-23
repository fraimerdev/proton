import { guilds } from '@proton/db';
import { sql } from 'drizzle-orm';
import {
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

export const giveaways = pgTable(
  'giveaways',
  {
    id: text('id').primaryKey(),
    guildId: text('guild_id')
      .notNull()
      .references(() => guilds.id, { onDelete: 'cascade' }),
    channelId: text('channel_id').notNull(),
    messageId: text('message_id'),
    hostId: text('host_id').notNull(),

    title: text('title').notNull(),
    description: text('description'),
    bannerUrl: text('banner_url'),
    color: integer('color'),
    emoji: text('emoji'),
    buttonStyle: integer('button_style').notNull().default(1),

    winnerCount: integer('winner_count').notNull(),
    requirementLogic: text('requirement_logic').notNull().default('all'),
    maxEntriesPerUser: integer('max_entries_per_user'),
    verifyOn: text('verify_on').notNull().default('both'),

    startsAt: timestamp('starts_at', { withTimezone: true }),
    endsAt: timestamp('ends_at', { withTimezone: true }).notNull(),
    endedAt: timestamp('ended_at', { withTimezone: true }),

    status: text('status').notNull().default('running'),
    drawingStartedAt: timestamp('drawing_started_at', { withTimezone: true }),

    claimWindowSeconds: integer('claim_window_seconds'),
    dmWinners: boolean('dm_winners').notNull().default(false),
    winMessage: text('win_message'),

    templateId: text('template_id'),
    recurrence: text('recurrence'),

    createdBy: text('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('giveaways_guild_running_idx').on(t.guildId).where(sql`${t.endedAt} is null`),
    index('giveaways_due_idx').on(t.endsAt).where(sql`${t.status} = 'running'`),
  ],
);

export const giveawayRequirements = pgTable(
  'giveaway_requirements',
  {
    id: text('id').primaryKey(),
    giveawayId: text('giveaway_id')
      .notNull()
      .references(() => giveaways.id, { onDelete: 'cascade' }),
    providerId: text('provider_id').notNull(),
    config: jsonb('config').notNull(),
    position: integer('position').notNull(),
  },
  (t) => [index('giveaway_requirements_giveaway_idx').on(t.giveawayId, t.position)],
);

export const giveawayMultipliers = pgTable(
  'giveaway_multipliers',
  {
    id: text('id').primaryKey(),
    giveawayId: text('giveaway_id')
      .notNull()
      .references(() => giveaways.id, { onDelete: 'cascade' }),
    providerId: text('provider_id').notNull(),
    config: jsonb('config').notNull(),
    mode: text('mode').notNull(),
    position: integer('position').notNull(),
  },
  (t) => [index('giveaway_multipliers_giveaway_idx').on(t.giveawayId, t.position)],
);

export const giveawayEntries = pgTable(
  'giveaway_entries',
  {
    giveawayId: text('giveaway_id')
      .notNull()
      .references(() => giveaways.id, { onDelete: 'cascade' }),
    userId: text('user_id').notNull(),

    baseEntries: integer('base_entries').notNull().default(1),
    totalEntries: integer('total_entries').notNull().default(1),
    breakdown: jsonb('breakdown').notNull().default(sql`'[]'::jsonb`),

    // What the interaction carried at the moment they pressed Enter. Draw-time revalidation
    // prefers live member data; this is what it falls back to when the intent is not granted.
    memberSnapshot: jsonb('member_snapshot'),

    joinedAt: timestamp('joined_at', { withTimezone: true }).notNull().defaultNow(),
    revalidatedAt: timestamp('revalidated_at', { withTimezone: true }),
    disqualifiedAt: timestamp('disqualified_at', { withTimezone: true }),
    disqualifyReason: text('disqualify_reason'),
  },
  (t) => [
    primaryKey({ name: 'giveaway_entries_pk', columns: [t.giveawayId, t.userId] }),
    index('giveaway_entries_live_idx')
      .on(t.giveawayId, t.userId)
      .where(sql`${t.disqualifiedAt} is null`),
  ],
);

export const giveawayDraws = pgTable(
  'giveaway_draws',
  {
    id: text('id').primaryKey(),
    giveawayId: text('giveaway_id')
      .notNull()
      .references(() => giveaways.id, { onDelete: 'cascade' }),
    drawNumber: integer('draw_number').notNull(),

    seed: text('seed').notNull(),
    snapshotHash: text('snapshot_hash').notNull(),
    entrantCount: integer('entrant_count').notNull(),
    totalEntries: integer('total_entries').notNull(),

    winnerIds: text('winner_ids').array().notNull().default(sql`ARRAY[]::text[]`),
    degradedProviders: text('degraded_providers').array().notNull().default(sql`ARRAY[]::text[]`),

    drawnAt: timestamp('drawn_at', { withTimezone: true }).notNull().defaultNow(),
    drawnBy: text('drawn_by').notNull(),
    reason: text('reason'),
  },
  // The second half of exactly-once: the state machine stops a concurrent draw, and this stops
  // anything that slipped past it from writing a second result for the same draw number.
  (t) => [uniqueIndex('giveaway_draws_unique').on(t.giveawayId, t.drawNumber)],
);

export const giveawayWins = pgTable(
  'giveaway_wins',
  {
    giveawayId: text('giveaway_id')
      .notNull()
      .references(() => giveaways.id, { onDelete: 'cascade' }),
    drawId: text('draw_id')
      .notNull()
      .references(() => giveawayDraws.id, { onDelete: 'cascade' }),
    userId: text('user_id').notNull(),

    claimedAt: timestamp('claimed_at', { withTimezone: true }),
    forfeitedAt: timestamp('forfeited_at', { withTimezone: true }),
    rerolledAt: timestamp('rerolled_at', { withTimezone: true }),
    claimDeadline: timestamp('claim_deadline', { withTimezone: true }),
  },
  (t) => [
    primaryKey({ name: 'giveaway_wins_pk', columns: [t.drawId, t.userId] }),
    index('giveaway_wins_recent_idx').on(t.giveawayId, t.userId),
  ],
);

export const giveawayTemplates = pgTable(
  'giveaway_templates',
  {
    id: text('id').primaryKey(),
    guildId: text('guild_id')
      .notNull()
      .references(() => guilds.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    payload: jsonb('payload').notNull(),
    createdBy: text('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('giveaway_templates_name').on(t.guildId, t.name)],
);

export const giveawayBlacklist = pgTable(
  'giveaway_blacklist',
  {
    guildId: text('guild_id')
      .notNull()
      .references(() => guilds.id, { onDelete: 'cascade' }),
    subjectType: text('subject_type').notNull(),
    subjectId: text('subject_id').notNull(),
    addedBy: text('added_by').notNull(),
    reason: text('reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({
      name: 'giveaway_blacklist_pk',
      columns: [t.guildId, t.subjectType, t.subjectId],
    }),
  ],
);

export type GiveawayRow = typeof giveaways.$inferSelect;
export type NewGiveawayRow = typeof giveaways.$inferInsert;
export type GiveawayRequirementRow = typeof giveawayRequirements.$inferSelect;
export type GiveawayMultiplierRow = typeof giveawayMultipliers.$inferSelect;
export type GiveawayEntryRow = typeof giveawayEntries.$inferSelect;
export type NewGiveawayEntryRow = typeof giveawayEntries.$inferInsert;
export type GiveawayDrawRow = typeof giveawayDraws.$inferSelect;
export type GiveawayWinRow = typeof giveawayWins.$inferSelect;
export type GiveawayTemplateRow = typeof giveawayTemplates.$inferSelect;
export type GiveawayBlacklistRow = typeof giveawayBlacklist.$inferSelect;
