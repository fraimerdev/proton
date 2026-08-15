import { guilds } from '@proton/db';
import { integer, pgTable, primaryKey, text, timestamp } from 'drizzle-orm/pg-core';

export const starboardPosts = pgTable(
  'starboard_posts',
  {
    guildId: text('guild_id')
      .notNull()
      .references(() => guilds.id, { onDelete: 'cascade' }),
    sourceMessageId: text('source_message_id').notNull(),
    boardMessageId: text('board_message_id').notNull(),
    starCount: integer('star_count').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ name: 'starboard_posts_pk', columns: [t.guildId, t.sourceMessageId] })],
);

export type StarboardPostRow = typeof starboardPosts.$inferSelect;
export type NewStarboardPostRow = typeof starboardPosts.$inferInsert;
