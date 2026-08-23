import { guilds } from '@proton/db';
import { sql } from 'drizzle-orm';
import { index, integer, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';

export const tickets = pgTable(
  'tickets',
  {
    id: text('id').primaryKey(),
    guildId: text('guild_id')
      .notNull()
      .references(() => guilds.id, { onDelete: 'cascade' }),
    number: integer('number').notNull(),
    panelId: text('panel_id').notNull(),
    channelId: text('channel_id').notNull(),
    openerId: text('opener_id').notNull(),
    status: text('status').notNull().default('open'),
    openedAt: timestamp('opened_at', { withTimezone: true }).notNull().defaultNow(),
    lastActivityAt: timestamp('last_activity_at', { withTimezone: true }).notNull().defaultNow(),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    closedBy: text('closed_by'),
    closeReason: text('close_reason'),
  },
  (t) => [
    uniqueIndex('tickets_guild_number_uq').on(t.guildId, t.number),

    uniqueIndex('tickets_open_channel_uq')
      .on(t.guildId, t.channelId)
      .where(sql`${t.status} = 'open'`),

    index('tickets_guild_opener_open_idx')
      .on(t.guildId, t.openerId)
      .where(sql`${t.status} = 'open'`),
  ],
);

export type TicketRow = typeof tickets.$inferSelect;
export type NewTicketRow = typeof tickets.$inferInsert;
