import { and, count, eq, inArray } from 'drizzle-orm';
import type postgres from 'postgres';
import { z } from 'zod';
import type { DbHandle } from './client.ts';
import { account, session, user } from './schema/auth.ts';

export interface ForeignKey {
  child: string;
  parent: string;
  childColumns: readonly string[];
  parentColumns: readonly string[];
  onDelete: string;
}

export type RemovedBy = 'direct' | 'cascade';

export interface GuildTableScope {
  table: string;
  removedBy: RemovedBy;
  predicate: string;
}

export const guildRowSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    joined_ms: z.number(),
    left_ms: z.number().nullable(),
  })
  .transform((row) => ({
    id: row.id,
    name: row.name,
    joinedAt: new Date(row.joined_ms),
    leftAt: row.left_ms === null ? null : new Date(row.left_ms),
  }));

export type GuildRecord = z.infer<typeof guildRowSchema>;

export interface GuildTableCount {
  table: string;
  removedBy: RemovedBy;
  rows: number;
}

export interface GuildRows {
  guild: GuildRecord | null;
  tables: GuildTableCount[];
}

export class GuildPurgeRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GuildPurgeRefused';
  }
}

const GUILDS = 'guilds';
const CASCADE = 'c';
const GUILD_MATCH = '"guild_id" = $1';

const quote = (identifier: string): string => `"${identifier.replaceAll('"', '""')}"`;

const columns = (names: readonly string[]): string =>
  names.length === 1 ? quote(names[0] ?? '') : `(${names.map(quote).join(', ')})`;

export function planGuildTables(
  withGuildId: readonly string[],
  keys: readonly ForeignKey[],
): GuildTableScope[] {
  const guildColumn = new Set(withGuildId);
  const byParent = new Map<string, ForeignKey[]>();
  for (const key of keys) byParent.set(key.parent, [...(byParent.get(key.parent) ?? []), key]);

  const predicates = new Map<string, string>([[GUILDS, '"id" = $1']]);
  const scopes: GuildTableScope[] = [
    { table: GUILDS, removedBy: 'direct', predicate: '"id" = $1' },
  ];

  const reach = (root: string): void => {
    const queue = [root];

    for (let parent = queue.shift(); parent !== undefined; parent = queue.shift()) {
      const parentPredicate = predicates.get(parent) ?? GUILD_MATCH;

      for (const key of byParent.get(parent) ?? []) {
        if (key.onDelete !== CASCADE) {
          throw new GuildPurgeRefused(
            `${key.child} references ${key.parent} without ON DELETE CASCADE, so deleting a ` +
              `server's ${key.parent} rows would fail or leave ${key.child} rows behind. Nothing ` +
              'was deleted. Give that foreign key ON DELETE CASCADE, or teach this purge to ' +
              `delete ${key.child} first.`,
          );
        }

        if (predicates.has(key.child)) continue;

        const predicate = guildColumn.has(key.child)
          ? GUILD_MATCH
          : `${columns(key.childColumns)} in (select ${key.parentColumns.map(quote).join(', ')} ` +
            `from ${quote(key.parent)} where ${parentPredicate})`;

        predicates.set(key.child, predicate);
        scopes.push({ table: key.child, removedBy: 'cascade', predicate });
        queue.push(key.child);
      }
    }
  };

  reach(GUILDS);

  for (const table of [...withGuildId].sort()) {
    if (predicates.has(table)) continue;

    predicates.set(table, GUILD_MATCH);
    scopes.push({ table, removedBy: 'direct', predicate: GUILD_MATCH });
    reach(table);
  }

  return scopes;
}

async function readScopes(sql: postgres.TransactionSql): Promise<GuildTableScope[]> {
  const tables = await sql<{ name: string }[]>`
    select c.relname::text as name
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      join pg_attribute a on a.attrelid = c.oid
     where n.nspname = current_schema()
       and c.relkind in ('r', 'p')
       and not c.relispartition
       and a.attname = 'guild_id'
       and not a.attisdropped
     order by c.relname
  `;

  const keys = await sql<
    {
      child: string;
      parent: string;
      on_delete: string;
      child_columns: string[];
      parent_columns: string[];
    }[]
  >`
    select child.relname::text as child,
           parent.relname::text as parent,
           con.confdeltype::text as on_delete,
           array(select a.attname::text
                   from unnest(con.conkey) with ordinality as k(attnum, ord)
                   join pg_attribute a on a.attrelid = con.conrelid and a.attnum = k.attnum
                  order by k.ord) as child_columns,
           array(select a.attname::text
                   from unnest(con.confkey) with ordinality as k(attnum, ord)
                   join pg_attribute a on a.attrelid = con.confrelid and a.attnum = k.attnum
                  order by k.ord) as parent_columns
      from pg_constraint con
      join pg_class child on child.oid = con.conrelid
      join pg_class parent on parent.oid = con.confrelid
      join pg_namespace n on n.oid = child.relnamespace
     where con.contype = 'f'
       and con.conparentid = 0
       and n.nspname = current_schema()
       and not child.relispartition
     order by child.relname, con.conname
  `;

  return planGuildTables(
    tables.map((row) => row.name).filter((name) => name !== GUILDS),
    keys.map((row) => ({
      child: row.child,
      parent: row.parent,
      childColumns: row.child_columns,
      parentColumns: row.parent_columns,
      onDelete: row.on_delete,
    })),
  );
}

async function readGuild(
  sql: postgres.TransactionSql,
  guildId: string,
  lock: boolean,
): Promise<GuildRecord | null> {
  // Epoch milliseconds, not the columns: createDb's driver leaves timestamptz as unparsed text.
  const rows = await sql`
    select id, name,
           (extract(epoch from joined_at) * 1000)::float8 as joined_ms,
           (extract(epoch from left_at) * 1000)::float8 as left_ms
      from guilds
     where id = ${guildId}
     ${lock ? sql`for update` : sql``}`;

  return rows[0] ? guildRowSchema.parse(rows[0]) : null;
}

async function countScopes(
  sql: postgres.TransactionSql,
  scopes: readonly GuildTableScope[],
  guildId: string,
): Promise<GuildTableCount[]> {
  const counts: GuildTableCount[] = [];

  for (const scope of scopes) {
    const [row] = await sql.unsafe<{ rows: number }[]>(
      `select count(*)::int as rows from ${quote(scope.table)} where ${scope.predicate}`,
      [guildId],
    );
    counts.push({ table: scope.table, removedBy: scope.removedBy, rows: row?.rows ?? 0 });
  }

  return counts;
}

export function countGuildRows(handle: DbHandle, guildId: string): Promise<GuildRows> {
  return handle.client.begin('isolation level repeatable read read only', async (sql) => {
    const scopes = await readScopes(sql);

    return {
      guild: await readGuild(sql, guildId, false),
      tables: await countScopes(sql, scopes, guildId),
    };
  });
}

export function deleteGuildRows(
  handle: DbHandle,
  guildId: string,
  options: { allowPresent: boolean },
): Promise<GuildRows> {
  return handle.client.begin(async (sql) => {
    const scopes = await readScopes(sql);
    const guild = await readGuild(sql, guildId, true);

    // Re-checked under the row lock: a server that re-added Proton since the caller looked is live.
    if (guild && guild.leftAt === null && !options.allowPresent) {
      throw new GuildPurgeRefused(
        `Proton is still in ${guildId} (guilds.left_at is empty), so nothing was deleted. ` +
          'Remove Proton from the server and let the worker record it, or pass --force if the ' +
          'server no longer exists.',
      );
    }

    const tables = await countScopes(sql, scopes, guildId);

    for (const scope of scopes) {
      if (scope.removedBy !== 'direct' || scope.table === GUILDS) continue;
      await sql.unsafe(`delete from ${quote(scope.table)} where ${scope.predicate}`, [guildId]);
    }
    // Not redundant: with no row to lock at the read, a GUILD_CREATE can insert a live one.
    await sql`
      delete from guilds
       where id = ${guildId}
         and (left_at is not null or ${options.allowPresent}::boolean)`;

    const left = (await countScopes(sql, scopes, guildId)).filter((table) => table.rows > 0);
    if (left.some((table) => table.table === GUILDS)) {
      throw new GuildPurgeRefused(
        `Proton was added back to ${guildId} while it was being purged (guilds.left_at is empty ` +
          'again), so the whole deletion was rolled back and nothing was deleted.',
      );
    }
    if (left.length > 0) {
      throw new GuildPurgeRefused(
        `after deleting, ${left.map((t) => `${t.table} (${t.rows})`).join(', ')} still held ` +
          `rows for ${guildId}, so the whole deletion was rolled back and nothing was deleted.`,
      );
    }

    return { guild, tables };
  });
}

export interface SignInRows {
  users: { id: string }[];
  accounts: number;
  sessions: number;
}

type Tx = Parameters<Parameters<DbHandle['db']['transaction']>[0]>[0];

async function readSignIn(tx: Tx, discordUserId: string): Promise<SignInRows> {
  const owners = tx
    .select({ id: account.userId })
    .from(account)
    .where(and(eq(account.providerId, 'discord'), eq(account.accountId, discordUserId)));

  const users = await tx.select({ id: user.id }).from(user).where(inArray(user.id, owners));

  if (users.length === 0) return { users, accounts: 0, sessions: 0 };

  const ids = users.map((row) => row.id);
  const [accounts] = await tx
    .select({ n: count() })
    .from(account)
    .where(inArray(account.userId, ids));
  const [sessions] = await tx
    .select({ n: count() })
    .from(session)
    .where(inArray(session.userId, ids));

  return { users, accounts: accounts?.n ?? 0, sessions: sessions?.n ?? 0 };
}

export function countSignInRows(handle: DbHandle, discordUserId: string): Promise<SignInRows> {
  return handle.db.transaction((tx) => readSignIn(tx, discordUserId), { accessMode: 'read only' });
}

export function deleteSignInRows(handle: DbHandle, discordUserId: string): Promise<SignInRows> {
  return handle.db.transaction(async (tx) => {
    const found = await readSignIn(tx, discordUserId);

    if (found.users.length > 0) {
      await tx.delete(user).where(
        inArray(
          user.id,
          found.users.map((row) => row.id),
        ),
      );
    }

    return found;
  });
}
