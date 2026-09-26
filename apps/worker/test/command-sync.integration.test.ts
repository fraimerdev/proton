import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { commandCatalogue } from '@proton/core';
import {
  createDb,
  type DbHandle,
  DrizzleCommandRegistrationStore,
  guildCommands,
  guilds,
  runMigrations,
} from '@proton/db';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { CommandResolver } from '../src/command-resolver.ts';
import {
  CommandRecordCache,
  type CommandRegistrationRail,
  CommandSyncer,
  CommandSyncQueue,
} from '../src/command-sync.ts';
import { CommandSyncTriggers } from '../src/command-sync-triggers.ts';
import {
  APPLICATION,
  collectingLogger,
  commandRegistry,
  FakeDiscord,
  MemoryViews,
  TEST_GUILD,
  viewOf,
} from './command-fakes.ts';

const RAIL: CommandRegistrationRail = {
  applicationId: APPLICATION,
  scope: 'guild',
  testGuildId: TEST_GUILD,
};

let postgres: StartedPostgreSqlContainer;
let handle: DbHandle;

beforeAll(async () => {
  postgres = await new PostgreSqlContainer('postgres:17-alpine').start();
  handle = createDb(postgres.getConnectionUri());
  await runMigrations(handle);
}, 240_000);

afterAll(async () => {
  await handle?.close();
  await postgres?.stop();
}, 240_000);

beforeEach(async () => {
  await handle.db.delete(guilds);
  await handle.db.insert(guilds).values({ id: TEST_GUILD, name: 'Test' });
});

function wired() {
  const rest = new FakeDiscord();
  const views = new MemoryViews();
  const store = new DrizzleCommandRegistrationStore(handle);
  const records = new CommandRecordCache(store);
  const { logger } = collectingLogger();
  const catalogue = commandCatalogue(commandRegistry());
  const syncer = new CommandSyncer({ rest, rail: RAIL, catalogue, views, store, records, logger });
  const queue = new CommandSyncQueue({ syncer, logger });
  const triggers = new CommandSyncTriggers({
    bus: {
      publish: async () => undefined,
      subscribe: () => ({ group: 'x', close: async () => {} }),
    },
    rest,
    rail: RAIL,
    queue,
    syncer,
    records,
    store,
    registrar: { ensure: async () => undefined },
    logger,
  });
  const resolver = new CommandResolver({ catalogue, records, logger });
  views.views.set(TEST_GUILD, viewOf({ moderation: true }));

  return { rest, views, store, records, syncer, queue, triggers, resolver };
}

function registration(guildId: string) {
  return new DrizzleCommandRegistrationStore(handle).get(guildId);
}

async function setLeft(guildId: string, left: boolean): Promise<void> {
  if (left) await handle.client`update guilds set left_at = now() where id = ${guildId}`;
  else await handle.client`update guilds set left_at = null where id = ${guildId}`;
}

describe('command sync against the real registration store', () => {
  test('records Discord’s ids, then skips an unchanged set', async () => {
    const { rest, syncer } = wired();

    expect((await syncer.reconcile(TEST_GUILD)).status).toBe('registered');
    const first = await registration(TEST_GUILD);
    expect(first?.commands.map((command) => command.key).sort()).toEqual(
      [
        'ban',
        'help',
        'kick',
        'message:Punish author',
        'timeout',
        'user:Report user',
        'warn',
      ].sort(),
    );
    expect(Object.keys(first?.idHistory ?? {})).toHaveLength(7);

    expect(await syncer.reconcile(TEST_GUILD)).toEqual({ status: 'unchanged' });
    expect(rest.puts()).toHaveLength(1);
  });

  test('a renamed command resolves through the id the store recorded', async () => {
    const { rest, views, syncer, resolver } = wired();
    await syncer.reconcile(TEST_GUILD);
    views.views.set(
      TEST_GUILD,
      viewOf(
        { moderation: true },
        { ban: { name: 'punish', updatedAt: new Date().toISOString() } },
      ),
    );
    await syncer.reconcile(TEST_GUILD);

    const punish = rest.guildCommands.get(TEST_GUILD)?.find((command) => command.name === 'punish');
    const resolved = await resolver.resolve(TEST_GUILD, {
      data: {
        id: punish?.id,
        name: 'punish',
        type: 1,
        guild_id: TEST_GUILD,
        options: [{ name: 'remove', type: 1, options: [{ name: 'user_id', type: 3, value: '1' }] }],
      },
    });

    expect(resolved).toEqual({ key: 'ban', displayName: 'punish' });
  });

  test('a guild that left is never given a record again, and a rejoin registers afresh', async () => {
    const { rest, syncer, queue, triggers } = wired();
    await syncer.reconcile(TEST_GUILD);

    await setLeft(TEST_GUILD, true);
    await triggers.forget(TEST_GUILD);
    await syncer.reconcile(TEST_GUILD, { skipHash: true, ignoreHolds: true });
    expect(await registration(TEST_GUILD)).toBeNull();

    await setLeft(TEST_GUILD, false);
    await triggers.available(TEST_GUILD, new Date().toISOString());
    await queue.idle();

    expect(await registration(TEST_GUILD)).not.toBeNull();
    expect(rest.puts()).toHaveLength(3);
  });

  test('ids the store would not record still route here, and are recorded by the next sync', async () => {
    const { rest, views, records, syncer, resolver } = wired();
    views.views.set(
      TEST_GUILD,
      viewOf(
        { moderation: true },
        {
          ban: { name: 'hammer', updatedAt: new Date().toISOString() },
          warn: { name: 'ban', updatedAt: new Date().toISOString() },
        },
      ),
    );
    await setLeft(TEST_GUILD, true);

    expect((await syncer.reconcile(TEST_GUILD)).status).toBe('registered');
    expect(await registration(TEST_GUILD)).toBeNull();
    const warn = rest.guildCommands.get(TEST_GUILD)?.find((command) => command.name === 'ban');
    const asBan = {
      data: {
        id: warn?.id,
        name: 'ban',
        type: 1,
        guild_id: TEST_GUILD,
        options: [{ name: 'add', type: 1, options: [{ name: 'user', type: 6, value: '1' }] }],
      },
    };
    expect(await resolver.resolve(TEST_GUILD, asBan)).toEqual({ key: 'warn', displayName: 'ban' });

    await setLeft(TEST_GUILD, false);
    expect((await syncer.reconcile(TEST_GUILD)).status).toBe('registered');
    expect(records.pinned(TEST_GUILD)).toBe(false);
    expect((await registration(TEST_GUILD))?.idHistory[warn?.id ?? '']).toBe('warn');
    expect(await resolver.resolve(TEST_GUILD, asBan)).toEqual({ key: 'warn', displayName: 'ban' });
  });

  test('the sweep registers a guild whose command settings changed after its last check', async () => {
    const { store, views, syncer, queue, triggers, rest } = wired();
    await syncer.reconcile(TEST_GUILD);

    await handle.db.insert(guildCommands).values({
      guildId: TEST_GUILD,
      commandKey: 'kick',
      enabled: false,
      updatedAt: new Date(Date.now() + 60_000),
    });
    views.views.set(TEST_GUILD, viewOf({ moderation: true }, { kick: { enabled: false } }));
    expect(await store.staleGuilds(10)).toEqual([TEST_GUILD]);

    await triggers.sweep();
    await queue.idle();

    expect(rest.puts()).toHaveLength(2);
    const sent = rest.puts().at(-1)?.body as Array<{ name: string }>;
    expect(sent.map((command) => command.name)).not.toContain('kick');
  });

  test('a save stamped just before the check, and committed after it, is still swept', async () => {
    const { store, syncer } = wired();
    await syncer.reconcile(TEST_GUILD);

    await handle.client`
      insert into guild_commands (guild_id, command_key, enabled, updated_at)
      values (${TEST_GUILD}, 'kick', false, now() - interval '2 seconds')`;

    expect(await store.staleGuilds(10, { onlyGuildId: TEST_GUILD })).toEqual([TEST_GUILD]);
  });

  test('a held server keeps its failure against the set now expected, and leaves the sweep', async () => {
    const { rest, views, store, syncer } = wired();
    rest.failNext(() => ({ status: 403, body: { message: 'Missing Access', code: 50001 } }));
    expect((await syncer.reconcile(TEST_GUILD)).status).toBe('failed');
    const failed = await registration(TEST_GUILD);
    expect(failed?.failure?.retryAt).not.toBeNull();

    await handle.client`
      insert into guild_commands (guild_id, command_key, name, updated_at)
      values (${TEST_GUILD}, 'ban', 'punish', now() - interval '1 minute')`;
    views.views.set(
      TEST_GUILD,
      viewOf(
        { moderation: true },
        { ban: { name: 'punish', updatedAt: new Date().toISOString() } },
      ),
    );

    expect((await syncer.reconcile(TEST_GUILD)).status).toBe('held');

    const held = await registration(TEST_GUILD);
    expect(held?.failure?.code).toBe('50001');
    expect(held?.failure?.hash).not.toBe(failed?.failure?.hash ?? null);
    expect(Date.parse(held?.checkedAt ?? '')).toBeGreaterThan(Date.parse(failed?.checkedAt ?? ''));
    expect(await store.staleGuilds(10, { onlyGuildId: TEST_GUILD })).toEqual([]);
    expect(rest.puts()).toHaveLength(1);
  });
});
