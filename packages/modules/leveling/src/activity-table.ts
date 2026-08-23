import { guilds } from '@proton/db';
import { date, index, integer, pgTable, primaryKey, text } from 'drizzle-orm/pg-core';

// members.message_count and members.voice_seconds are lifetime totals and always will be; a
// windowed condition ("100 messages in the last 30 days") cannot be answered from a running total,
// so activity is also bucketed by UTC day and the buckets are pruned past the widest window.
export const memberActivityDaily = pgTable(
  'member_activity_daily',
  {
    guildId: text('guild_id')
      .notNull()
      .references(() => guilds.id, { onDelete: 'cascade' }),
    userId: text('user_id').notNull(),
    day: date('day').notNull(),
    messageCount: integer('message_count').notNull().default(0),
    voiceSeconds: integer('voice_seconds').notNull().default(0),
  },
  (t) => [
    primaryKey({ name: 'member_activity_daily_pk', columns: [t.guildId, t.userId, t.day] }),
    index('member_activity_daily_window_idx').on(t.guildId, t.day),
  ],
);

export type MemberActivityRow = typeof memberActivityDaily.$inferSelect;
export type NewMemberActivityRow = typeof memberActivityDaily.$inferInsert;
