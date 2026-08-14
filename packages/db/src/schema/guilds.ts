import { integer, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

/**
 * Discord IDs are snowflakes — 64-bit values that exceed Number.MAX_SAFE_INTEGER.
 * They are stored as `text` throughout so they can never silently lose precision
 * on the way through JavaScript.
 */
export const guilds = pgTable('guilds', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  locale: text('locale').notNull().default('en-US'),
  tier: text('tier').notNull().default('free'),
  joinedAt: timestamp('joined_at', { withTimezone: true }).notNull().defaultNow(),
  leftAt: timestamp('left_at', { withTimezone: true }),
  shardId: integer('shard_id'),
});

export type Guild = typeof guilds.$inferSelect;
export type NewGuild = typeof guilds.$inferInsert;
