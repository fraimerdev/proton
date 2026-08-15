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

export const cases = pgTable(
  'cases',
  {
    id: text('id').primaryKey(),
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
    uniqueIndex('cases_guild_case_number_uq').on(t.guildId, t.caseNumber),

    uniqueIndex('cases_idempotency_key_uq').on(t.idempotencyKey),

    index('cases_guild_target_created_idx').on(t.guildId, t.targetId, t.createdAt.desc()),

    index('cases_pending_expiry_idx')
      .on(t.expiresAt)
      .where(sql`${t.expiresAt} is not null and ${t.revertedAt} is null`),
  ],
);

export type Case = typeof cases.$inferSelect;
export type NewCase = typeof cases.$inferInsert;
