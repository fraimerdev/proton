import {
  commandKindSchema,
  commandSyncFailureSchema,
  type LostCommandPermissions,
  lostCommandPermissionsSchema,
  recordedCommandSchema,
} from '@proton/core';
import { and, eq, exists, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { DbHandle } from './client.ts';
import { auditTrail, type NewAuditTrailEntry } from './schema/audit-trail.ts';
import {
  type GuildCommandRegistrationRow,
  guildCommandRegistrations,
} from './schema/guild-commands.ts';
import { guilds } from './schema/guilds.ts';

export const ID_HISTORY_MAX = 1000;

export const COMMAND_REGISTRATION_SCOPES = ['guild', 'every-guild'] as const;

export const commandRegistrationScopeSchema = z.enum(COMMAND_REGISTRATION_SCOPES);

export type CommandRegistrationScope = z.infer<typeof commandRegistrationScopeSchema>;

export const registeredCommandSchema = recordedCommandSchema.extend({ kind: commandKindSchema });

export type RegisteredCommand = z.infer<typeof registeredCommandSchema>;

const timestampSchema = z.iso.datetime({ offset: true });

export const commandRegistrationFailureSchema = commandSyncFailureSchema.extend({
  at: timestampSchema,
  retryAt: timestampSchema.nullable(),
  hash: z.string().nullable(),
});

export type CommandRegistrationFailure = z.infer<typeof commandRegistrationFailureSchema>;

const lostCommandsSchema = lostCommandPermissionsSchema.shape.commands;

export const commandRegistrationRecordSchema = z.object({
  guildId: z.string(),
  scope: commandRegistrationScopeSchema,
  definitionHash: z.string().nullable(),
  commands: z.array(registeredCommandSchema),
  idHistory: z.record(z.string(), z.string()),
  checkedAt: z.string().nullable(),
  syncedAt: z.string().nullable(),
  failure: commandRegistrationFailureSchema.nullable(),
  permissionsCheckedAt: z.string().nullable(),
  lostPermissions: lostCommandPermissionsSchema.nullable(),
});

export type CommandRegistrationRecord = z.infer<typeof commandRegistrationRecordSchema>;

export const commandRegistrationSuccessSchema = z.object({
  scope: commandRegistrationScopeSchema,
  hash: z.string().min(1),
  commands: z.array(registeredCommandSchema),
  checkedAt: timestampSchema.optional(),
});

export const commandRegistrationCheckSchema = z.object({
  scope: commandRegistrationScopeSchema,
  hash: z.string().min(1),
  checkedAt: timestampSchema.optional(),
});

export const commandRegistrationFailedSchema = z.object({
  scope: commandRegistrationScopeSchema,
  failure: commandRegistrationFailureSchema,
  checkedAt: timestampSchema.optional(),
});

export const commandRegistrationHeldSchema = z.object({
  scope: commandRegistrationScopeSchema,
  hash: z.string().min(1),
  checkedAt: timestampSchema.optional(),
});

export const commandPermissionsCheckSchema = z.object({
  scope: commandRegistrationScopeSchema,
  lost: lostCommandsSchema,
  at: timestampSchema,
});

export const staleGuildsOptionsSchema = z.object({
  onlyGuildId: z.string().min(1).optional(),
  includeUnchecked: z.boolean().default(false),
});

export type CommandRegistrationSuccess = z.input<typeof commandRegistrationSuccessSchema>;
export type CommandRegistrationCheck = z.input<typeof commandRegistrationCheckSchema>;
export type CommandRegistrationFailed = z.input<typeof commandRegistrationFailedSchema>;
export type CommandRegistrationHeld = z.input<typeof commandRegistrationHeldSchema>;
export type CommandPermissionsCheck = z.input<typeof commandPermissionsCheckSchema>;
export type StaleGuildsOptions = z.input<typeof staleGuildsOptionsSchema>;

export type LostPermissionsAudit = (
  acked: LostCommandPermissions,
) => Omit<NewAuditTrailEntry, 'guildId' | 'createdAt'>;

const idHistorySchema = z.record(z.string(), z.string());

const clockRowSchema = z.object({ now: z.coerce.date() });

function iso(value: Date | null): string | null {
  return value === null ? null : value.toISOString();
}

function lostOf(commands: unknown, at: Date | null): LostCommandPermissions | null {
  const parsed = lostCommandPermissionsSchema.safeParse({ commands, at: iso(at) });
  return parsed.success && parsed.data.commands.length > 0 ? parsed.data : null;
}

export function toRegistrationRecord(
  row: GuildCommandRegistrationRow,
): CommandRegistrationRecord | null {
  const scope = commandRegistrationScopeSchema.safeParse(row.scope);
  if (!scope.success) return null;

  const commands = z.array(registeredCommandSchema).safeParse(row.commands);
  const idHistory = idHistorySchema.safeParse(row.idHistory);
  const failure = commandRegistrationFailureSchema.safeParse(row.failure);

  return {
    guildId: row.guildId,
    scope: scope.data,
    definitionHash: row.definitionHash,
    commands: commands.success ? commands.data : [],
    idHistory: idHistory.success ? idHistory.data : {},
    checkedAt: iso(row.checkedAt),
    syncedAt: iso(row.syncedAt),
    failure: failure.success ? failure.data : null,
    permissionsCheckedAt: iso(row.permissionsCheckedAt),
    lostPermissions: lostOf(row.lostPermissions, row.lostPermissionsAt),
  };
}

export class DrizzleCommandRegistrationStore {
  readonly #handle: DbHandle;

  constructor(handle: DbHandle) {
    this.#handle = handle;
  }

  async get(guildId: string): Promise<CommandRegistrationRecord | null> {
    const rows = await this.#handle.db
      .select()
      .from(guildCommandRegistrations)
      .where(eq(guildCommandRegistrations.guildId, guildId))
      .limit(1);

    const row = rows[0];
    return row ? toRegistrationRecord(row) : null;
  }

  async now(): Promise<string> {
    const rows = await this.#handle.client<{ now: unknown }[]>`select clock_timestamp() as now`;
    return clockRowSchema.parse(rows[0]).now.toISOString();
  }

  async recordSuccess(guildId: string, input: CommandRegistrationSuccess): Promise<boolean> {
    const values = commandRegistrationSuccessSchema.parse(input);
    const ids = JSON.stringify(
      Object.fromEntries(values.commands.map((command) => [command.id, command.key])),
    );

    // Length first sorts snowflakes by age; ids Discord just returned are never capped out.
    const rows = await this.#handle.client<{ guild_id: string }[]>`
      insert into guild_command_registrations as r
             (guild_id, scope, definition_hash, commands, id_history, checked_at, synced_at,
              failure)
      select ${guildId}::text, ${values.scope}::text, ${values.hash}::text,
             ${JSON.stringify(values.commands)}::jsonb, ${ids}::jsonb,
             coalesce(${values.checkedAt ?? null}::timestamptz, now()), now(), null::jsonb
       where exists (select 1 from guilds g where g.id = ${guildId} and g.left_at is null)
      on conflict (guild_id) do update
         set scope = excluded.scope,
             definition_hash = excluded.definition_hash,
             commands = excluded.commands,
             id_history = (
               select coalesce(jsonb_object_agg(h.key, h.value), '{}'::jsonb)
                 from (select e.key, e.value
                         from jsonb_each(r.id_history || ${ids}::jsonb) e
                        order by (${ids}::jsonb ? e.key) desc, length(e.key) desc, e.key desc
                        limit ${ID_HISTORY_MAX}) h
             ),
             checked_at = excluded.checked_at,
             synced_at = excluded.synced_at,
             failure = null
      returning guild_id`;

    return rows.length > 0;
  }

  async recordChecked(guildId: string, input: CommandRegistrationCheck): Promise<boolean> {
    const values = commandRegistrationCheckSchema.parse(input);
    const table = guildCommandRegistrations;

    const rows = await this.#handle.db
      .update(table)
      .set({
        scope: values.scope,
        checkedAt:
          values.checkedAt === undefined ? sql`now()` : sql`${values.checkedAt}::timestamptz`,
      })
      .where(
        and(
          eq(table.guildId, guildId),
          eq(table.definitionHash, values.hash),
          exists(
            this.#handle.db
              .select({ id: guilds.id })
              .from(guilds)
              .where(and(eq(guilds.id, guildId), isNull(guilds.leftAt))),
          ),
        ),
      )
      .returning({ guildId: table.guildId });

    return rows.length > 0;
  }

  async recordFailure(guildId: string, input: CommandRegistrationFailed): Promise<boolean> {
    const values = commandRegistrationFailedSchema.parse(input);

    const rows = await this.#handle.client<{ guild_id: string }[]>`
      insert into guild_command_registrations as r
             (guild_id, scope, definition_hash, failure, checked_at)
      select ${guildId}::text, ${values.scope}::text, null::text,
             ${JSON.stringify(values.failure)}::jsonb,
             coalesce(${values.checkedAt ?? null}::timestamptz, now())
       where exists (select 1 from guilds g where g.id = ${guildId} and g.left_at is null)
      on conflict (guild_id) do update
         set scope = excluded.scope,
             definition_hash = null,
             failure = excluded.failure,
             checked_at = excluded.checked_at
      returning guild_id`;

    return rows.length > 0;
  }

  async recordHeld(guildId: string, input: CommandRegistrationHeld): Promise<boolean> {
    const values = commandRegistrationHeldSchema.parse(input);

    const rows = await this.#handle.client<{ guild_id: string }[]>`
      update guild_command_registrations as r
         set scope = ${values.scope}::text,
             failure = jsonb_set(r.failure, '{hash}', to_jsonb(${values.hash}::text)),
             checked_at = coalesce(${values.checkedAt ?? null}::timestamptz, now())
       where r.guild_id = ${guildId}
         and jsonb_typeof(r.failure) = 'object'
         and exists (select 1 from guilds g where g.id = ${guildId} and g.left_at is null)
      returning r.guild_id`;

    return rows.length > 0;
  }

  async recordPermissions(guildId: string, input: CommandPermissionsCheck): Promise<boolean> {
    const values = commandPermissionsCheckSchema.parse(input);
    const found = values.lost.length > 0;

    // Finding nothing keeps an earlier finding: the banner stays until someone acks it.
    const rows = await this.#handle.client<{ guild_id: string }[]>`
      insert into guild_command_registrations as r
             (guild_id, scope, permissions_checked_at, lost_permissions, lost_permissions_at)
      select ${guildId}::text, ${values.scope}::text, ${values.at}::timestamptz,
             ${found ? JSON.stringify(values.lost) : null}::jsonb,
             ${found ? values.at : null}::timestamptz
       where exists (select 1 from guilds g where g.id = ${guildId} and g.left_at is null)
      on conflict (guild_id) do update
         set permissions_checked_at = excluded.permissions_checked_at,
             lost_permissions = coalesce(excluded.lost_permissions, r.lost_permissions),
             lost_permissions_at = case when excluded.lost_permissions is null
                                        then r.lost_permissions_at
                                        else excluded.lost_permissions_at end
      returning guild_id`;

    return rows.length > 0;
  }

  async ackLostPermissions(
    guildId: string,
    audit?: LostPermissionsAudit,
  ): Promise<LostCommandPermissions | null> {
    const table = guildCommandRegistrations;

    return this.#handle.db.transaction(async (tx) => {
      const rows = await tx
        .select({ lost: table.lostPermissions, at: table.lostPermissionsAt })
        .from(table)
        .where(eq(table.guildId, guildId))
        .for('update');

      const row = rows[0];
      const acked = row ? lostOf(row.lost, row.at) : null;
      if (acked === null) return null;

      await tx
        .update(table)
        .set({ lostPermissions: null, lostPermissionsAt: null })
        .where(eq(table.guildId, guildId));

      if (audit) await tx.insert(auditTrail).values({ ...audit(acked), guildId });

      return acked;
    });
  }

  async forget(guildId: string): Promise<boolean> {
    const rows = await this.#handle.db
      .delete(guildCommandRegistrations)
      .where(eq(guildCommandRegistrations.guildId, guildId))
      .returning({ guildId: guildCommandRegistrations.guildId });

    return rows.length > 0;
  }

  async staleGuilds(limit: number, options: StaleGuildsOptions = {}): Promise<string[]> {
    const count = z.number().int().positive().parse(limit);
    const { onlyGuildId, includeUnchecked } = staleGuildsOptionsSchema.parse(options);

    const rows = await this.#handle.client<{ id: string }[]>`
      select g.id
        from guilds g
        left join guild_command_registrations r on r.guild_id = g.id
       where g.left_at is null
         and (${onlyGuildId ?? null}::text is null or g.id = ${onlyGuildId ?? null}::text)
         and (
           greatest(
             (select max(c.updated_at) from guild_commands c where c.guild_id = g.id),
             (select max(m.updated_at) from guild_modules m where m.guild_id = g.id)
           ) > coalesce(r.checked_at, '-infinity'::timestamptz)
           or (r.failure ->> 'retryAt')::timestamptz <= now()
           or (${includeUnchecked}::boolean
               and (r.guild_id is null
                    or (r.permissions_checked_at is null and r.failure is null)))
         )
       order by r.checked_at asc nulls first, g.id asc
       limit ${count}`;

    return rows.map((row) => row.id);
  }
}
