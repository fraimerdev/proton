import { integer, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { guilds } from './guilds.ts';

export const backups = pgTable('backups', {
  id: text('id').primaryKey(),
  guildId: text('guild_id')
    .notNull()
    .references(() => guilds.id, { onDelete: 'cascade' }),
  version: integer('version').notNull().default(1),
  snapshot: jsonb('snapshot'),
  s3Key: text('s3_key'),
  createdBy: text('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export type Backup = typeof backups.$inferSelect;
export type NewBackup = typeof backups.$inferInsert;
