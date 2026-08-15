import { guilds } from '@proton/db';
import { integer, pgTable, primaryKey, text, timestamp } from 'drizzle-orm/pg-core';

/**
 * Drizzle's view of `starboard_posts`.
 *
 * A mirror, not a source of truth. The table is declared by
 * `packages/db/drizzle/0005_starboard.sql`, for the reason `logging` records
 * about `message_logs`: §7 gives a module its own `migrations`, and **nothing
 * runs them**. Until that gap is closed a module-owned table has to ship in the
 * core migration set, and listing the same DDL in `manifest.migrations` as well
 * would be two copies with no mechanism to keep them equal.
 *
 * It lives here rather than in `packages/db/src/schema` so drizzle-kit's diff
 * never sees it: the schema barrel is what `drizzle-kit generate` compares
 * against, and a table it can see is a table it will emit its own CREATE for —
 * a third copy of the same DDL, owned by nobody. The integration test reads back
 * what it writes, so this object and that file cannot drift silently.
 */
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
