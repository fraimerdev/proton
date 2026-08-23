import { guilds } from '@proton/db';
import { index, integer, pgTable, primaryKey, text, timestamp } from 'drizzle-orm/pg-core';

export const tags = pgTable(
  'tags',
  {
    guildId: text('guild_id')
      .notNull()
      .references(() => guilds.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    content: text('content').notNull(),
    createdBy: text('created_by').notNull(),
    updatedBy: text('updated_by'),
    uses: integer('uses').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: 'tags_pk', columns: [t.guildId, t.name] }),
    index('tags_guild_uses_idx').on(t.guildId, t.uses.desc()),
  ],
);

export type TagRow = typeof tags.$inferSelect;
export type NewTagRow = typeof tags.$inferInsert;
