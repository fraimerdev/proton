import { describe, expect, test } from 'bun:test';
import {
  type CommandRegistrationFailure,
  DrizzleCommandRegistrationStore,
  type RegisteredCommand,
  toRegistrationRecord,
} from '../src/command-registration-store.ts';
import type { GuildCommandRegistrationRow } from '../src/schema/guild-commands.ts';
import { type FakeQuery, fakePostgres, type Respond } from './fake-postgres.ts';

const GUILD = '900000000000000001';
const CHECKED = '2026-09-22T08:00:00.000Z';
const SYNCED = '2026-09-22T07:00:00.000Z';

const BAN: RegisteredCommand = {
  key: 'ban',
  id: '1300000000000000001',
  name: 'punish',
  kind: 'chat',
};
const REPORT: RegisteredCommand = {
  key: 'user:Report user',
  id: '1300000000000000002',
  name: 'Report user',
  kind: 'user',
};

const FAILURE: CommandRegistrationFailure = {
  code: '50001',
  status: 403,
  message: 'Proton can’t manage commands in this server.',
  detail: 'Missing Access',
  at: CHECKED,
  retryAt: null,
  hash: 'abc',
};

function row(overrides: Partial<GuildCommandRegistrationRow> = {}): GuildCommandRegistrationRow {
  return {
    guildId: GUILD,
    scope: 'every-guild',
    definitionHash: 'abc',
    commands: [BAN, REPORT],
    idHistory: { [BAN.id]: 'ban', [REPORT.id]: 'user:Report user', '1200000000000000009': 'kick' },
    checkedAt: new Date(CHECKED),
    syncedAt: new Date(SYNCED),
    failure: null,
    permissionsCheckedAt: null,
    lostPermissions: null,
    lostPermissionsAt: null,
    ...overrides,
  };
}

const GUARD = 'where exists (select 1 from guilds g where g.id = $';

function storeWith(respond: Respond = () => [{ guild_id: GUILD }]) {
  const fake = fakePostgres(respond);
  return { ...fake, store: new DrizzleCommandRegistrationStore(fake.handle) };
}

function only(queries: FakeQuery[]): FakeQuery {
  expect(queries).toHaveLength(1);
  const query = queries[0];
  if (!query) throw new Error('expected one query');
  return query;
}

describe('toRegistrationRecord', () => {
  test('reads every column, with times as ISO strings', () => {
    expect(
      toRegistrationRecord(
        row({
          failure: FAILURE,
          permissionsCheckedAt: new Date(CHECKED),
          lostPermissions: [{ key: 'ban', name: 'ban' }],
          lostPermissionsAt: new Date(CHECKED),
        }),
      ),
    ).toEqual({
      guildId: GUILD,
      scope: 'every-guild',
      definitionHash: 'abc',
      commands: [BAN, REPORT],
      idHistory: {
        [BAN.id]: 'ban',
        [REPORT.id]: 'user:Report user',
        '1200000000000000009': 'kick',
      },
      checkedAt: CHECKED,
      syncedAt: SYNCED,
      failure: FAILURE,
      permissionsCheckedAt: CHECKED,
      lostPermissions: { commands: [{ key: 'ban', name: 'ban' }], at: CHECKED },
    });
  });

  test('a guild never checked reads with no times, no failure and nothing lost', () => {
    const record = toRegistrationRecord(
      row({ definitionHash: null, checkedAt: null, syncedAt: null }),
    );

    expect(record?.definitionHash).toBeNull();
    expect(record?.checkedAt).toBeNull();
    expect(record?.syncedAt).toBeNull();
    expect(record?.failure).toBeNull();
    expect(record?.lostPermissions).toBeNull();
  });

  test('an empty lost list is nothing to show', () => {
    expect(
      toRegistrationRecord(row({ lostPermissions: [], lostPermissionsAt: new Date(CHECKED) }))
        ?.lostPermissions,
    ).toBeNull();
  });

  test('malformed jsonb falls back column by column instead of failing the whole record', () => {
    const record = toRegistrationRecord(
      row({
        commands: [{ key: 'ban' }] as unknown as RegisteredCommand[],
        idHistory: { 1: 5 } as unknown as Record<string, string>,
        failure: { code: 1 } as unknown as CommandRegistrationFailure,
        lostPermissions: [{ key: 1 }] as unknown as GuildCommandRegistrationRow['lostPermissions'],
        lostPermissionsAt: new Date(CHECKED),
      }),
    );

    expect(record?.commands).toEqual([]);
    expect(record?.idHistory).toEqual({});
    expect(record?.failure).toBeNull();
    expect(record?.lostPermissions).toBeNull();
    expect(record?.definitionHash).toBe('abc');
    expect(record?.checkedAt).toBe(CHECKED);
  });

  test('a scope Proton does not know reads as no record, so the next run registers afresh', () => {
    expect(toRegistrationRecord(row({ scope: 'global' as 'guild' }))).toBeNull();
  });
});

describe('DrizzleCommandRegistrationStore', () => {
  test('get reads the guild’s record, and nothing when there is none', async () => {
    const found = storeWith(() => [
      {
        guild_id: GUILD,
        scope: 'guild',
        definition_hash: 'abc',
        commands: [BAN],
        id_history: { [BAN.id]: 'ban' },
        checked_at: CHECKED,
        synced_at: SYNCED,
        failure: null,
        permissions_checked_at: null,
        lost_permissions: null,
        lost_permissions_at: null,
      },
    ]);

    expect((await found.store.get(GUILD))?.commands).toEqual([BAN]);
    expect(await storeWith(() => []).store.get(GUILD)).toBeNull();
  });

  test('recordSuccess is one guarded statement that stores the commands and their ids', async () => {
    const { store, steps, queries } = storeWith();

    expect(
      await store.recordSuccess(GUILD, {
        scope: 'every-guild',
        hash: 'abc',
        commands: [BAN, REPORT],
      }),
    ).toBe(true);

    expect(steps.every((step) => typeof step !== 'string')).toBe(true);
    const query = only(queries());
    expect(query.sql).toStartWith('insert into guild_command_registrations as r');
    expect(query.sql).toContain(GUARD);
    expect(query.sql).toContain('failure = null');
    expect(query.sql).toContain('synced_at = excluded.synced_at');
    expect(query.params).toContain(JSON.stringify([BAN, REPORT]));
    expect(query.params).toContain(
      JSON.stringify({ [BAN.id]: 'ban', [REPORT.id]: 'user:Report user' }),
    );
    expect(query.params).toContain(1000);
  });

  test('recordSuccess reports nothing written when the guild has gone', async () => {
    const { store } = storeWith(() => []);

    expect(await store.recordSuccess(GUILD, { scope: 'guild', hash: 'abc', commands: [] })).toBe(
      false,
    );
  });

  test('recordSuccess refuses a command Discord returned without an id', async () => {
    const { store, queries } = storeWith();

    await expect(
      store.recordSuccess(GUILD, {
        scope: 'guild',
        hash: 'abc',
        commands: [{ key: 'ban', name: 'ban', kind: 'chat' } as unknown as RegisteredCommand],
      }),
    ).rejects.toThrow();
    expect(queries()).toHaveLength(0);
  });

  test('recordChecked stamps only a present guild whose stored hash is the one checked', async () => {
    const { store, queries } = storeWith();

    expect(await store.recordChecked(GUILD, { scope: 'guild', hash: 'abc' })).toBe(true);

    const query = only(queries());
    expect(query.sql).toStartWith('update "guild_command_registrations" set');
    expect(query.sql).toContain('"checked_at" = now()');
    expect(query.sql).toContain('"guild_command_registrations"."definition_hash" = $');
    expect(query.sql).toContain('exists (select "id" from "guilds"');
    expect(query.sql).toContain('"guilds"."left_at" is null');
    expect(query.params).toEqual(['guild', GUILD, 'abc', GUILD]);
    expect(
      await storeWith(() => []).store.recordChecked(GUILD, { scope: 'guild', hash: 'x' }),
    ).toBe(false);
  });

  test('recordFailure nulls the hash, so the next run always registers', async () => {
    const { store, queries } = storeWith();

    expect(await store.recordFailure(GUILD, { scope: 'every-guild', failure: FAILURE })).toBe(true);

    const query = only(queries());
    expect(query.sql).toContain(GUARD);
    expect(query.sql).toContain('definition_hash = null');
    expect(query.sql).toContain('failure = excluded.failure');
    expect(query.sql).not.toContain('commands =');
    expect(query.sql).not.toContain('id_history =');
    expect(query.params).toContain(JSON.stringify(FAILURE));
  });

  test.each([
    ['a retry time that is not a timestamp', { retryAt: 'tomorrow' }],
    ['a failure time that is not a timestamp', { at: '' }],
  ])('recordFailure refuses %s before it reaches the sweep', async (_, overrides) => {
    const { store, queries } = storeWith();

    await expect(
      store.recordFailure(GUILD, { scope: 'guild', failure: { ...FAILURE, ...overrides } }),
    ).rejects.toThrow();
    expect(queries()).toHaveLength(0);
  });

  test('recordPermissions stores what it found, and sends no finding when it found nothing', async () => {
    const found = storeWith();
    await found.store.recordPermissions(GUILD, {
      scope: 'every-guild',
      lost: [{ key: 'ban', name: 'ban' }],
      at: CHECKED,
    });

    const query = only(found.queries());
    expect(query.sql).toContain(GUARD);
    expect(query.sql).toContain('coalesce(excluded.lost_permissions, r.lost_permissions)');
    expect(query.params).toEqual([
      GUILD,
      'every-guild',
      CHECKED,
      JSON.stringify([{ key: 'ban', name: 'ban' }]),
      CHECKED,
      GUILD,
    ]);

    const nothing = storeWith();
    await nothing.store.recordPermissions(GUILD, { scope: 'every-guild', lost: [], at: CHECKED });
    expect(only(nothing.queries()).params).toEqual([
      GUILD,
      'every-guild',
      CHECKED,
      null,
      null,
      GUILD,
    ]);
  });

  test('ackLostPermissions clears the finding and audits it in the same transaction', async () => {
    const { store, steps } = storeWith((query) =>
      query.sql.endsWith('for update')
        ? [{ lost_permissions: [{ key: 'ban', name: 'ban' }], lost_permissions_at: CHECKED }]
        : [],
    );

    const acked = await store.ackLostPermissions(GUILD, (lost) => ({
      id: 'audit-1',
      actorId: '100000000000000001',
      source: 'dashboard',
      action: 'command.permissions_ack',
      before: lost,
      after: null,
    }));

    expect(acked).toEqual({ commands: [{ key: 'ban', name: 'ban' }], at: CHECKED });
    const kinds = steps.map((step) =>
      typeof step === 'string' ? step : step.sql.split(' ').slice(0, 3).join(' '),
    );
    expect(kinds).toEqual([
      'begin',
      'select "lost_permissions", "lost_permissions_at"',
      'update "guild_command_registrations" set',
      'insert into "audit_trail"',
      'commit',
    ]);
  });

  test('ackLostPermissions with nothing to ack writes nothing', async () => {
    const { store, queries } = storeWith((query) =>
      query.sql.endsWith('for update')
        ? [{ lost_permissions: null, lost_permissions_at: null }]
        : [],
    );
    let audited = false;

    expect(
      await store.ackLostPermissions(GUILD, () => {
        audited = true;
        throw new Error('not reached');
      }),
    ).toBeNull();
    expect(audited).toBe(false);
    expect(queries()).toHaveLength(1);
  });

  test('forget deletes the record and says whether there was one', async () => {
    expect(await storeWith().store.forget(GUILD)).toBe(true);
    expect(await storeWith(() => []).store.forget(GUILD)).toBe(false);
  });

  test('staleGuilds returns ids, and compares against the last check and a due retry', async () => {
    const { store, queries } = storeWith(() => [{ id: GUILD }, { id: '900000000000000002' }]);

    expect(await store.staleGuilds(50)).toEqual([GUILD, '900000000000000002']);

    const query = only(queries());
    expect(query.sql).toContain('where g.left_at is null');
    expect(query.sql).toContain("> coalesce(r.checked_at, '-infinity'::timestamptz)");
    expect(query.sql).toContain("(r.failure ->> 'retryAt')::timestamptz <= now()");
    expect(query.params).toEqual([null, null, false, 50]);
  });

  test('staleGuilds narrows to one guild before the limit, so other servers never crowd it out', async () => {
    const { store, queries } = storeWith(() => [{ id: GUILD }]);

    await store.staleGuilds(1, { onlyGuildId: GUILD });

    const query = only(queries());
    expect(query.sql).toMatch(/\$1::text is null or g\.id = \$2::text\) and .* limit \$4$/);
    expect(query.sql.indexOf('g.id = $2')).toBeLessThan(query.sql.indexOf('order by'));
    expect(query.params).toEqual([GUILD, GUILD, false, 1]);
  });

  test('staleGuilds can include servers with no record or whose permissions were never read', async () => {
    const { store, queries } = storeWith();

    await store.staleGuilds(50, { includeUnchecked: true });

    const query = only(queries());
    expect(query.sql).toContain(
      '$3::boolean and (r.guild_id is null or (r.permissions_checked_at is null and r.failure is null))',
    );
    expect(query.params).toEqual([null, null, true, 50]);
  });

  test.each([0, -1, 1.5])('staleGuilds refuses a limit of %p', async (limit) => {
    await expect(storeWith().store.staleGuilds(limit)).rejects.toThrow();
  });

  test('now reads the database clock, not the process clock', async () => {
    const at = '2026-09-22T08:00:00.000Z';
    const asDate = storeWith(() => [{ now: new Date(at) }]);
    const asText = storeWith(() => [{ now: '2026-09-22 08:00:00+00' }]);

    expect(await asDate.store.now()).toBe(at);
    expect(await asText.store.now()).toBe(at);
    expect(only(asDate.queries()).sql).toBe('select clock_timestamp() as now');
  });

  test('a check time, when given, stamps checked_at instead of the write time', async () => {
    const success = storeWith();
    await success.store.recordSuccess(GUILD, {
      scope: 'guild',
      hash: 'abc',
      commands: [BAN],
      checkedAt: CHECKED,
    });
    const successQuery = only(success.queries());
    expect(successQuery.sql).toMatch(
      /coalesce\(\$\d+::timestamptz, now\(\)\), now\(\), null::jsonb/,
    );
    expect(successQuery.params).toContain(CHECKED);

    const checked = storeWith();
    await checked.store.recordChecked(GUILD, { scope: 'guild', hash: 'abc', checkedAt: CHECKED });
    const checkedQuery = only(checked.queries());
    expect(checkedQuery.sql).toContain('"checked_at" = $2::timestamptz');
    expect(checkedQuery.params).toEqual(['guild', CHECKED, GUILD, 'abc', GUILD]);

    const failed = storeWith();
    await failed.store.recordFailure(GUILD, {
      scope: 'guild',
      failure: FAILURE,
      checkedAt: CHECKED,
    });
    const failedQuery = only(failed.queries());
    expect(failedQuery.sql).toMatch(/coalesce\(\$\d+::timestamptz, now\(\)\) where exists/);
    expect(failedQuery.params).toContain(CHECKED);
  });

  test('without a check time the write time is used, as before', async () => {
    const { store, queries } = storeWith();

    await store.recordSuccess(GUILD, { scope: 'guild', hash: 'abc', commands: [] });
    await store.recordFailure(GUILD, { scope: 'guild', failure: FAILURE });

    for (const query of queries()) expect(query.params).toContain(null);
  });

  test('recordHeld keeps the failure, points it at the hash now expected, and stamps the check', async () => {
    const { store, queries } = storeWith();

    expect(
      await store.recordHeld(GUILD, { scope: 'every-guild', hash: 'next', checkedAt: CHECKED }),
    ).toBe(true);

    const query = only(queries());
    expect(query.sql).toStartWith('update guild_command_registrations as r set');
    expect(query.sql).toContain("failure = jsonb_set(r.failure, '{hash}', to_jsonb($2::text))");
    expect(query.sql).toContain('checked_at = coalesce($3::timestamptz, now())');
    expect(query.sql).toContain("jsonb_typeof(r.failure) = 'object'");
    expect(query.sql).toContain(
      'exists (select 1 from guilds g where g.id = $5 and g.left_at is null)',
    );
    expect(query.sql).not.toContain('insert');
    expect(query.params).toEqual(['every-guild', 'next', CHECKED, GUILD, GUILD]);
    expect(
      await storeWith(() => []).store.recordHeld(GUILD, { scope: 'guild', hash: 'next' }),
    ).toBe(false);
  });

  test('recordHeld refuses an empty hash before it writes', async () => {
    const { store, queries } = storeWith();

    await expect(store.recordHeld(GUILD, { scope: 'guild', hash: '' })).rejects.toThrow();
    expect(queries()).toHaveLength(0);
  });
});
