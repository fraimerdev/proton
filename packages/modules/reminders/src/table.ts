import { guilds } from '@proton/db';
import { sql } from 'drizzle-orm';
import { index, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

export const reminders = pgTable(
  'reminders',
  {
    id: text('id').primaryKey(),
    guildId: text('guild_id')
      .notNull()
      .references(() => guilds.id, { onDelete: 'cascade' }),
    userId: text('user_id').notNull(),
    channelId: text('channel_id').notNull(),
    content: text('content').notNull(),
    remindAt: timestamp('remind_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
  },
  (t) => [
    index('reminders_guild_user_pending_idx')
      .on(t.guildId, t.userId)
      .where(sql`${t.deliveredAt} is null`),
    index('reminders_due_idx').on(t.remindAt).where(sql`${t.deliveredAt} is null`),
  ],
);

export type ReminderRow = typeof reminders.$inferSelect;
export type NewReminderRow = typeof reminders.$inferInsert;
