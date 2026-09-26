import type { LostCommandPermissions } from '@proton/core';
import { boolean, integer, jsonb, pgTable, primaryKey, text, timestamp } from 'drizzle-orm/pg-core';
import type {
  CommandRegistrationFailure,
  CommandRegistrationScope,
  RegisteredCommand,
} from '../command-registration-store.ts';
import { guilds } from './guilds.ts';

export const guildCommands = pgTable(
  'guild_commands',
  {
    guildId: text('guild_id')
      .notNull()
      .references(() => guilds.id, { onDelete: 'cascade' }),
    commandKey: text('command_key').notNull(),

    enabled: boolean('enabled').notNull().default(true),
    name: text('name'),
    description: text('description'),
    optionDescriptions: jsonb('option_descriptions')
      .$type<Record<string, string>>()
      .notNull()
      .default({}),
    privateReply: boolean('private_reply'),

    schemaVersion: integer('schema_version').notNull().default(1),
    updatedBy: text('updated_by'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.guildId, t.commandKey] })],
);

export const guildCommandRegistrations = pgTable('guild_command_registrations', {
  guildId: text('guild_id')
    .primaryKey()
    .references(() => guilds.id, { onDelete: 'cascade' }),

  scope: text('scope').$type<CommandRegistrationScope>().notNull(),
  definitionHash: text('definition_hash'),
  commands: jsonb('commands').$type<RegisteredCommand[]>().notNull().default([]),
  idHistory: jsonb('id_history').$type<Record<string, string>>().notNull().default({}),

  checkedAt: timestamp('checked_at', { withTimezone: true }),
  syncedAt: timestamp('synced_at', { withTimezone: true }),
  failure: jsonb('failure').$type<CommandRegistrationFailure>(),

  permissionsCheckedAt: timestamp('permissions_checked_at', { withTimezone: true }),
  lostPermissions: jsonb('lost_permissions').$type<LostCommandPermissions['commands']>(),
  lostPermissionsAt: timestamp('lost_permissions_at', { withTimezone: true }),
});

export type GuildCommandRow = typeof guildCommands.$inferSelect;
export type NewGuildCommandRow = typeof guildCommands.$inferInsert;
export type GuildCommandRegistrationRow = typeof guildCommandRegistrations.$inferSelect;
export type NewGuildCommandRegistrationRow = typeof guildCommandRegistrations.$inferInsert;
