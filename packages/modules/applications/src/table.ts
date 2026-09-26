import { guilds } from '@proton/db';
import { sql } from 'drizzle-orm';
import {
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

export const applicationFormVersions = pgTable(
  'application_form_versions',
  {
    id: text('id').primaryKey(),
    guildId: guildId(),
    formId: text('form_id').notNull(),
    version: integer('version').notNull(),
    snapshot: jsonb('snapshot').notNull(),
    draftPolicy: text('draft_policy').notNull().default('keep'),
    publishedBy: text('published_by').notNull(),
    publishedAt: instant('published_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('application_form_versions_guild_form_version_uq').on(
      t.guildId,
      t.formId,
      t.version,
    ),
    index('application_form_versions_guild_form_idx').on(t.guildId, t.formId, t.version.desc()),
  ],
);

export type ApplicationFormVersionRow = typeof applicationFormVersions.$inferSelect;

export const applications = pgTable(
  'applications',
  {
    id: text('id').primaryKey(),
    guildId: guildId(),
    number: integer('number'),
    formId: text('form_id').notNull(),
    versionId: text('version_id')
      .notNull()
      .references(() => applicationFormVersions.id, { onDelete: 'cascade' }),
    applicantId: text('applicant_id').notNull(),
    applicantName: text('applicant_name'),
    status: text('status').notNull().default('draft'),
    revision: integer('revision').notNull().default(0),
    draft: jsonb('draft').notNull().default(sql`'{}'::jsonb`),
    step: integer('step').notNull().default(0),
    answers: jsonb('answers'),
    source: text('source'),
    assigneeId: text('assignee_id'),
    assignedAt: instant('assigned_at'),
    submittedAt: instant('submitted_at'),
    reviewStartedAt: instant('review_started_at'),
    infoRequestedAt: instant('info_requested_at'),
    infoDueAt: instant('info_due_at'),
    waitlistedAt: instant('waitlisted_at'),
    decidedAt: instant('decided_at'),
    decidedBy: text('decided_by'),
    decisionReason: text('decision_reason'),
    withdrawnAt: instant('withdrawn_at'),
    reopenedCount: integer('reopened_count').notNull().default(0),
    archivedAt: instant('archived_at'),
    expiresAt: instant('expires_at'),
    reviewDueAt: instant('review_due_at'),
    remindedAt: instant('reminded_at'),
    contentPurgeAt: instant('content_purge_at'),
    contentPurgedAt: instant('content_purged_at'),
    deletedAt: instant('deleted_at'),
    dmChannelId: text('dm_channel_id'),
    cardChannelId: text('card_channel_id'),
    cardMessageId: text('card_message_id'),
    cardRevision: integer('card_revision').notNull().default(-1),
    interviewTicketId: text('interview_ticket_id'),
    interviewChannelId: text('interview_channel_id'),
    createdAt: instant('created_at').notNull().defaultNow(),
    updatedAt: instant('updated_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('applications_guild_number_uq')
      .on(t.guildId, t.number)
      .where(sql`${t.number} is not null`),
    uniqueIndex('applications_one_draft_uq')
      .on(t.guildId, t.formId, t.applicantId)
      .where(sql`${t.status} = 'draft'`),
    index('applications_guild_status_submitted_idx').on(t.guildId, t.status, t.submittedAt.desc()),
    index('applications_guild_form_status_idx').on(t.guildId, t.formId, t.status),
    index('applications_guild_applicant_created_idx').on(
      t.guildId,
      t.applicantId,
      t.createdAt.desc(),
    ),
    index('applications_applicant_created_idx').on(t.applicantId, t.createdAt.desc()),
    index('applications_guild_assignee_idx')
      .on(t.guildId, t.assigneeId)
      .where(sql`${t.status} in ('submitted', 'in_review', 'needs_info', 'waitlisted')`),
    index('applications_draft_expiry_idx').on(t.expiresAt).where(sql`${t.status} = 'draft'`),
    index('applications_content_purge_idx')
      .on(t.contentPurgeAt)
      .where(sql`${t.contentPurgedAt} is null`),
    index('applications_review_due_idx')
      .on(t.guildId, t.reviewDueAt)
      .where(sql`${t.remindedAt} is null and ${t.status} in ('submitted', 'in_review')`),
    index('applications_info_due_idx')
      .on(t.guildId, t.infoDueAt)
      .where(sql`${t.status} = 'needs_info'`),
  ],
);

export type ApplicationRow = typeof applications.$inferSelect;

function applicationId() {
  return text('application_id')
    .notNull()
    .references(() => applications.id, { onDelete: 'cascade' });
}

export const applicationEvents = pgTable(
  'application_events',
  {
    id: text('id').primaryKey(),
    guildId: guildId(),
    applicationId: applicationId(),
    kind: text('kind').notNull(),
    actorId: text('actor_id').notNull(),
    source: text('source').notNull(),
    fromStatus: text('from_status'),
    toStatus: text('to_status'),
    revision: integer('revision').notNull(),
    data: jsonb('data').notNull().default(sql`'{}'::jsonb`),
    createdAt: instant('created_at').notNull().defaultNow(),
  },
  (t) => [index('application_events_application_created_idx').on(t.applicationId, t.createdAt)],
);

export type ApplicationEventRow = typeof applicationEvents.$inferSelect;

export const applicationThread = pgTable(
  'application_thread',
  {
    id: text('id').primaryKey(),
    guildId: guildId(),
    applicationId: applicationId(),
    kind: text('kind').notNull(),
    authorId: text('author_id').notNull(),
    body: text('body'),
    revision: integer('revision').notNull(),
    createdAt: instant('created_at').notNull().defaultNow(),
  },
  (t) => [index('application_thread_application_created_idx').on(t.applicationId, t.createdAt)],
);

export type ApplicationThreadRow = typeof applicationThread.$inferSelect;

export const applicationNotes = pgTable(
  'application_notes',
  {
    id: text('id').primaryKey(),
    guildId: guildId(),
    applicationId: applicationId(),
    authorId: text('author_id').notNull(),
    body: text('body'),
    createdAt: instant('created_at').notNull().defaultNow(),
  },
  (t) => [index('application_notes_application_created_idx').on(t.applicationId, t.createdAt)],
);

export type ApplicationNoteRow = typeof applicationNotes.$inferSelect;

export const applicationVotes = pgTable(
  'application_votes',
  {
    guildId: guildId(),
    applicationId: applicationId(),
    reviewerId: text('reviewer_id').notNull(),
    vote: text('vote').notNull(),
    score: integer('score'),
    createdAt: instant('created_at').notNull().defaultNow(),
    updatedAt: instant('updated_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ name: 'application_votes_pk', columns: [t.applicationId, t.reviewerId] })],
);

export type ApplicationVoteRow = typeof applicationVotes.$inferSelect;

export const applicationEffects = pgTable(
  'application_effects',
  {
    id: text('id').primaryKey(),
    guildId: guildId(),
    applicationId: applicationId(),
    key: text('key').notNull(),
    kind: text('kind').notNull(),
    trigger: text('trigger').notNull(),
    revision: integer('revision').notNull(),
    params: jsonb('params').notNull().default(sql`'{}'::jsonb`),
    status: text('status').notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    claimSeq: integer('claim_seq').notNull().default(0),
    leaseUntil: instant('lease_until'),
    nextAttemptAt: instant('next_attempt_at').notNull().defaultNow(),
    result: jsonb('result').notNull().default(sql`'{}'::jsonb`),
    errorCode: text('error_code'),
    error: text('error'),
    createdAt: instant('created_at').notNull().defaultNow(),
    updatedAt: instant('updated_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('application_effects_application_key_uq').on(t.applicationId, t.key),
    index('application_effects_guild_status_due_idx').on(t.guildId, t.status, t.nextAttemptAt),
  ],
);

export type ApplicationEffectRow = typeof applicationEffects.$inferSelect;

export const applicationRoleGrants = pgTable(
  'application_role_grants',
  {
    guildId: guildId(),
    applicationId: applicationId(),
    userId: text('user_id').notNull(),
    roleId: text('role_id').notNull(),
    grantedAt: instant('granted_at').notNull().defaultNow(),
    removedAt: instant('removed_at'),
  },
  (t) => [primaryKey({ name: 'application_role_grants_pk', columns: [t.applicationId, t.roleId] })],
);

export type ApplicationRoleGrantRow = typeof applicationRoleGrants.$inferSelect;
