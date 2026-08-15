import { integer, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

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
