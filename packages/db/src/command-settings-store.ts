import {
  COMMAND_SETTINGS_SCHEMA_VERSION,
  type CommandSettings,
  type CommandSettingsView,
  commandSettingsSchema,
} from '@proton/core';
import { and, asc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { DbHandle } from './client.ts';
import { auditTrail, type NewAuditTrailEntry } from './schema/audit-trail.ts';
import { type GuildCommandRow, guildCommands } from './schema/guild-commands.ts';

export type GuildCommandSettings = Record<string, CommandSettingsView>;

export type CommandSettingsAudit = Omit<NewAuditTrailEntry, 'guildId' | 'createdAt'>;

export interface CommandSettingsChange {
  next: CommandSettings;
  audit: CommandSettingsAudit;
}

export interface CommandSettingsWritten {
  settings: CommandSettingsView;
  guild: GuildCommandSettings;
}

export type CommandSettingsDecision = (
  current: GuildCommandSettings,
) => CommandSettingsChange | null | Promise<CommandSettingsChange | null>;

const optionDescriptionsSchema = z.record(z.string(), z.string());

export function toCommandSettingsView(row: GuildCommandRow): CommandSettingsView {
  const optionDescriptions = optionDescriptionsSchema.safeParse(row.optionDescriptions);

  const settings = commandSettingsSchema.parse({
    enabled: row.enabled,
    name: row.name,
    description: row.description,
    optionDescriptions: optionDescriptions.success ? optionDescriptions.data : {},
    privateReply: row.privateReply,
  });

  return { ...settings, updatedAt: row.updatedAt.toISOString() };
}

function toGuildSettings(rows: readonly GuildCommandRow[]): GuildCommandSettings {
  return Object.fromEntries(rows.map((row) => [row.commandKey, toCommandSettingsView(row)]));
}

export class DrizzleCommandSettingsStore {
  readonly #handle: DbHandle;

  constructor(handle: DbHandle) {
    this.#handle = handle;
  }

  async list(guildId: string): Promise<GuildCommandSettings> {
    const rows = await this.#handle.db
      .select()
      .from(guildCommands)
      .where(eq(guildCommands.guildId, guildId))
      .orderBy(asc(guildCommands.commandKey));

    return toGuildSettings(rows);
  }

  async get(guildId: string, key: string): Promise<CommandSettingsView | null> {
    const rows = await this.#handle.db
      .select()
      .from(guildCommands)
      .where(and(eq(guildCommands.guildId, guildId), eq(guildCommands.commandKey, key)))
      .limit(1);

    const row = rows[0];
    return row ? toCommandSettingsView(row) : null;
  }

  async write(
    guildId: string,
    key: string,
    decide: CommandSettingsDecision,
  ): Promise<CommandSettingsWritten | null> {
    return this.#handle.db.transaction(async (tx) => {
      // Before the read: two renames that both read first could each take the same free name.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`guild_commands:${guildId}`}))`);

      const current = toGuildSettings(
        await tx
          .select()
          .from(guildCommands)
          .where(eq(guildCommands.guildId, guildId))
          .orderBy(asc(guildCommands.commandKey)),
      );

      const decided = await decide(current);
      if (decided === null) return null;

      const next = commandSettingsSchema.parse(decided.next);
      const values = {
        enabled: next.enabled,
        name: next.name,
        description: next.description,
        optionDescriptions: next.optionDescriptions,
        privateReply: next.privateReply,
        schemaVersion: COMMAND_SETTINGS_SCHEMA_VERSION,
        updatedBy: decided.audit.actorId,
        // Not now(): that is when the transaction began, before it waited for the lock.
        updatedAt: sql`clock_timestamp()`,
      };

      const upserted = await tx
        .insert(guildCommands)
        .values({ guildId, commandKey: key, ...values })
        .onConflictDoUpdate({
          target: [guildCommands.guildId, guildCommands.commandKey],
          set: values,
        })
        .returning();

      const row = upserted[0];
      if (!row) {
        throw new Error('guild_commands upsert returned no row, which should not be possible');
      }

      await tx.insert(auditTrail).values({ ...decided.audit, guildId });

      const settings = toCommandSettingsView(row);
      return {
        settings,
        guild: Object.fromEntries([...Object.entries(current), [key, settings]]),
      };
    });
  }
}
