import { guilds } from '@proton/db';
import {
  index,
  integer,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

export const suggestions = pgTable(
  'suggestions',
  {
    id: text('id').primaryKey(),
    guildId: text('guild_id')
      .notNull()
      .references(() => guilds.id, { onDelete: 'cascade' }),
    number: integer('number').notNull(),
    channelId: text('channel_id').notNull(),
    messageId: text('message_id'),
    threadId: text('thread_id'),
    authorId: text('author_id').notNull(),
    content: text('content').notNull(),
    status: text('status').notNull().default('open'),
    decidedBy: text('decided_by'),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    decisionReason: text('decision_reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('suggestions_guild_number_uq').on(t.guildId, t.number),
    index('suggestions_guild_status_idx').on(t.guildId, t.status),
  ],
);

export const suggestionVotes = pgTable(
  'suggestion_votes',
  {
    suggestionId: text('suggestion_id')
      .notNull()
      .references(() => suggestions.id, { onDelete: 'cascade' }),
    userId: text('user_id').notNull(),
    vote: smallint('vote').notNull(),
  },
  (t) => [primaryKey({ name: 'suggestion_votes_pk', columns: [t.suggestionId, t.userId] })],
);

export type SuggestionRow = typeof suggestions.$inferSelect;
export type NewSuggestionRow = typeof suggestions.$inferInsert;
export type SuggestionVoteRow = typeof suggestionVotes.$inferSelect;
export type NewSuggestionVoteRow = typeof suggestionVotes.$inferInsert;
