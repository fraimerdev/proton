import { guilds } from '@proton/db';
import { sql } from 'drizzle-orm';
import { index, pgTable, primaryKey, text, timestamp } from 'drizzle-orm/pg-core';

export const polls = pgTable(
  'polls',
  {
    guildId: text('guild_id')
      .notNull()
      .references(() => guilds.id, { onDelete: 'cascade' }),
    channelId: text('channel_id').notNull(),
    messageId: text('message_id').notNull(),
    createdBy: text('created_by').notNull(),
    question: text('question').notNull(),
    endsAt: timestamp('ends_at', { withTimezone: true }).notNull(),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    announceChannelId: text('announce_channel_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: 'polls_pk', columns: [t.guildId, t.messageId] }),

    index('polls_guild_running_idx').on(t.guildId).where(sql`${t.endedAt} is null`),
  ],
);

export type PollRow = typeof polls.$inferSelect;
export type NewPollRow = typeof polls.$inferInsert;
