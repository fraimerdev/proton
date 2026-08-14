import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { createDb, type DbHandle } from '../src/client.ts';
import { runMigrations } from '../src/migrator.ts';
import { cases, guilds } from '../src/schema/index.ts';
import { firstRow, rows } from './helpers.ts';

let container: StartedPostgreSqlContainer;
let handle: DbHandle;

const GUILD_ID = '900000000000000001';

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:17-alpine').start();
  handle = createDb(container.getConnectionUri());
  await runMigrations(handle);
  await handle.db.insert(guilds).values({ id: GUILD_ID, name: 'test guild' });
}, 240_000);

afterAll(async () => {
  await handle?.close();
  await container?.stop();
});

/**
 * Drizzle query builders are thenables, not Promises, so passing one straight to
 * `expect().rejects` makes the matcher inspect the builder instead of awaiting
 * it. Forcing execution inside an async function gives us a real Promise.
 */
async function insertCase(values: typeof cases.$inferInsert): Promise<void> {
  await handle.db.insert(cases).values(values);
}

function newCase(overrides: Partial<typeof cases.$inferInsert> = {}) {
  return {
    id: crypto.randomUUID(),
    guildId: GUILD_ID,
    caseNumber: Math.floor(Math.random() * 1_000_000) + 1000,
    type: 'send',
    moduleId: 'ping',
    idempotencyKey: crypto.randomUUID(),
    ...overrides,
  } satisfies typeof cases.$inferInsert;
}

describe('migrations', () => {
  test('apply cleanly and create every PLAN.md §6 core table', async () => {
    const result = await rows<{ table_name: string }>(handle.client`
      select table_name from information_schema.tables
      where table_schema = 'public'
    `);
    const tables = new Set(result.map((r) => r.table_name));

    for (const expected of [
      'guilds',
      'guild_modules',
      'cases',
      'members',
      'rules',
      'scheduled_actions',
      'audit_trail',
      'backups',
      'entitlements',
    ]) {
      expect(tables).toContain(expected);
    }
  });

  test('are idempotent on re-run', async () => {
    await runMigrations(handle);

    const row = await firstRow<{ n: number }>(handle.client`select count(*)::int as n from guilds`);
    expect(row.n).toBe(1);
  });
});

describe('cases constraints', () => {
  test('UNIQUE(idempotency_key) rejects a duplicate — the I4 backstop', async () => {
    const key = crypto.randomUUID();
    await insertCase(newCase({ idempotencyKey: key }));

    // Redis dedupe is the fast path; this constraint is what makes double
    // execution impossible rather than merely unlikely when Redis is cold.
    await expect(insertCase(newCase({ idempotencyKey: key }))).rejects.toThrow();
  });

  test('UNIQUE(guild_id, case_number) rejects a duplicate case number', async () => {
    const caseNumber = 4242;
    await insertCase(newCase({ caseNumber }));

    await expect(insertCase(newCase({ caseNumber }))).rejects.toThrow();
  });

  test('the same case number is allowed in a different guild', async () => {
    const other = '900000000000000002';
    await handle.db.insert(guilds).values({ id: other, name: 'other guild' });

    await insertCase(newCase({ caseNumber: 7 }));
    await insertCase(newCase({ guildId: other, caseNumber: 7 }));

    const row = await firstRow<{ n: number }>(
      handle.client`select count(*)::int as n from cases where case_number = 7`,
    );
    expect(row.n).toBe(2);
  });
});

describe('cases indexes', () => {
  test('the auto-reversal sweeper index is partial, not a full index', async () => {
    const found = await rows<{ indexdef: string }>(handle.client`
      select indexdef from pg_indexes
      where tablename = 'cases' and indexname = 'cases_pending_expiry_idx'
    `);

    expect(found).toHaveLength(1);
    const def = found[0]?.indexdef ?? '';

    // A full index here would grow without bound as `cases` grows; the WHERE
    // clause keeps it to just the rows that still need reverting.
    expect(def).toContain('WHERE');
    expect(def).toContain('expires_at IS NOT NULL');
    expect(def).toContain('reverted_at IS NULL');
  });

  test('the per-target history index exists and is descending by created_at', async () => {
    const found = await rows<{ indexdef: string }>(handle.client`
      select indexdef from pg_indexes
      where tablename = 'cases' and indexname = 'cases_guild_target_created_idx'
    `);

    expect(found).toHaveLength(1);
    expect(found[0]?.indexdef).toContain('created_at DESC');
  });
});
