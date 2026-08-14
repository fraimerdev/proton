import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { guilds } from './guilds.ts';

/**
 * The action ledger. Every state-changing Discord operation writes a row here
 * (PLAN.md P3) — there is no path that mutates a guild without leaving a case.
 */
export const cases = pgTable(
  'cases',
  {
    id: text('id').primaryKey(), // ulid
    guildId: text('guild_id')
      .notNull()
      .references(() => guilds.id, { onDelete: 'cascade' }),
    caseNumber: integer('case_number').notNull(),
    type: text('type').notNull(),
    actorId: text('actor_id'),
    targetId: text('target_id'),
    moderatorId: text('moderator_id'),
    reason: text('reason'),
    moduleId: text('module_id').notNull(),
    payload: jsonb('payload'),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    revertedAt: timestamp('reverted_at', { withTimezone: true }),
    revertedBy: text('reverted_by'),
    dryRun: boolean('dry_run').notNull().default(false),
    idempotencyKey: text('idempotency_key').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Human-facing per-guild case numbering.
    uniqueIndex('cases_guild_case_number_uq').on(t.guildId, t.caseNumber),

    // The database-level guarantee behind I4. Dedupe in Redis is the fast path;
    // this constraint is what makes double-execution impossible rather than
    // merely unlikely when Redis is cold, restarted or raced.
    uniqueIndex('cases_idempotency_key_uq').on(t.idempotencyKey),

    // "show me this user's history in this guild, newest first"
    index('cases_guild_target_created_idx').on(t.guildId, t.targetId, t.createdAt.desc()),

    // Partial index for the auto-reversal sweeper: only rows that still need
    // reverting are indexed, so it stays small no matter how large `cases` grows.
    index('cases_pending_expiry_idx')
      .on(t.expiresAt)
      .where(sql`${t.expiresAt} is not null and ${t.revertedAt} is null`),
  ],
);

export type Case = typeof cases.$inferSelect;
export type NewCase = typeof cases.$inferInsert;
