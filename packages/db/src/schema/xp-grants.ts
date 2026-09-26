import type { Causation } from '@proton/core';
import { integer, jsonb, pgTable, primaryKey, text, timestamp } from 'drizzle-orm/pg-core';
import { guilds } from './guilds.ts';

export const xpGrants = pgTable(
  'xp_grants',
  {
    guildId: text('guild_id')
      .notNull()
      .references(() => guilds.id, { onDelete: 'cascade' }),
    grantId: text('grant_id').notNull(),
    userId: text('user_id').notNull(),

    amount: integer('amount').notNull(),
    sourceModule: text('source_module').notNull(),
    causation: jsonb('causation').$type<Causation>().notNull(),

    previousLevel: integer('previous_level').notNull(),
    level: integer('level').notNull(),
    xpAfter: integer('xp_after').notNull(),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.guildId, t.grantId] })],
);

export type XpGrantRow = typeof xpGrants.$inferSelect;
export type NewXpGrantRow = typeof xpGrants.$inferInsert;
