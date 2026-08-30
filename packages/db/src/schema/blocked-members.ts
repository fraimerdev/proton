import type { BlockedEvidence } from '@proton/core';
import { sql } from 'drizzle-orm';
import { index, jsonb, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { guilds } from './guilds.ts';

export const blockedMembers = pgTable(
  'blocked_members',
  {
    id: text('id').primaryKey(),
    guildId: text('guild_id')
      .notNull()
      .references(() => guilds.id, { onDelete: 'cascade' }),
    userId: text('user_id').notNull(),

    moduleId: text('module_id').notNull(),
    blockedBy: text('blocked_by').notNull(),
    reason: text('reason').notNull(),

    caseId: text('case_id'),
    evidence: jsonb('evidence').$type<BlockedEvidence>(),

    idempotencyKey: text('idempotency_key').notNull(),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),

    liftedAt: timestamp('lifted_at', { withTimezone: true }),
    liftedBy: text('lifted_by'),
    liftReason: text('lift_reason'),
  },
  (t) => [
    // Deliberately not partial. A RESUME redelivery of the event that blocked this member arrives
    // after a moderator may already have lifted it, and a partial index would let it re-block them.
    uniqueIndex('blocked_members_idempotency_key_uq').on(t.idempotencyKey),

    uniqueIndex('blocked_members_live_uq')
      .on(t.guildId, t.userId)
      .where(sql`${t.liftedAt} is null`),

    index('blocked_members_guild_created_idx').on(t.guildId, t.createdAt.desc()),
  ],
);

export type BlockedMemberRow = typeof blockedMembers.$inferSelect;
export type NewBlockedMemberRow = typeof blockedMembers.$inferInsert;
