import { index, integer, jsonb, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { guilds } from './guilds.ts';

export const scheduledActions = pgTable(
  'scheduled_actions',
  {
    id: text('id').primaryKey(),
    guildId: text('guild_id')
      .notNull()
      .references(() => guilds.id, { onDelete: 'cascade' }),
    runAt: timestamp('run_at', { withTimezone: true }).notNull(),
    kind: text('kind').notNull(),
    payload: jsonb('payload'),
    attempts: integer('attempts').notNull().default(0),
    lockedUntil: timestamp('locked_until', { withTimezone: true }),
    idempotencyKey: text('idempotency_key').notNull(),
  },
  (t) => [
    uniqueIndex('scheduled_actions_idempotency_key_uq').on(t.idempotencyKey),
    index('scheduled_actions_due_idx').on(t.runAt),
  ],
);

export type ScheduledAction = typeof scheduledActions.$inferSelect;
export type NewScheduledAction = typeof scheduledActions.$inferInsert;
