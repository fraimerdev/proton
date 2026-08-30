import { guilds } from '@proton/db';
import { pgTable, primaryKey, text, timestamp } from 'drizzle-orm/pg-core';

export const counterChannels = pgTable(
  'counter_channels',
  {
    guildId: text('guild_id')
      .notNull()
      .references(() => guilds.id, { onDelete: 'cascade' }),

    counterId: text('counter_id').notNull(),
    channelId: text('channel_id').notNull(),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.guildId, t.counterId] })],
);

export type CounterChannelRow = typeof counterChannels.$inferSelect;
