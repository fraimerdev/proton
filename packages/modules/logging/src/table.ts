import { pgTable, primaryKey, text, timestamp } from 'drizzle-orm/pg-core';

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
