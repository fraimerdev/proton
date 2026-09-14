import { guilds } from '@proton/db';
import { index, pgTable, primaryKey, text, timestamp } from 'drizzle-orm/pg-core';

export const afkStatuses = pgTable(
  'afk_statuses',
  {
    guildId: text('guild_id')
      .notNull()
      .references(() => guilds.id, { onDelete: 'cascade' }),
    userId: text('user_id').notNull(),
    sessionId: text('session_id').notNull().unique(),
    reason: text('reason'),
    since: timestamp('since', { withTimezone: true }).notNull(),
    previousNick: text('previous_nick'),
    appliedNick: text('applied_nick'),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    endedBy: text('ended_by'),
  },
  (t) => [primaryKey({ columns: [t.guildId, t.userId] })],
);

export type AfkStatusRow = typeof afkStatuses.$inferSelect;

export const afkPings = pgTable(
  'afk_pings',
  {
    sessionId: text('session_id').notNull(),
    guildId: text('guild_id')
      .notNull()
      .references(() => guilds.id, { onDelete: 'cascade' }),
    userId: text('user_id').notNull(),
    messageId: text('message_id').notNull(),
    channelId: text('channel_id').notNull(),
    authorId: text('author_id').notNull(),
    pingedAt: timestamp('pinged_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.sessionId, t.messageId] }),
    index('afk_pings_guild_user_idx').on(t.guildId, t.userId),
  ],
);

export type AfkPingRow = typeof afkPings.$inferSelect;
