import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { createDb, type DbHandle } from '../src/client.ts';
import { runMigrations } from '../src/migrator.ts';
import { guilds } from '../src/schema/index.ts';

let container: StartedPostgreSqlContainer;
let handle: DbHandle;

const GUILD = '900000000000000001';

// 0017 has already run against an empty table by the time runMigrations() returns, so the SQL is
// re-executed against a hand-seeded legacy row. It is the statement itself that is under test.
const MIGRATION = `${import.meta.dir}/../drizzle/0017_messages_module.sql`;

async function applyRename(): Promise<void> {
  const sql = await Bun.file(MIGRATION).text();

  for (const statement of sql.split('--> statement-breakpoint')) {
    const trimmed = statement.trim();
    if (trimmed.length > 0) await handle.client.unsafe(trimmed);
  }
}

async function seed(moduleId: string, config: Record<string, unknown>, enabled = true) {
  await handle.client`
    insert into guild_modules (guild_id, module_id, enabled, config, schema_version)
    values (${GUILD}, ${moduleId}, ${enabled}, ${JSON.stringify(config)}::jsonb, 3)
  `;
}

async function rowFor(moduleId: string): Promise<Record<string, unknown> | undefined> {
  const rows = (await handle.client`
    select * from guild_modules where guild_id = ${GUILD} and module_id = ${moduleId}
  `) as unknown as Array<Record<string, unknown>>;

  return rows[0];
}

const TEMPLATE = { name: 'rules', content: 'Read these first.' };

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
  await handle.client`delete from guild_modules`;
  await handle.client`delete from guilds`;
  await handle.db.insert(guilds).values({ id: GUILD, name: 'test guild' });
});

describe('0017_messages_module', () => {
  test('moves the row to the new module id', async () => {
    await seed('embeds', { enabled: true, saved: [TEMPLATE] });
    await applyRename();

    expect(await rowFor('embeds')).toBeUndefined();
    expect((await rowFor('messages'))?.module_id).toBe('messages');
  });

  test('carries the saved messages across under their new key', async () => {
    await seed('embeds', { enabled: true, saved: [TEMPLATE] });
    await applyRename();

    const config = (await rowFor('messages'))?.config as Record<string, unknown>;

    expect(config.templates).toEqual([TEMPLATE]);
    expect(config).not.toHaveProperty('saved');
  });

  test('keeps the switch and stamps the new schema version', async () => {
    await seed('embeds', { enabled: true, saved: [] }, true);
    await applyRename();

    const row = await rowFor('messages');

    expect(row?.enabled).toBe(true);
    expect(row?.schema_version).toBe(4);
  });

  test('a module that was switched off stays off', async () => {
    await seed('embeds', { enabled: false, saved: [] }, false);
    await applyRename();

    expect((await rowFor('messages'))?.enabled).toBe(false);
  });

  // The primary key is (guild_id, module_id), so a guild holding both rows would make the rename
  // collide and take the whole migration down rather than just that guild.
  test('a guild that already has a messages row keeps it, and the old row goes', async () => {
    await seed('embeds', { enabled: true, saved: [TEMPLATE] });
    await seed('messages', { enabled: true, templates: [{ name: 'current' }] });

    await applyRename();

    const config = (await rowFor('messages'))?.config as { templates: Array<{ name: string }> };

    expect(config.templates).toEqual([{ name: 'current' }]);
    expect(await rowFor('embeds')).toBeUndefined();
  });

  test('running it twice changes nothing the second time', async () => {
    await seed('embeds', { enabled: true, saved: [TEMPLATE] });

    await applyRename();
    const once = await rowFor('messages');
    await applyRename();

    expect(await rowFor('messages')).toEqual(once as Record<string, unknown>);
  });

  test('another module is left alone', async () => {
    await seed('welcome', { enabled: true, saved: ['not ours'] });
    await applyRename();

    expect((await rowFor('welcome'))?.config).toEqual({ enabled: true, saved: ['not ours'] });
  });
});
