import { boolean, integer, jsonb, pgTable, primaryKey, text, timestamp } from 'drizzle-orm/pg-core';
import { guilds } from './guilds.ts';

/**
 * Per-guild module configuration.
 *
 * `config` is validated against the owning module's Zod schema on every read and
 * every write (PLAN.md I5) — the JSONB column is storage, never a trust boundary.
 * `schemaVersion` records which revision of that schema the stored shape matches,
 * so configs saved by an older deploy are migrated forward lazily on read.
 */
export const guildModules = pgTable(
  'guild_modules',
  {
    guildId: text('guild_id')
      .notNull()
      .references(() => guilds.id, { onDelete: 'cascade' }),
    moduleId: text('module_id').notNull(),
    enabled: boolean('enabled').notNull().default(false),
    config: jsonb('config').notNull().default({}),
    schemaVersion: integer('schema_version').notNull().default(1),
    updatedBy: text('updated_by'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.guildId, t.moduleId] })],
);

export type GuildModule = typeof guildModules.$inferSelect;
export type NewGuildModule = typeof guildModules.$inferInsert;
