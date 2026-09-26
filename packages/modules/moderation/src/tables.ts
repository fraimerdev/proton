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

export const reports = pgTable(
  'reports',
  {
    id: text('id').primaryKey(),
    guildId: text('guild_id')
      .notNull()
      .references(() => guilds.id, { onDelete: 'cascade' }),
    number: integer('number').notNull(),
    reporterId: text('reporter_id').notNull(),
    targetId: text('target_id').notNull(),
    method: text('method').notNull(),
    status: text('status').notNull().default('open'),

    reasonId: text('reason_id'),
    reason: text('reason'),
    customReason: text('custom_reason'),
    comment: text('comment'),

    sourceChannelId: text('source_channel_id'),
    sourceMessageId: text('source_message_id'),
    sourceAuthorId: text('source_author_id'),

    evidence: jsonb('evidence').notNull().default(sql`'{}'::jsonb`),
    evidenceExpiresAt: timestamp('evidence_expires_at', { withTimezone: true }),
    evidencePurgedAt: timestamp('evidence_purged_at', { withTimezone: true }),

    assigneeId: text('assignee_id'),
    assignedAt: timestamp('assigned_at', { withTimezone: true }),
    resolvedBy: text('resolved_by'),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    resolutionNote: text('resolution_note'),
    reporterNote: text('reporter_note'),
    actionKind: text('action_kind'),
    caseIds: text('case_ids').array().notNull().default(sql`ARRAY[]::text[]`),

    cardChannelId: text('card_channel_id'),
    cardMessageId: text('card_message_id'),
    evidenceMessageId: text('evidence_message_id'),
    cardState: text('card_state').notNull().default('pending'),
    cardError: text('card_error'),
    cardAttempts: integer('card_attempts').notNull().default(0),
    cardVersion: integer('card_version').notNull().default(0),
    cardEditAttempts: integer('card_edit_attempts').notNull().default(0),

    closeAction: text('close_action'),
    closeDueAt: timestamp('close_due_at', { withTimezone: true }),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    closeAttempts: integer('close_attempts').notNull().default(0),
    closeError: text('close_error'),

    decisionToken: text('decision_token'),
    decisionKind: text('decision_kind'),
    decisionStartedAt: timestamp('decision_started_at', { withTimezone: true }),

    notifications: jsonb('notifications').notNull().default(sql`'{}'::jsonb`),
    dmChannelId: text('dm_channel_id'),
    dmAttempts: integer('dm_attempts').notNull().default(0),

    version: integer('version').notNull().default(0),
    idempotencyKey: text('idempotency_key').notNull(),

    createdAt: timestamp('created_at', { withTimezone: true, precision: 3 }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('reports_guild_number_uq').on(t.guildId, t.number),
    uniqueIndex('reports_idempotency_key_uq').on(t.idempotencyKey),
    index('reports_guild_status_created_idx').on(t.guildId, t.status, t.createdAt.desc()),
    index('reports_guild_target_created_idx').on(t.guildId, t.targetId, t.createdAt.desc()),
    index('reports_guild_reporter_created_idx').on(t.guildId, t.reporterId, t.createdAt.desc()),
    index('reports_guild_card_message_idx')
      .on(t.guildId, t.cardMessageId)
      .where(sql`${t.cardMessageId} is not null`),
    index('reports_evidence_expiry_idx')
      .on(t.evidenceExpiresAt)
      .where(sql`${t.evidencePurgedAt} is null and ${t.evidenceExpiresAt} is not null`),
    index('reports_close_due_idx')
      .on(t.guildId, t.closeDueAt)
      .where(sql`${t.closedAt} is null and ${t.closeDueAt} is not null`),
  ],
);

export type ReportRow = typeof reports.$inferSelect;
export type NewReportRow = typeof reports.$inferInsert;

export const reportEvents = pgTable(
  'report_events',
  {
    id: text('id').primaryKey(),
    reportId: text('report_id')
      .notNull()
      .references(() => reports.id, { onDelete: 'cascade' }),
    guildId: text('guild_id')
      .notNull()
      .references(() => guilds.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    actorId: text('actor_id'),
    source: text('source').notNull(),
    data: jsonb('data').notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('report_events_report_created_idx').on(t.reportId, t.createdAt)],
);

export type ReportEventRow = typeof reportEvents.$inferSelect;
export type NewReportEventRow = typeof reportEvents.$inferInsert;

export const reportAutomationRuns = pgTable(
  'report_automation_runs',
  {
    id: text('id').primaryKey(),
    guildId: text('guild_id')
      .notNull()
      .references(() => guilds.id, { onDelete: 'cascade' }),
    ruleId: text('rule_id').notNull(),
    ruleName: text('rule_name').notNull(),
    targetId: text('target_id').notNull(),
    episodeStart: timestamp('episode_start', { withTimezone: true, precision: 3 }).notNull(),
    coveredUntil: timestamp('covered_until', { withTimezone: true, precision: 3 }).notNull(),
    reportIds: text('report_ids').array().notNull().default(sql`ARRAY[]::text[]`),
    status: text('status').notNull().default('running'),
    leaseUntil: timestamp('lease_until', { withTimezone: true }).notNull(),
    outcomes: jsonb('outcomes').notNull().default(sql`'[]'::jsonb`),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('report_automation_runs_episode_uq').on(
      t.guildId,
      t.ruleId,
      t.targetId,
      t.episodeStart,
    ),
    index('report_automation_runs_guild_created_idx').on(t.guildId, t.createdAt.desc()),
    index('report_automation_runs_running_idx')
      .on(t.guildId, t.createdAt)
      .where(sql`${t.status} = 'running'`),
  ],
);

export type ReportAutomationRunRow = typeof reportAutomationRuns.$inferSelect;
export type NewReportAutomationRunRow = typeof reportAutomationRuns.$inferInsert;

export const moderationTimeouts = pgTable(
  'moderation_timeouts',
  {
    caseId: text('case_id').primaryKey(),
    guildId: text('guild_id')
      .notNull()
      .references(() => guilds.id, { onDelete: 'cascade' }),
    userId: text('user_id').notNull(),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
    endsAt: timestamp('ends_at', { withTimezone: true }).notNull(),
    appliedUntil: timestamp('applied_until', { withTimezone: true }),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    closedBy: text('closed_by'),
    closeReason: text('close_reason'),
    expiryLoggedAt: timestamp('expiry_logged_at', { withTimezone: true }),
  },
  (t) => [
    index('moderation_timeouts_open_idx').on(t.guildId, t.userId).where(sql`${t.closedAt} is null`),
  ],
);

export type ModerationTimeoutRow = typeof moderationTimeouts.$inferSelect;
export type NewModerationTimeoutRow = typeof moderationTimeouts.$inferInsert;

export const moderationCaseMessages = pgTable(
  'moderation_case_messages',
  {
    caseId: text('case_id').notNull(),
    messageId: text('message_id').notNull(),
    guildId: text('guild_id')
      .notNull()
      .references(() => guilds.id, { onDelete: 'cascade' }),
    channelId: text('channel_id').notNull(),
    authorId: text('author_id').notNull(),
    content: text('content').notNull().default(''),
    attachments: jsonb('attachments').notNull().default(sql`'[]'::jsonb`),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    proof: boolean('proof').notNull().default(false),
    capturedAt: timestamp('captured_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    primaryKey({ name: 'moderation_case_messages_pk', columns: [t.caseId, t.messageId] }),
    index('moderation_case_messages_guild_case_idx').on(t.guildId, t.caseId),
    index('moderation_case_messages_expiry_idx').on(t.expiresAt),
  ],
);

export type ModerationCaseMessageRow = typeof moderationCaseMessages.$inferSelect;
export type NewModerationCaseMessageRow = typeof moderationCaseMessages.$inferInsert;
