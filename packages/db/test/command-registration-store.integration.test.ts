import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { createDb, type DbHandle } from '../src/client.ts';
import {
  type CommandRegistrationFailure,
  DrizzleCommandRegistrationStore,
  ID_HISTORY_MAX,
  type RegisteredCommand,
} from '../src/command-registration-store.ts';
import { runMigrations } from '../src/migrator.ts';
import { guilds } from '../src/schema/index.ts';
import { firstRow } from './helpers.ts';

let container: StartedPostgreSqlContainer;
let handle: DbHandle;
let store: DrizzleCommandRegistrationStore;

const GUILD = '900000000000000001';
const LEFT = '900000000000000002';
const MISSING = '900000000000000099';
const ACTOR = '100000000000000001';

const BAN: RegisteredCommand = { key: 'ban', id: '1300000000000000001', name: 'ban', kind: 'chat' };
const PUNISH: RegisteredCommand = { ...BAN, name: 'punish' };
const REPORT: RegisteredCommand = {
  key: 'user:Report user',
  id: '1300000000000000002',
  name: 'Report user',
  kind: 'user',
};
const KICK: RegisteredCommand = {
  key: 'kick',
  id: '1300000000000000003',
  name: 'kick',
  kind: 'chat',
};

function failure(overrides: Partial<CommandRegistrationFailure> = {}): CommandRegistrationFailure {
  return {
    code: '50001',
    status: 403,
    message: 'Proton can’t manage commands in this server.',
    detail: 'Missing Access',
    at: new Date().toISOString(),
    retryAt: null,
    hash: 'next',
    ...overrides,
  };
}

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:17-alpine').start();
  handle = createDb(container.getConnectionUri());
  await runMigrations(handle);
  store = new DrizzleCommandRegistrationStore(handle);
}, 240_000);

afterAll(async () => {
  await handle?.close();
  await container?.stop();
}, 240_000);

beforeEach(async () => {
  await handle.client`delete from guilds`;
  await handle.db.insert(guilds).values([
    { id: GUILD, name: 'test guild' },
    { id: LEFT, name: 'left guild', leftAt: new Date('2026-09-20T00:00:00.000Z') },
  ]);
});

async function recordCount(guildId: string): Promise<number> {
  const found = await firstRow<{ n: number }>(
    handle.client`select count(*)::int as n from guild_command_registrations
                   where guild_id = ${guildId}`,
  );
  return found.n;
}

describe('recordSuccess', () => {
  test('creates the record with the commands, their ids and both times', async () => {
    expect(
      await store.recordSuccess(GUILD, {
        scope: 'every-guild',
        hash: 'abc',
        commands: [BAN, REPORT],
      }),
    ).toBe(true);

    const record = await store.get(GUILD);

    expect(record).toEqual({
      guildId: GUILD,
      scope: 'every-guild',
      definitionHash: 'abc',
      commands: [BAN, REPORT],
      idHistory: { [BAN.id]: 'ban', [REPORT.id]: 'user:Report user' },
      checkedAt: expect.any(String),
      syncedAt: expect.any(String),
      failure: null,
      permissionsCheckedAt: null,
      lostPermissions: null,
    });
    expect(record?.checkedAt).toBe(record?.syncedAt ?? '');
  });

  test('a later success replaces the commands and keeps every id it has seen', async () => {
    await store.recordSuccess(GUILD, { scope: 'every-guild', hash: 'abc', commands: [BAN, KICK] });
    await store.recordSuccess(GUILD, { scope: 'every-guild', hash: 'def', commands: [PUNISH] });

    const record = await store.get(GUILD);

    expect(record?.definitionHash).toBe('def');
    expect(record?.commands).toEqual([PUNISH]);
    expect(record?.idHistory).toEqual({ [BAN.id]: 'ban', [KICK.id]: 'kick' });
  });

  test('clears an earlier failure', async () => {
    await store.recordFailure(GUILD, { scope: 'guild', failure: failure() });
    await store.recordSuccess(GUILD, { scope: 'guild', hash: 'abc', commands: [BAN] });

    expect((await store.get(GUILD))?.failure).toBeNull();
  });

  test('caps the id history by dropping the oldest ids, never the ones just returned', async () => {
    await store.recordSuccess(GUILD, { scope: 'guild', hash: 'abc', commands: [BAN] });

    const seeded: Record<string, string> = { '999999999999999999': 'old' };
    for (let n = 0; n < ID_HISTORY_MAX - 1; n += 1) {
      seeded[(1_400_000_000_000_000_000n + BigInt(n)).toString()] = 'churn';
    }
    await handle.client`
      update guild_command_registrations set id_history = ${JSON.stringify(seeded)}::jsonb
       where guild_id = ${GUILD}`;

    await store.recordSuccess(GUILD, { scope: 'guild', hash: 'def', commands: [BAN, REPORT] });

    const history = (await store.get(GUILD))?.idHistory ?? {};

    expect(Object.keys(history)).toHaveLength(ID_HISTORY_MAX);
    expect(history[BAN.id]).toBe('ban');
    expect(history[REPORT.id]).toBe('user:Report user');
    expect(history['999999999999999999']).toBeUndefined();
    expect(history['1400000000000000000']).toBeUndefined();
    expect(history['1400000000000000001']).toBe('churn');
  });

  test('never creates a record for a server Proton has left', async () => {
    expect(await store.recordSuccess(LEFT, { scope: 'guild', hash: 'abc', commands: [BAN] })).toBe(
      false,
    );
    expect(await recordCount(LEFT)).toBe(0);
  });

  test('never changes the record of a server Proton has since left', async () => {
    await store.recordSuccess(GUILD, { scope: 'guild', hash: 'abc', commands: [BAN] });
    await handle.client`update guilds set left_at = now() where id = ${GUILD}`;

    expect(await store.recordSuccess(GUILD, { scope: 'guild', hash: 'def', commands: [] })).toBe(
      false,
    );
    expect((await store.get(GUILD))?.definitionHash).toBe('abc');
  });

  test('a server with no guilds row is skipped rather than failing on the foreign key', async () => {
    expect(await store.recordSuccess(MISSING, { scope: 'guild', hash: 'abc', commands: [] })).toBe(
      false,
    );
  });
});

describe('recordChecked', () => {
  test('stamps the check when the stored hash is the one checked', async () => {
    await store.recordSuccess(GUILD, { scope: 'guild', hash: 'abc', commands: [BAN] });
    const before = await store.get(GUILD);
    await Bun.sleep(5);

    expect(await store.recordChecked(GUILD, { scope: 'guild', hash: 'abc' })).toBe(true);

    const after = await store.get(GUILD);
    expect(Date.parse(after?.checkedAt ?? '')).toBeGreaterThan(Date.parse(before?.checkedAt ?? ''));
    expect(after?.syncedAt).toBe(before?.syncedAt ?? '');
  });

  test('stamps nothing for another hash, no record, or a server Proton has left', async () => {
    await store.recordSuccess(GUILD, { scope: 'guild', hash: 'abc', commands: [BAN] });
    const before = await store.get(GUILD);

    expect(await store.recordChecked(GUILD, { scope: 'guild', hash: 'other' })).toBe(false);
    expect((await store.get(GUILD))?.checkedAt).toBe(before?.checkedAt ?? '');

    expect(await store.recordChecked(LEFT, { scope: 'guild', hash: 'abc' })).toBe(false);
    expect(await recordCount(LEFT)).toBe(0);

    await handle.client`update guilds set left_at = now() where id = ${GUILD}`;
    expect(await store.recordChecked(GUILD, { scope: 'guild', hash: 'abc' })).toBe(false);
  });
});

describe('recordFailure', () => {
  test('keeps what Discord last accepted but forgets the hash, so the next run registers', async () => {
    await store.recordSuccess(GUILD, { scope: 'every-guild', hash: 'abc', commands: [BAN] });
    const synced = await store.get(GUILD);
    const failed = failure({ code: '30034', status: 400, retryAt: '2026-09-23T08:00:00.000Z' });

    expect(await store.recordFailure(GUILD, { scope: 'every-guild', failure: failed })).toBe(true);

    const record = await store.get(GUILD);
    expect(record?.definitionHash).toBeNull();
    expect(record?.failure).toEqual(failed);
    expect(record?.commands).toEqual([BAN]);
    expect(record?.idHistory).toEqual({ [BAN.id]: 'ban' });
    expect(record?.syncedAt).toBe(synced?.syncedAt ?? '');
  });

  test('creates a record for a server whose first registration failed', async () => {
    expect(await store.recordFailure(GUILD, { scope: 'every-guild', failure: failure() })).toBe(
      true,
    );

    const record = await store.get(GUILD);
    expect(record?.commands).toEqual([]);
    expect(record?.idHistory).toEqual({});
    expect(record?.syncedAt).toBeNull();
    expect(record?.failure?.code).toBe('50001');
  });

  test('never creates a record for a server Proton has left', async () => {
    expect(await store.recordFailure(LEFT, { scope: 'guild', failure: failure() })).toBe(false);
    expect(await recordCount(LEFT)).toBe(0);
  });
});

describe('the check time', () => {
  const READ = '2026-01-01T08:00:00.000Z';

  test('now is the database clock', async () => {
    const before = Date.now();
    const now = Date.parse(await store.now());

    expect(Math.abs(now - before)).toBeLessThan(60_000);
  });

  test('a success stamps the time the view was read, and synced_at the time it was written', async () => {
    await store.recordSuccess(GUILD, {
      scope: 'guild',
      hash: 'abc',
      commands: [BAN],
      checkedAt: READ,
    });

    const record = await store.get(GUILD);
    expect(record?.checkedAt).toBe(READ);
    expect(Date.parse(record?.syncedAt ?? '')).toBeGreaterThan(Date.parse(READ));
  });

  test('a check and a failure stamp the time the view was read', async () => {
    await store.recordSuccess(GUILD, { scope: 'guild', hash: 'abc', commands: [BAN] });
    await store.recordChecked(GUILD, { scope: 'guild', hash: 'abc', checkedAt: READ });
    expect((await store.get(GUILD))?.checkedAt).toBe(READ);

    await store.recordFailure(GUILD, {
      scope: 'guild',
      failure: failure(),
      checkedAt: '2026-01-01T09:00:00.000Z',
    });
    expect((await store.get(GUILD))?.checkedAt).toBe('2026-01-01T09:00:00.000Z');
  });

  test('a save made after the view was read, before the write, stays stale', async () => {
    await handle.client`
      insert into guild_commands (guild_id, command_key, name, updated_at)
      values (${GUILD}, 'ban', 'punish', '2026-01-01T08:00:03.000Z'::timestamptz)`;

    await store.recordSuccess(GUILD, {
      scope: 'guild',
      hash: 'abc',
      commands: [BAN],
      checkedAt: READ,
    });

    expect(await store.staleGuilds(50)).toEqual([GUILD]);
  });
});

describe('recordHeld', () => {
  test('keeps the failure but points it at the hash now expected, and stamps the check', async () => {
    const failed = failure({ hash: 'old', retryAt: '2026-09-22T09:00:00.000Z' });
    await store.recordFailure(GUILD, { scope: 'every-guild', failure: failed });

    expect(
      await store.recordHeld(GUILD, {
        scope: 'every-guild',
        hash: 'new',
        checkedAt: '2026-09-22T08:30:00.000Z',
      }),
    ).toBe(true);

    const record = await store.get(GUILD);
    expect(record?.failure).toEqual({ ...failed, hash: 'new' });
    expect(record?.checkedAt).toBe('2026-09-22T08:30:00.000Z');
    expect(record?.definitionHash).toBeNull();
  });

  test('writes nothing without a failure, without a record, or for a server Proton has left', async () => {
    await store.recordSuccess(GUILD, { scope: 'guild', hash: 'abc', commands: [BAN] });
    const synced = await store.get(GUILD);

    expect(await store.recordHeld(GUILD, { scope: 'guild', hash: 'next' })).toBe(false);
    expect(await store.get(GUILD)).toEqual(synced);

    expect(await store.recordHeld(MISSING, { scope: 'guild', hash: 'next' })).toBe(false);

    await store.recordFailure(GUILD, { scope: 'guild', failure: failure({ hash: 'old' }) });
    await handle.client`update guilds set left_at = now() where id = ${GUILD}`;
    expect(await store.recordHeld(GUILD, { scope: 'guild', hash: 'next' })).toBe(false);
    expect((await store.get(GUILD))?.failure?.hash).toBe('old');
  });
});

describe('lost permissions', () => {
  const LOST = [
    { key: 'ban', name: 'ban' },
    { key: 'user:Report user', name: 'Report user' },
  ];

  test('a finding is recorded even before the first registration, then acked once', async () => {
    const at = '2026-09-22T08:00:00.000Z';

    expect(await store.recordPermissions(GUILD, { scope: 'every-guild', lost: LOST, at })).toBe(
      true,
    );

    const record = await store.get(GUILD);
    expect(record?.permissionsCheckedAt).toBe(at);
    expect(record?.lostPermissions).toEqual({ commands: LOST, at });

    const acked = await store.ackLostPermissions(GUILD, (lost) => ({
      id: 'ack-1',
      actorId: ACTOR,
      source: 'dashboard',
      action: 'command.permissions_ack',
      before: lost,
      after: null,
    }));

    expect(acked).toEqual({ commands: LOST, at });
    expect((await store.get(GUILD))?.lostPermissions).toBeNull();
    expect((await store.get(GUILD))?.permissionsCheckedAt).toBe(at);
    expect(
      await firstRow<{ action: string; before: unknown }>(
        handle.client`select action, before from audit_trail where id = 'ack-1'`,
      ),
    ).toEqual({ action: 'command.permissions_ack', before: { commands: LOST, at } });

    expect(await store.ackLostPermissions(GUILD)).toBeNull();
  });

  test('a later check that finds nothing keeps the finding nobody has acked', async () => {
    await store.recordPermissions(GUILD, {
      scope: 'every-guild',
      lost: LOST,
      at: '2026-09-22T08:00:00.000Z',
    });
    await store.recordPermissions(GUILD, {
      scope: 'every-guild',
      lost: [],
      at: '2026-09-22T09:00:00.000Z',
    });

    const record = await store.get(GUILD);
    expect(record?.permissionsCheckedAt).toBe('2026-09-22T09:00:00.000Z');
    expect(record?.lostPermissions).toEqual({ commands: LOST, at: '2026-09-22T08:00:00.000Z' });
  });

  test('a check keeps the registration it finds', async () => {
    await store.recordSuccess(GUILD, { scope: 'every-guild', hash: 'abc', commands: [BAN] });
    await store.recordPermissions(GUILD, {
      scope: 'guild',
      lost: [],
      at: new Date().toISOString(),
    });

    const record = await store.get(GUILD);
    expect(record?.scope).toBe('every-guild');
    expect(record?.definitionHash).toBe('abc');
    expect(record?.lostPermissions).toBeNull();
  });

  test('never creates a record for a server Proton has left', async () => {
    expect(
      await store.recordPermissions(LEFT, {
        scope: 'every-guild',
        lost: LOST,
        at: '2026-09-22T08:00:00.000Z',
      }),
    ).toBe(false);
    expect(await recordCount(LEFT)).toBe(0);
  });
});

describe('forget', () => {
  test('deletes the record, and says whether there was one', async () => {
    await store.recordSuccess(GUILD, { scope: 'guild', hash: 'abc', commands: [BAN] });

    expect(await store.forget(GUILD)).toBe(true);
    expect(await store.get(GUILD)).toBeNull();
    expect(await store.forget(GUILD)).toBe(false);
  });

  test('removing the server removes its record', async () => {
    await store.recordSuccess(GUILD, { scope: 'guild', hash: 'abc', commands: [BAN] });

    await handle.client`delete from guilds where id = ${GUILD}`;

    expect(await recordCount(GUILD)).toBe(0);
  });
});

describe('staleGuilds', () => {
  const CHANGED = '900000000000000011';
  const CURRENT = '900000000000000012';
  const NEVER_SYNCED = '900000000000000013';
  const UNTOUCHED = '900000000000000014';
  const RETRY_DUE = '900000000000000015';
  const RETRY_LATER = '900000000000000016';
  const GAVE_UP = '900000000000000017';

  async function checkedAt(guildId: string, at: string): Promise<void> {
    await store.recordSuccess(guildId, { scope: 'every-guild', hash: 'abc', commands: [BAN] });
    await handle.client`
      update guild_command_registrations set checked_at = ${at}::timestamptz
       where guild_id = ${guildId}`;
  }

  async function moduleSavedAt(guildId: string, at: string): Promise<void> {
    await handle.client`
      insert into guild_modules (guild_id, module_id, updated_at)
      values (${guildId}, 'moderation', ${at}::timestamptz)`;
  }

  async function commandSavedAt(guildId: string, at: string): Promise<void> {
    await handle.client`
      insert into guild_commands (guild_id, command_key, name, updated_at)
      values (${guildId}, 'ban', 'punish', ${at}::timestamptz)`;
  }

  beforeEach(async () => {
    await handle.db.insert(guilds).values(
      [CHANGED, CURRENT, NEVER_SYNCED, UNTOUCHED, RETRY_DUE, RETRY_LATER, GAVE_UP].map((id) => ({
        id,
        name: id,
      })),
    );

    await checkedAt(CHANGED, '2026-01-01T08:00:00.000Z');
    await moduleSavedAt(CHANGED, '2026-01-01T07:00:00.000Z');
    await commandSavedAt(CHANGED, '2026-01-01T09:00:00.000Z');

    await checkedAt(CURRENT, '2026-01-01T09:30:00.000Z');
    await moduleSavedAt(CURRENT, '2026-01-01T07:00:00.000Z');
    await commandSavedAt(CURRENT, '2026-01-01T09:00:00.000Z');

    await moduleSavedAt(NEVER_SYNCED, '2026-01-01T07:00:00.000Z');

    const hour = 60 * 60 * 1000;
    const retryingAt = (offset: number) =>
      failure({ code: null, status: 503, retryAt: new Date(Date.now() + offset).toISOString() });

    await moduleSavedAt(RETRY_DUE, '2026-01-01T07:00:00.000Z');
    await store.recordFailure(RETRY_DUE, { scope: 'every-guild', failure: retryingAt(-hour) });
    await moduleSavedAt(RETRY_LATER, '2026-01-01T07:00:00.000Z');
    await store.recordFailure(RETRY_LATER, { scope: 'every-guild', failure: retryingAt(hour) });
    await moduleSavedAt(GAVE_UP, '2026-01-01T07:00:00.000Z');
    await store.recordFailure(GAVE_UP, { scope: 'every-guild', failure: failure() });

    await moduleSavedAt(LEFT, '2026-01-01T09:00:00.000Z');
  });

  test('finds servers changed since their last check, never checked, or due a retry', async () => {
    expect((await store.staleGuilds(50)).sort()).toEqual([CHANGED, NEVER_SYNCED, RETRY_DUE].sort());
  });

  test('servers never checked come first, then the longest since a check', async () => {
    const stale = await store.staleGuilds(50);

    expect(stale[0]).toBe(NEVER_SYNCED);
    expect(stale.indexOf(CHANGED)).toBeLessThan(stale.indexOf(RETRY_DUE));
  });

  test('returns at most the limit', async () => {
    expect(await store.staleGuilds(1)).toEqual([NEVER_SYNCED]);
  });

  test('a save after the check makes a current server stale again', async () => {
    await handle.client`
      update guild_modules set updated_at = '2026-01-01T10:00:00.000Z'::timestamptz
       where guild_id = ${CURRENT}`;

    expect(await store.staleGuilds(50)).toContain(CURRENT);
    expect(await store.staleGuilds(50)).not.toContain(UNTOUCHED);
  });

  test('one guild is picked out before the limit, however many others sort ahead of it', async () => {
    expect(await store.staleGuilds(1, { onlyGuildId: CHANGED })).toEqual([CHANGED]);
    expect(await store.staleGuilds(50, { onlyGuildId: CURRENT })).toEqual([]);
  });

  test('can include servers with no record, or whose permissions were never read', async () => {
    await store.recordPermissions(CHANGED, {
      scope: 'every-guild',
      lost: [],
      at: '2026-01-01T08:00:00.000Z',
    });
    await store.recordPermissions(CURRENT, {
      scope: 'every-guild',
      lost: [],
      at: '2026-01-01T08:00:00.000Z',
    });

    const found = await store.staleGuilds(50, { includeUnchecked: true });

    expect(found.sort()).toEqual([GUILD, CHANGED, NEVER_SYNCED, UNTOUCHED, RETRY_DUE].sort());
    expect(await store.staleGuilds(50)).not.toContain(UNTOUCHED);
  });
});
