import { pgTable, primaryKey, text, timestamp } from 'drizzle-orm/pg-core';

/**
 * Drizzle's view of `message_logs`.
 *
 * A mirror, not a source of truth. The table is declared by the hand-written
 * migration `packages/db/drizzle/0002_message_logs.sql`, because drizzle-kit
 * cannot express `PARTITION BY RANGE` and would generate an ordinary table
 * instead — one that behaves identically right up to the first retention sweep,
 * when expiring a month of message content stops being a `DROP TABLE` and
 * becomes a `DELETE` over everything.
 *
 * It lives in the module rather than in `packages/db/src/schema` precisely so
 * that drizzle-kit never sees it: the schema barrel is what `drizzle-kit
 * generate` diffs against, and a table it can see is a table it will "fix" by
 * emitting a CREATE TABLE without the partitioning. Changing the columns here
 * means changing that SQL file too, and the integration tests read back what
 * they wrote so the two cannot drift silently.
 *
 * The primary key is `(occurred_at, id)` rather than `id` because Postgres
 * requires the partition key in every unique constraint on a partitioned table.
 */
export const messageLogs = pgTable(
  'message_logs',
  {
    id: text('id').notNull(),
    guildId: text('guild_id').notNull(),
    channelId: text('channel_id').notNull(),
    messageId: text('message_id').notNull(),
    authorId: text('author_id'),
    kind: text('kind').notNull(),
    contentBefore: text('content_before'),
    contentAfter: text('content_after'),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
  },
  (t) => [primaryKey({ name: 'message_logs_pk', columns: [t.occurredAt, t.id] })],
);

export type MessageLogRow = typeof messageLogs.$inferSelect;
export type NewMessageLogRow = typeof messageLogs.$inferInsert;
