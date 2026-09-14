import { guilds } from '@proton/db';
import { index, integer, pgTable, primaryKey, text, timestamp } from 'drizzle-orm/pg-core';

export const xpEvents = pgTable(
  'xp_events',
  {
    guildId: text('guild_id')
      .notNull()
      .references(() => guilds.id, { onDelete: 'cascade' }),
    id: text('id').notNull(),
    multiplierTenths: integer('multiplier_tenths').notNull(),
    startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
    endsAt: timestamp('ends_at', { withTimezone: true }).notNull(),
    createdBy: text('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.guildId, t.id] }),
    index('xp_events_guild_ends_idx').on(t.guildId, t.endsAt),
  ],
);

export type XpEventRow = typeof xpEvents.$inferSelect;
