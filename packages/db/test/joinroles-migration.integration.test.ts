import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { createDb, type DbHandle } from '../src/client.ts';
import { runMigrations } from '../src/migrator.ts';
import { guilds } from '../src/schema/index.ts';

let container: StartedPostgreSqlContainer;
let handle: DbHandle;

const GUILD = '900000000000000001';
const ROLE = '700000000000000001';
const STICKY = '700000000000000002';

// 0006 has already run against an empty table by the time runMigrations() returns, so the SQL is
// re-executed against a hand-seeded legacy row. It is the statement itself that is under test.
const MIGRATION = `${import.meta.dir}/../drizzle/0006_joinroles.sql`;

async function applyRename(): Promise<void> {
  const sql = await Bun.file(MIGRATION).text();

  for (const statement of sql.split('--> statement-breakpoint')) {
    const trimmed = statement.trim();
    if (trimmed.length > 0) await handle.client.unsafe(trimmed);
  }
}

async function seedLegacy(config: Record<string, unknown>, enabled = false): Promise<void> {
  await handle.client`
    insert into guild_modules (guild_id, module_id, enabled, config, schema_version)
    values (${GUILD}, 'autorole', ${enabled}, ${JSON.stringify(config)}::jsonb, 1)
  `;
}

async function joinrolesRow(): Promise<Record<string, unknown> | undefined> {
  const rows = (await handle.client`
    select * from guild_modules where guild_id = ${GUILD} and module_id = 'joinroles'
  `) as unknown as Array<Record<string, unknown>>;

  return rows[0];
}

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:17-alpine').start();
  handle = createDb(container.getConnectionUri());
  await runMigrations(handle);
}, 240_000);

afterAll(async () => {
  await handle?.close();
  await container?.stop();
}, 240_000);

beforeEach(async () => {
  await handle.client`delete from rules`;
  await handle.client`delete from guild_modules`;
  await handle.client`delete from guilds`;
  await handle.db.insert(guilds).values({ id: GUILD, name: 'test guild' });
});

describe('0006_joinroles', () => {
  test('configured autoroles survive the rename as memberRoleIds', async () => {
    await seedLegacy({
      enabled: false,
      autoroleIds: [ROLE],
      stickyEnabled: true,
      stickyRoleIds: [STICKY],
    });

    await applyRename();

    const row = await joinrolesRow();
    const config = row?.config as Record<string, unknown>;

    expect(row?.schema_version).toBe(2);
    expect(config.memberRoleIds).toEqual([ROLE]);
    expect(config.botRoleIds).toEqual([]);
    expect(config.stickyEnabled).toBe(true);
    expect(config.stickyRoleIds).toEqual([STICKY]);
    expect(config.grantWhenScreeningPasses).toBe(true);
  });

  test('a guild that configured roles has granting switched on, because it never worked before', async () => {
    await seedLegacy({ enabled: false, autoroleIds: [ROLE] });

    await applyRename();

    expect((await joinrolesRow())?.config).toMatchObject({ enabled: true });
  });

  test('a guild with no configured roles is left switched off', async () => {
    await seedLegacy({ enabled: false, autoroleIds: [], stickyEnabled: true });

    await applyRename();

    expect((await joinrolesRow())?.config).toMatchObject({ enabled: false, stickyEnabled: true });
  });

  test('a legacy row missing every optional key still lands on valid defaults', async () => {
    await seedLegacy({});

    await applyRename();

    expect((await joinrolesRow())?.config).toEqual({
      enabled: false,
      memberRoleIds: [],
      botRoleIds: [],
      grantWhenScreeningPasses: true,
      stickyEnabled: false,
      stickyRoleIds: [],
    });
  });

  test('the module-enabled column is untouched by the rename', async () => {
    await seedLegacy({ autoroleIds: [ROLE] }, true);

    await applyRename();

    expect((await joinrolesRow())?.enabled).toBe(true);
  });

  test('no autorole row survives', async () => {
    await seedLegacy({ autoroleIds: [ROLE] });

    await applyRename();

    const left = (await handle.client`
      select count(*)::int as n from guild_modules where module_id = 'autorole'
    `) as unknown as Array<{ n: number }>;

    expect(left[0]?.n).toBe(0);
  });

  test('a guild that already reconfigured Join Roles keeps the newer row', async () => {
    await seedLegacy({ enabled: true, autoroleIds: [ROLE] });
    await handle.client`
      insert into guild_modules (guild_id, module_id, enabled, config, schema_version)
      values (
        ${GUILD}, 'joinroles', true,
        ${JSON.stringify({
          enabled: true,
          memberRoleIds: [ROLE, STICKY],
          botRoleIds: [ROLE],
          grantWhenScreeningPasses: true,
          stickyEnabled: true,
          stickyRoleIds: [],
        })}::jsonb,
        2
      )
    `;

    await applyRename();

    // Renaming onto the existing row would violate the (guild_id, module_id) primary key, so the
    // newer row wins and the legacy one is dropped rather than the migration failing.
    const config = (await joinrolesRow())?.config as Record<string, unknown>;
    expect(config.memberRoleIds).toEqual([ROLE, STICKY]);
    expect(config.botRoleIds).toEqual([ROLE]);

    const left = (await handle.client`
      select count(*)::int as n from guild_modules where module_id = 'autorole'
    `) as unknown as Array<{ n: number }>;

    expect(left[0]?.n).toBe(0);
  });

  test('stale autorole rules are cleared so the dispatcher stops complaining about them', async () => {
    await handle.client`
      insert into rules (id, guild_id, module_id, trigger, conditions, actions, enabled, priority)
      values (
        ${`${GUILD}:autorole:grant-${ROLE}`}, ${GUILD}, 'autorole',
        ${JSON.stringify({ kind: 'event', event: 'member.joined' })}::jsonb,
        '{}', '{}', true, 0
      )
    `;

    await applyRename();

    const left = (await handle.client`
      select count(*)::int as n from rules where module_id = 'autorole'
    `) as unknown as Array<{ n: number }>;

    expect(left[0]?.n).toBe(0);
  });
});
