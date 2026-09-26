import { describe, expect, test } from 'bun:test';
import {
  type CommandWorkerView,
  commandCatalogue,
  commandSetHash,
  effectiveCommandSet,
  RestTimeoutError,
} from '@proton/core';
import type { CommandRegistrationFailure } from '@proton/db';
import {
  ACCESS_RETRY_CAP_MS,
  ACCESS_RETRY_MS,
  accessWait,
  BACKOFF_CAP_MS,
  CommandRecordCache,
  type CommandRegistrationRail,
  CommandSettingsProvider,
  CommandSyncer,
  CommandSyncQueue,
  commandsPath,
  DAILY_LIMIT_MS,
  describeFailure,
  HttpCommandWorkerViews,
  putCommands,
  RETRY_MARGIN_MS,
  type ReconcileOptions,
  type ReconcileOutcome,
  RegistrationScopeError,
  rollbackGuildCommands,
  type SyncTimers,
} from '../src/command-sync.ts';
import {
  APPLICATION,
  collectingLogger,
  commandRegistry,
  FakeDiscord,
  MemoryRegistrations,
  MemoryViews,
  OTHER_GUILD,
  TEST_GUILD,
  THIRD_GUILD,
  viewOf,
} from './command-fakes.ts';

const NOW = Date.parse('2026-09-22T12:00:00.000Z');
const GUILD_RAIL: CommandRegistrationRail = {
  applicationId: APPLICATION,
  scope: 'guild',
  testGuildId: TEST_GUILD,
};
const EVERY_RAIL: CommandRegistrationRail = { applicationId: APPLICATION, scope: 'every-guild' };
const ALL_ON = { ping: true, help: true, moderation: true };

function harness(rail: CommandRegistrationRail = GUILD_RAIL) {
  const rest = new FakeDiscord();
  const views = new MemoryViews();
  const store = new MemoryRegistrations();
  const records = new CommandRecordCache(store);
  const { logger, lines } = collectingLogger();
  const clock = { now: NOW };
  const waits: number[] = [];
  const syncer = new CommandSyncer({
    rest,
    rail,
    catalogue: commandCatalogue(commandRegistry()),
    views,
    store,
    records,
    logger,
    now: () => clock.now,
    sleep: async (ms) => {
      waits.push(ms);
    },
  });

  return { rest, views, store, records, syncer, lines, clock, waits };
}

type Body = { id?: string; name: string; type?: number; description?: string };

function lastBody(rest: FakeDiscord): Body[] {
  const put = rest.puts().at(-1);
  if (!put) throw new Error('nothing was PUT');
  return put.body as Body[];
}

function names(body: Body[]): string[] {
  return body.map((command) => command.name).sort();
}

describe('the test-guild safety rail', () => {
  test('reconciling any other guild in guild scope makes no REST call and reads nothing', async () => {
    const { rest, views, store, syncer } = harness();

    expect(await syncer.reconcile(OTHER_GUILD)).toEqual({ status: 'out-of-scope' });
    expect(await syncer.reconcile(OTHER_GUILD, { skipHash: true, ignoreHolds: true })).toEqual({
      status: 'out-of-scope',
    });

    expect(rest.calls).toEqual([]);
    expect(views.reads).toBe(0);
    expect(store.calls).toEqual([]);
  });

  test('the one function that PUTs refuses another guild before any call', async () => {
    const rest = new FakeDiscord();

    expect(() => putCommands(rest, GUILD_RAIL, OTHER_GUILD, [])).toThrow(RegistrationScopeError);
    expect(rest.calls).toEqual([]);
  });

  test('guild scope never touches the global commands endpoints', async () => {
    const { rest, syncer } = harness();

    expect(() => putCommands(rest, GUILD_RAIL, null, [])).toThrow(/global commands/);
    expect((await syncer.retireGlobal([TEST_GUILD])).status).toBe('none');
    await syncer.reconcile(TEST_GUILD);

    expect(rest.calls.some((call) => call.path === `/applications/${APPLICATION}/commands`)).toBe(
      false,
    );
  });

  test('guild scope without a test guild refuses every guild', () => {
    const rail: CommandRegistrationRail = { applicationId: APPLICATION, scope: 'guild' };

    expect(() => commandsPath(rail, TEST_GUILD)).toThrow(RegistrationScopeError);
  });

  test('every-guild scope with a test guild set refuses everything', () => {
    const rail: CommandRegistrationRail = { ...EVERY_RAIL, testGuildId: TEST_GUILD };

    expect(() => commandsPath(rail, TEST_GUILD)).toThrow(RegistrationScopeError);
    expect(() => commandsPath(rail, null)).toThrow(RegistrationScopeError);
  });

  test('the test guild PUTs to its own guild endpoint with a timeout', async () => {
    const { rest, views, syncer } = harness();
    views.views.set(TEST_GUILD, viewOf(ALL_ON));

    await syncer.reconcile(TEST_GUILD);

    const put = rest.puts()[0];
    expect(put?.path).toBe(`/applications/${APPLICATION}/guilds/${TEST_GUILD}/commands`);
    expect(put?.timeoutMs).toBe(60_000);
  });
});

describe('CommandSyncer.reconcile', () => {
  test('registers the effective set in one PUT and records the ids Discord returned', async () => {
    const { rest, views, store, records, syncer } = harness();
    views.views.set(TEST_GUILD, viewOf(ALL_ON));

    expect(await syncer.reconcile(TEST_GUILD)).toEqual({ status: 'registered', count: 8 });

    expect(names(lastBody(rest))).toEqual(
      ['Punish author', 'Report user', 'ban', 'help', 'kick', 'ping', 'timeout', 'warn'].sort(),
    );

    const record = store.records.get(TEST_GUILD);
    const discord = rest.guildCommands.get(TEST_GUILD) ?? [];
    expect(record?.commands.find((c) => c.key === 'ban')?.id).toBe(
      discord.find((c) => c.name === 'ban')?.id ?? 'missing',
    );
    expect(record?.commands.find((c) => c.key === 'user:Report user')?.kind).toBe('user');
    expect(record?.definitionHash).toMatch(/^[0-9a-f]{64}$/);
    expect((await records.get(TEST_GUILD))?.definitionHash).toBe(record?.definitionHash ?? '');
  });

  test('an unchanged set is only recorded as checked, with no PUT', async () => {
    const { rest, views, store, syncer } = harness();
    views.views.set(TEST_GUILD, viewOf(ALL_ON));

    await syncer.reconcile(TEST_GUILD);
    expect(await syncer.reconcile(TEST_GUILD)).toEqual({ status: 'unchanged' });

    expect(rest.puts()).toHaveLength(1);
    expect(store.calls).toContain(`recordChecked:${TEST_GUILD}`);
  });

  test('a reconcile that skips the hash PUTs even when nothing changed', async () => {
    const { rest, views, syncer } = harness();
    views.views.set(TEST_GUILD, viewOf(ALL_ON));

    await syncer.reconcile(TEST_GUILD);
    expect((await syncer.reconcile(TEST_GUILD, { skipHash: true })).status).toBe('registered');

    expect(rest.puts()).toHaveLength(2);
  });

  test('only a renamed command carries its id, so Discord renames it in place', async () => {
    const { rest, views, store, syncer } = harness();
    views.views.set(TEST_GUILD, viewOf(ALL_ON));
    await syncer.reconcile(TEST_GUILD);
    const banId = store.records.get(TEST_GUILD)?.commands.find((c) => c.key === 'ban')?.id;

    views.views.set(
      TEST_GUILD,
      viewOf(ALL_ON, { ban: { name: 'punish', updatedAt: '2026-09-22T11:00:00.000Z' } }),
    );
    await syncer.reconcile(TEST_GUILD);

    const body = lastBody(rest);
    expect(body.find((c) => c.name === 'punish')?.id).toBe(banId ?? 'missing');
    expect(body.filter((c) => c.id !== undefined)).toHaveLength(1);
    expect(store.records.get(TEST_GUILD)?.idHistory[banId ?? '']).toBe('ban');
  });

  test('a refused PUT with ids is sent once more without them', async () => {
    const { rest, views, store, syncer, lines } = harness();
    views.views.set(TEST_GUILD, viewOf(ALL_ON));
    await syncer.reconcile(TEST_GUILD);
    views.views.set(
      TEST_GUILD,
      viewOf(ALL_ON, { ban: { name: 'punish', updatedAt: '2026-09-22T11:00:00.000Z' } }),
    );
    rest.failNext(() => ({
      status: 404,
      body: { message: 'Unknown application command', code: 10063 },
    }));

    expect((await syncer.reconcile(TEST_GUILD)).status).toBe('registered');

    const carriesIds = rest
      .puts()
      .map((put) => (put.body as Body[]).some((c) => c.id !== undefined));
    expect(carriesIds).toEqual([false, true, false]);
    expect(store.records.get(TEST_GUILD)?.failure).toBeNull();
    expect(lines.some((line) => line.includes('without them'))).toBe(true);
  });

  test.each([
    [403, 50001],
    [401, 0],
    [429, 0],
    [400, 30034],
  ])('a %i (code %i) with ids is not retried without them', async (status, code) => {
    const { rest, views, syncer } = harness();
    views.views.set(TEST_GUILD, viewOf(ALL_ON));
    await syncer.reconcile(TEST_GUILD);
    views.views.set(
      TEST_GUILD,
      viewOf(ALL_ON, { ban: { name: 'punish', updatedAt: '2026-09-22T11:00:00.000Z' } }),
    );
    rest.failNext(() => ({ status, body: { message: 'no', code, retry_after: 2 } }));

    expect((await syncer.reconcile(TEST_GUILD)).status).toBe('failed');
    expect(rest.puts()).toHaveLength(2);
  });

  test('a changed module switch is seen at once, because a sync reads the view uncached', async () => {
    const { rest, views, syncer } = harness();
    const dispatch = new CommandSettingsProvider(views, { ttlMs: 60_000, now: () => NOW });

    views.views.set(TEST_GUILD, viewOf({ ping: true }));
    await dispatch.get(TEST_GUILD);
    await syncer.reconcile(TEST_GUILD);

    views.views.set(TEST_GUILD, viewOf({ ping: true, moderation: true }));
    await dispatch.get(TEST_GUILD);
    await syncer.reconcile(TEST_GUILD);

    expect(names(lastBody(rest))).toContain('ban');
    expect(rest.puts()).toHaveLength(2);
  });

  test('changing only the reply visibility never re-registers', async () => {
    const { rest, views, syncer } = harness();
    views.views.set(TEST_GUILD, viewOf(ALL_ON));
    await syncer.reconcile(TEST_GUILD);

    views.views.set(TEST_GUILD, viewOf(ALL_ON, { ban: { privateReply: false } }));

    expect(await syncer.reconcile(TEST_GUILD)).toEqual({ status: 'unchanged' });
    expect(rest.puts()).toHaveLength(1);
  });

  test('a switched-off command and a switched-off module are left out', async () => {
    const { rest, views, syncer } = harness();
    views.views.set(
      TEST_GUILD,
      viewOf({ ping: false, help: true, moderation: true }, { kick: { enabled: false } }),
    );

    await syncer.reconcile(TEST_GUILD);

    const sent = names(lastBody(rest));
    expect(sent).not.toContain('kick');
    expect(sent).not.toContain('ping');
    expect(sent).toContain('ban');
  });

  test('/help stays registered while every module is off', async () => {
    const { rest, views, syncer } = harness();
    views.views.set(TEST_GUILD, viewOf({}));

    await syncer.reconcile(TEST_GUILD);

    expect(names(lastBody(rest))).toEqual(['help']);
  });

  test('a view that cannot be read touches neither Discord nor the record', async () => {
    const { rest, views, store, syncer } = harness();
    views.failWith = new Error('api returned 503');

    const outcome = await syncer.reconcile(TEST_GUILD);

    expect(outcome).toEqual({ status: 'error', retryInMs: 5_000 });
    expect(rest.calls).toEqual([]);
    expect(store.calls.filter((call) => call.startsWith('record'))).toEqual([]);
  });

  test('a PUT that times out is recorded as possibly applied and retried with backoff', async () => {
    const { rest, views, store, syncer } = harness();
    views.views.set(TEST_GUILD, viewOf(ALL_ON));
    rest.failNext((options) =>
      options.method === 'PUT' ? new RestTimeoutError('PUT', options.path, 60_000) : undefined,
    );

    const outcome = await syncer.reconcile(TEST_GUILD);

    expect(outcome.status).toBe('failed');
    expect(outcome.status === 'failed' ? outcome.retryInMs : null).toBe(5_000);
    const failure = store.records.get(TEST_GUILD)?.failure;
    expect(failure?.status).toBeNull();
    expect(failure?.message).toContain("can't tell whether");
    expect(store.records.get(TEST_GUILD)?.definitionHash).toBeNull();
  });

  test('5xx backoff doubles up to the cap and then leaves the retry to the sweep', async () => {
    const { rest, views, syncer, clock } = harness();
    views.views.set(TEST_GUILD, viewOf(ALL_ON));
    const waits: Array<number | null> = [];

    for (let attempt = 0; attempt < 9; attempt += 1) {
      rest.failNext(() => ({ status: 502, body: { code: 'rest_proxy_upstream_failure' } }));
      const outcome = await syncer.reconcile(TEST_GUILD);
      waits.push(outcome.status === 'failed' ? outcome.retryInMs : -1);
      clock.now += BACKOFF_CAP_MS + 1;
    }

    expect(waits).toEqual([5_000, 10_000, 20_000, 40_000, 80_000, 160_000, 320_000, null, null]);
  });

  test('success resets the backoff', async () => {
    const { rest, views, syncer, clock } = harness();
    views.views.set(TEST_GUILD, viewOf(ALL_ON));

    rest.failNext(() => ({ status: 500, body: 'boom' }));
    await syncer.reconcile(TEST_GUILD);
    clock.now += 10_000;
    await syncer.reconcile(TEST_GUILD);
    rest.failNext(() => ({ status: 500, body: 'boom' }));
    const outcome = await syncer.reconcile(TEST_GUILD, { skipHash: true });

    expect(outcome.status === 'failed' ? outcome.retryInMs : null).toBe(5_000);
  });

  test('the daily create limit waits 24 hours before the next attempt', async () => {
    const { rest, views, store, syncer, clock } = harness();
    views.views.set(TEST_GUILD, viewOf(ALL_ON));
    rest.failNext(() => ({
      status: 400,
      body: { message: 'Max number of daily application command creates', code: 30034 },
    }));

    const failed = await syncer.reconcile(TEST_GUILD);
    expect(failed.status === 'failed' ? failed.retryInMs : 'x').toBeNull();
    expect(store.records.get(TEST_GUILD)?.failure?.retryAt).toBe(
      new Date(NOW + DAILY_LIMIT_MS).toISOString(),
    );

    clock.now += 60_000;
    expect(await syncer.reconcile(TEST_GUILD)).toEqual({
      status: 'held',
      reason: 'retry-later',
      retryInMs: null,
    });
    expect(rest.puts()).toHaveLength(1);

    clock.now = NOW + DAILY_LIMIT_MS + 1;
    expect((await syncer.reconcile(TEST_GUILD)).status).toBe('registered');
  });

  test('missing access waits an hour, then is tried again with nothing else changing', async () => {
    const { rest, views, store, syncer, clock } = harness();
    views.views.set(TEST_GUILD, viewOf(ALL_ON));
    rest.failNext(() => ({ status: 403, body: { message: 'Missing Access', code: 50001 } }));

    const failed = await syncer.reconcile(TEST_GUILD);
    expect(failed.status === 'failed' ? failed.retryInMs : 'x').toBeNull();
    expect(store.records.get(TEST_GUILD)?.failure?.retryAt).toBe(
      new Date(NOW + ACCESS_RETRY_MS).toISOString(),
    );

    views.views.set(TEST_GUILD, viewOf({ ping: true }));
    clock.now += 60_000;
    expect(await syncer.reconcile(TEST_GUILD)).toEqual({
      status: 'held',
      reason: 'no-access',
      retryInMs: null,
    });
    expect(rest.puts()).toHaveLength(1);

    clock.now = NOW + ACCESS_RETRY_MS + 1;
    expect((await syncer.reconcile(TEST_GUILD)).status).toBe('registered');
  });

  test('a GUILD_CREATE lifts an access hold at once', async () => {
    const { rest, views, syncer } = harness();
    views.views.set(TEST_GUILD, viewOf(ALL_ON));
    rest.failNext(() => ({ status: 403, body: { message: 'Missing Access', code: 50001 } }));
    await syncer.reconcile(TEST_GUILD);

    expect((await syncer.reconcile(TEST_GUILD, { ignoreHolds: true })).status).toBe('registered');
  });

  test('access failures in a row double the wait from the stored failure, up to a day', async () => {
    const { rest, views, store, syncer, clock } = harness();
    views.views.set(TEST_GUILD, viewOf(ALL_ON));
    const hours: number[] = [];

    for (let attempt = 0; attempt < 7; attempt += 1) {
      rest.failNext(() => ({ status: 403, body: { message: 'Missing Access', code: 50001 } }));
      expect((await syncer.reconcile(TEST_GUILD)).status).toBe('failed');
      const failure = store.records.get(TEST_GUILD)?.failure;
      const retryAt = Date.parse(failure?.retryAt ?? '');
      hours.push((retryAt - Date.parse(failure?.at ?? '')) / 3_600_000);
      clock.now = retryAt + 1;
    }

    expect(hours).toEqual([1, 2, 4, 8, 16, 24, 24]);
    expect(rest.puts()).toHaveLength(7);
  });

  test('a 401 is retried with backoff like an outage, not held as this server’s access', async () => {
    const { rest, views, store, syncer, clock } = harness();
    views.views.set(TEST_GUILD, viewOf(ALL_ON));
    rest.failNext(() => ({ status: 401, body: { message: '401: Unauthorized', code: 0 } }));

    const failed = await syncer.reconcile(TEST_GUILD);
    expect(failed.status === 'failed' ? failed.retryInMs : null).toBe(5_000);
    expect(store.records.get(TEST_GUILD)?.failure?.message).toContain(
      "Discord rejected Proton's own credentials",
    );

    clock.now += 5_001;
    expect((await syncer.reconcile(TEST_GUILD)).status).toBe('registered');
  });

  test('a held server records its cause against the set now expected and stamps the check', async () => {
    const { rest, views, store, syncer } = harness();
    views.views.set(TEST_GUILD, viewOf(ALL_ON));
    rest.failNext(() => ({ status: 403, body: { message: 'Missing Access', code: 50001 } }));
    await syncer.reconcile(TEST_GUILD);
    const before = store.records.get(TEST_GUILD)?.failure;

    const renamed = viewOf(ALL_ON, {
      ban: { name: 'punish', updatedAt: '2026-09-22T11:00:00.000Z' },
    });
    views.views.set(TEST_GUILD, renamed);
    store.clock = () => '2026-09-22T12:30:00.000Z';
    expect((await syncer.reconcile(TEST_GUILD)).status).toBe('held');

    const expected = await commandSetHash(
      effectiveCommandSet({
        catalogue: commandCatalogue(commandRegistry()),
        modulesOn: renamed.modulesOn,
        settings: renamed.settings,
        recorded: [],
      }).commands,
    );
    const record = store.records.get(TEST_GUILD);
    expect(expected).not.toBe(before?.hash ?? '');
    expect(record?.failure).toEqual({ ...before, hash: expected } as typeof before);
    expect(record?.checkedAt).toBe('2026-09-22T12:29:55.000Z');
    expect(store.calls).toContain(`recordHeld:${TEST_GUILD}`);
  });

  test('a held refusal is stamped too, so the sweep stops picking it up', async () => {
    const { rest, views, store, syncer } = harness();
    views.views.set(TEST_GUILD, viewOf(ALL_ON));
    rest.failNext(() => ({ status: 400, body: { message: 'Invalid Form Body', code: 50035 } }));
    await syncer.reconcile(TEST_GUILD);
    store.clock = () => '2026-09-22T13:00:00.000Z';

    expect((await syncer.reconcile(TEST_GUILD)).status).toBe('held');
    expect(store.records.get(TEST_GUILD)?.checkedAt).toBe('2026-09-22T12:59:55.000Z');
  });

  test('every record stamps the database time read before the view, less a margin', async () => {
    const { rest, views, store, records, syncer } = harness();
    const order: string[] = [];
    const now = store.now.bind(store);
    store.now = async () => {
      order.push('clock');
      return now();
    };
    const view = views.get.bind(views);
    views.get = async (guildId) => {
      order.push('view');
      return view(guildId);
    };
    views.views.set(TEST_GUILD, viewOf(ALL_ON));

    store.clock = () => '2026-09-22T09:00:00.000Z';
    await syncer.reconcile(TEST_GUILD);
    expect(order).toEqual(['clock', 'view']);
    expect(store.records.get(TEST_GUILD)?.checkedAt).toBe('2026-09-22T08:59:55.000Z');
    expect((await records.get(TEST_GUILD))?.checkedAt).toBe('2026-09-22T08:59:55.000Z');

    store.clock = () => '2026-09-22T09:10:00.000Z';
    expect((await syncer.reconcile(TEST_GUILD)).status).toBe('unchanged');
    expect(store.records.get(TEST_GUILD)?.checkedAt).toBe('2026-09-22T09:09:55.000Z');

    store.clock = () => '2026-09-22T09:20:00.000Z';
    views.views.set(TEST_GUILD, viewOf({ ping: true }));
    rest.failNext(() => ({ status: 500, body: 'boom' }));
    expect((await syncer.reconcile(TEST_GUILD)).status).toBe('failed');
    expect(store.records.get(TEST_GUILD)?.checkedAt).toBe('2026-09-22T09:19:55.000Z');
  });

  test('a database clock that cannot be read is retried like an unreadable view', async () => {
    const { rest, views, store, syncer } = harness();
    views.views.set(TEST_GUILD, viewOf(ALL_ON));
    store.now = async () => {
      throw new Error('database unreachable');
    };

    expect(await syncer.reconcile(TEST_GUILD)).toEqual({ status: 'error', retryInMs: 5_000 });
    expect(rest.calls).toEqual([]);
    expect(views.reads).toBe(0);
  });

  test('skipping the hash still respects a refusal of this very set', async () => {
    const { rest, views, syncer } = harness();
    views.views.set(TEST_GUILD, viewOf(ALL_ON));
    rest.failNext(() => ({ status: 400, body: { message: 'Invalid Form Body', code: 50035 } }));
    await syncer.reconcile(TEST_GUILD);

    expect(await syncer.reconcile(TEST_GUILD, { skipHash: true })).toEqual({
      status: 'held',
      reason: 'refused',
      retryInMs: null,
    });
    expect(rest.puts()).toHaveLength(1);

    expect((await syncer.reconcile(TEST_GUILD, { skipHash: true, ignoreHolds: true })).status).toBe(
      'registered',
    );
  });

  test('skipping the hash still waits out the daily create limit', async () => {
    const { rest, views, syncer } = harness();
    views.views.set(TEST_GUILD, viewOf(ALL_ON));
    rest.failNext(() => ({
      status: 400,
      body: { message: 'Max number of daily application command creates', code: 30034 },
    }));
    await syncer.reconcile(TEST_GUILD);

    expect((await syncer.reconcile(TEST_GUILD, { skipHash: true })).status).toBe('held');
    expect(rest.puts()).toHaveLength(1);
  });

  test('lifting access retries an access hold at once, and no other hold', async () => {
    const lift = { skipHash: true, liftAccess: true };
    const heldBy = async (status: number, code: number) => {
      const h = harness();
      h.views.views.set(TEST_GUILD, viewOf(ALL_ON));
      h.rest.failNext(() => ({ status, body: { message: 'no', code } }));
      expect((await h.syncer.reconcile(TEST_GUILD)).status).toBe('failed');
      return h;
    };

    const access = await heldBy(403, 50001);
    expect((await access.syncer.reconcile(TEST_GUILD, { skipHash: true })).status).toBe('held');
    expect(access.rest.puts()).toHaveLength(1);
    expect((await access.syncer.reconcile(TEST_GUILD, lift)).status).toBe('registered');
    expect(access.rest.puts()).toHaveLength(2);

    const refused = await heldBy(400, 50035);
    expect(await refused.syncer.reconcile(TEST_GUILD, lift)).toEqual({
      status: 'held',
      reason: 'refused',
      retryInMs: null,
    });
    expect(refused.rest.puts()).toHaveLength(1);

    const daily = await heldBy(400, 30034);
    expect((await daily.syncer.reconcile(TEST_GUILD, lift)).status).toBe('held');
    expect(daily.rest.puts()).toHaveLength(1);
  });

  test('a refused PUT is not resent without ids when that would move an id to another command', async () => {
    const { rest, views, store, syncer, lines } = harness();
    views.views.set(
      TEST_GUILD,
      viewOf(ALL_ON, { warn: { name: 'x', updatedAt: '2026-09-22T10:00:00.000Z' } }),
    );
    await syncer.reconcile(TEST_GUILD);
    const warnId = store.records.get(TEST_GUILD)?.commands.find((c) => c.key === 'warn')?.id;
    const history = store.records.get(TEST_GUILD)?.idHistory;

    views.views.set(
      TEST_GUILD,
      viewOf(ALL_ON, { kick: { name: 'x', updatedAt: '2026-09-22T11:00:00.000Z' } }),
    );
    rest.failNext((options) =>
      options.method === 'PUT' && (options.body as Body[]).some((c) => c.id !== undefined)
        ? { status: 400, body: { message: 'Invalid Form Body', code: 50035 } }
        : undefined,
    );

    const outcome = await syncer.reconcile(TEST_GUILD);

    expect(outcome.status).toBe('failed');
    expect(rest.puts()).toHaveLength(2);
    expect(rest.guildCommands.get(TEST_GUILD)?.find((c) => c.name === 'x')?.id).toBe(
      warnId ?? 'missing',
    );
    expect(store.records.get(TEST_GUILD)?.idHistory).toEqual(history ?? {});
    expect(store.records.get(TEST_GUILD)?.failure?.code).toBe('50035');
    expect(lines.some((line) => line.includes("/warn's id to /kick"))).toBe(true);
  });

  test('a registration Discord took but the store could not record still routes by id here', async () => {
    const { rest, views, store, records, syncer } = harness();
    views.views.set(TEST_GUILD, viewOf(ALL_ON));
    store.recordSuccess = async () => {
      throw new Error('database unreachable');
    };

    expect((await syncer.reconcile(TEST_GUILD)).status).toBe('registered');

    const banId = rest.guildCommands.get(TEST_GUILD)?.find((c) => c.name === 'ban')?.id ?? '';
    const cached = await records.get(TEST_GUILD);
    expect(cached?.idHistory[banId]).toBe('ban');
    expect(cached?.commands.find((c) => c.key === 'ban')?.id).toBe(banId);
    expect(cached?.syncedAt).toBeNull();
    expect(store.records.has(TEST_GUILD)).toBe(false);
    expect(await records.stored(TEST_GUILD)).toBeNull();
  });

  test('while a registration is unrecorded the stored hash is not trusted, until one is recorded', async () => {
    const { rest, views, store, records, syncer } = harness();
    views.views.set(TEST_GUILD, viewOf(ALL_ON));
    await syncer.reconcile(TEST_GUILD);

    const recordSuccess = store.recordSuccess.bind(store);
    store.recordSuccess = async () => {
      throw new Error('database unreachable');
    };
    views.views.set(
      TEST_GUILD,
      viewOf(ALL_ON, { ban: { name: 'punish', updatedAt: '2026-09-22T11:00:00.000Z' } }),
    );
    expect((await syncer.reconcile(TEST_GUILD)).status).toBe('registered');
    expect(records.pinned(TEST_GUILD)).toBe(true);

    store.recordSuccess = recordSuccess;
    views.views.set(TEST_GUILD, viewOf(ALL_ON));
    expect((await syncer.reconcile(TEST_GUILD)).status).toBe('registered');
    expect(rest.guildCommands.get(TEST_GUILD)?.some((c) => c.name === 'ban')).toBe(true);
    expect(records.pinned(TEST_GUILD)).toBe(false);

    expect((await syncer.reconcile(TEST_GUILD)).status).toBe('unchanged');
    expect(rest.puts()).toHaveLength(3);
  });

  test('an invalid-form refusal is held while the set is unchanged, and retried once it changes', async () => {
    const { rest, views, store, syncer } = harness();
    views.views.set(TEST_GUILD, viewOf(ALL_ON));
    rest.failNext(() => ({
      status: 400,
      body: { message: 'Invalid Form Body', code: 50035, errors: { 0: { name: 'bad' } } },
    }));
    await syncer.reconcile(TEST_GUILD);
    expect(store.records.get(TEST_GUILD)?.failure?.detail).toContain('"name":"bad"');

    expect((await syncer.reconcile(TEST_GUILD)).status).toBe('held');

    views.views.set(TEST_GUILD, viewOf({ ping: true, help: true }));
    expect((await syncer.reconcile(TEST_GUILD)).status).toBe('registered');
  });
});

describe('describeFailure', () => {
  const context = { at: NOW, hash: 'h', backoffMs: 5_000 };
  const ACCESS =
    "Proton can't manage commands in this server because it's missing the " +
    'applications.commands scope. Add Proton to the server again to grant it.';

  test.each([
    [403, 50001, ACCESS, ACCESS_RETRY_MS],
    [403, 0, ACCESS, ACCESS_RETRY_MS],
    [401, 0, "Discord rejected Proton's own credentials", 5_000],
    [400, 30034, 'Discord allows 200 new commands per server per day', DAILY_LIMIT_MS],
    [400, 30032, "reached Discord's limit on commands", null],
    [400, 50035, 'refused the command definitions as invalid', null],
    [500, 0, "couldn't reach Discord", 5_000],
  ])('HTTP %i code %i', (status, code, message, wait) => {
    const failure = describeFailure(
      { status, body: { message: 'Discord text', code, errors: { a: 1 } } },
      context,
    );

    expect(failure.message).toContain(message);
    expect(failure.detail).toContain('Discord text');
    expect(failure.code).toBe(String(code));
    expect(failure.status).toBe(status);
    expect(failure.hash).toBe('h');
    expect(failure.retryAt).toBe(wait === null ? null : new Date(NOW + wait).toISOString());
  });

  test('a rate limit waits as long as Discord asked', () => {
    const failure = describeFailure(
      { status: 429, body: { message: 'You are being rate limited.', retry_after: 12.5 } },
      context,
    );

    expect(failure.retryAt).toBe(new Date(NOW + 12_500).toISOString());
    expect(failure.message).toContain('rate limiting');
  });

  test('an access failure waits as long as the stored one said, doubled, up to a day', () => {
    const failure = (retryInMs: number | null, status = 403): CommandRegistrationFailure => ({
      code: status === 403 ? '50001' : null,
      status,
      message: 'm',
      detail: 'd',
      at: new Date(NOW).toISOString(),
      retryAt: retryInMs === null ? null : new Date(NOW + retryInMs).toISOString(),
      hash: 'h',
    });

    expect(accessWait(null)).toBe(ACCESS_RETRY_MS);
    expect(accessWait(failure(ACCESS_RETRY_MS))).toBe(2 * ACCESS_RETRY_MS);
    expect(accessWait(failure(16 * ACCESS_RETRY_MS))).toBe(ACCESS_RETRY_CAP_MS);
    expect(accessWait(failure(ACCESS_RETRY_CAP_MS))).toBe(ACCESS_RETRY_CAP_MS);
    expect(accessWait(failure(null))).toBe(ACCESS_RETRY_MS);
    expect(accessWait(failure(40_000, 502))).toBe(ACCESS_RETRY_MS);
    expect(
      describeFailure(
        { status: 403, body: { code: 50001 } },
        { ...context, accessWaitMs: 4 * ACCESS_RETRY_MS },
      ).retryAt,
    ).toBe(new Date(NOW + 4 * ACCESS_RETRY_MS).toISOString());
  });

  test('a network failure keeps what went wrong as the detail', () => {
    const failure = describeFailure(
      { status: null, error: 'network', message: 'ECONNREFUSED 127.0.0.1:9001' },
      context,
    );

    expect(failure.status).toBeNull();
    expect(failure.code).toBeNull();
    expect(failure.detail).toBe('ECONNREFUSED 127.0.0.1:9001');
  });
});

describe('lost Integrations permissions', () => {
  function migrating() {
    const h = harness(EVERY_RAIL);
    h.rest.globals = [
      { id: '1100000000000000001', name: 'ban', type: 1 },
      { id: '1100000000000000002', name: 'Report user', type: 2 },
      { id: '1100000000000000003', name: 'ping', type: 1 },
    ];
    h.rest.permissions.set(TEST_GUILD, [
      { id: APPLICATION, permissions: [{ id: '1', type: 1, permission: false }] },
      { id: '1100000000000000001', permissions: [{ id: '2', type: 1, permission: true }] },
      { id: '1100000000000000002', permissions: [{ id: '3', type: 2, permission: false }] },
      { id: '1100000000000000003', permissions: [] },
      { id: '1260000000000000009', permissions: [{ id: '4', type: 1, permission: true }] },
    ]);
    h.views.views.set(TEST_GUILD, viewOf(ALL_ON));
    return h;
  }

  test('records only global commands that had their own overrides', async () => {
    const { store, syncer } = migrating();

    await syncer.reconcile(TEST_GUILD);

    expect(store.records.get(TEST_GUILD)?.lostPermissions?.commands).toEqual([
      { key: 'ban', name: 'ban' },
      { key: 'user:Report user', name: 'Report user' },
    ]);
    expect(store.records.get(TEST_GUILD)?.permissionsCheckedAt).not.toBeNull();
  });

  test('is read once per guild, and never in guild scope', async () => {
    const { rest, syncer } = migrating();

    await syncer.reconcile(TEST_GUILD);
    await syncer.reconcile(TEST_GUILD, { skipHash: true });

    const permissionReads = rest.calls.filter((call) => call.path.endsWith('/permissions'));
    expect(permissionReads).toHaveLength(1);

    const scoped = harness();
    scoped.views.views.set(TEST_GUILD, viewOf(ALL_ON));
    await scoped.syncer.reconcile(TEST_GUILD);
    expect(scoped.rest.calls.filter((call) => call.method === 'GET')).toEqual([]);
  });

  test('is skipped once the global set is gone', async () => {
    const { rest, store, syncer } = migrating();
    rest.globals = [];

    await syncer.reconcile(TEST_GUILD);

    expect(rest.calls.some((call) => call.path.endsWith('/permissions'))).toBe(false);
    expect(store.records.get(TEST_GUILD)?.permissionsCheckedAt).toBeNull();
  });
});

describe('retiring the global commands', () => {
  function fleet() {
    const h = harness(EVERY_RAIL);
    h.rest.globals = [{ id: '1100000000000000001', name: 'ping', type: 1 }];
    for (const guildId of [TEST_GUILD, OTHER_GUILD, THIRD_GUILD]) {
      h.views.views.set(guildId, viewOf(ALL_ON));
    }
    return h;
  }

  test('waits for every guild, names the blockers, and excepts guilds Proton cannot manage', async () => {
    const { rest, syncer, lines } = fleet();
    await syncer.reconcile(TEST_GUILD);
    rest.failNext((options) =>
      options.method === 'PUT'
        ? { status: 403, body: { message: 'Missing Access', code: 50001 } }
        : undefined,
    );
    await syncer.reconcile(OTHER_GUILD);

    const kept = await syncer.retireGlobal([TEST_GUILD, OTHER_GUILD, THIRD_GUILD]);
    expect(kept).toEqual({
      status: 'kept',
      blockers: [{ guildId: THIRD_GUILD, reason: 'unsynced' }],
    });
    expect(rest.globals).toHaveLength(1);
    expect(lines.some((line) => line.includes(`${THIRD_GUILD} (unsynced)`))).toBe(true);
    expect(lines.some((line) => line.includes("can't manage commands in 1 server(s)"))).toBe(true);

    await syncer.reconcile(THIRD_GUILD);
    expect((await syncer.retireGlobal([TEST_GUILD, OTHER_GUILD, THIRD_GUILD])).status).toBe(
      'retired',
    );

    const retire = rest.puts().at(-1);
    expect(retire?.path).toBe(`/applications/${APPLICATION}/commands`);
    expect(retire?.body).toEqual([]);
    expect(syncer.globalRetired).toBe(true);
  });

  test('a guild whose settings moved since its last sync holds it up', async () => {
    const { rest, views, syncer, lines } = fleet();
    await syncer.reconcile(TEST_GUILD);
    views.views.set(TEST_GUILD, viewOf({ ping: true }));

    expect(await syncer.retireGlobal([TEST_GUILD])).toEqual({
      status: 'kept',
      blockers: [{ guildId: TEST_GUILD, reason: 'pending' }],
    });
    expect(lines.some((line) => line.includes(`${TEST_GUILD} (pending)`))).toBe(true);
    expect(rest.globals).toHaveLength(1);
  });

  test('a guild whose Integrations permissions were never read holds it up', async () => {
    const { rest, syncer, lines } = fleet();
    rest.failNext((options) =>
      options.path.endsWith('/permissions') ? { status: 500, body: 'down' } : undefined,
    );
    await syncer.reconcile(TEST_GUILD);

    expect(await syncer.retireGlobal([TEST_GUILD])).toEqual({
      status: 'kept',
      blockers: [{ guildId: TEST_GUILD, reason: 'permissions-unchecked' }],
    });
    expect(lines.some((line) => line.includes('permissions-unchecked'))).toBe(true);
  });

  test('permissions are read again just before the global set is retired', async () => {
    const { rest, store, syncer, lines } = fleet();
    await syncer.reconcile(TEST_GUILD);
    expect(store.records.get(TEST_GUILD)?.lostPermissions).toBeNull();

    rest.permissions.set(TEST_GUILD, [
      { id: '1100000000000000001', permissions: [{ id: '2', type: 1, permission: true }] },
    ]);

    expect((await syncer.retireGlobal([TEST_GUILD])).status).toBe('retired');

    expect(store.records.get(TEST_GUILD)?.lostPermissions?.commands).toEqual([
      { key: 'ping', name: 'ping' },
    ]);
    const calls = rest.calls.map((call) => `${call.method} ${call.path}`);
    const reread = calls.lastIndexOf(
      `GET /applications/${APPLICATION}/guilds/${TEST_GUILD}/commands/permissions`,
    );
    const retired = calls.lastIndexOf(`PUT /applications/${APPLICATION}/commands`);
    expect(reread).toBeGreaterThan(
      calls.indexOf(`PUT /applications/${APPLICATION}/guilds/${TEST_GUILD}/commands`),
    );
    expect(reread).toBeLessThan(retired);
    expect(lines.some((line) => line.includes('1 more global command(s)'))).toBe(true);
  });

  test('a finding nobody has acked is kept alongside one made at retirement', async () => {
    const { rest, store, syncer } = fleet();
    rest.globals.push({ id: '1100000000000000002', name: 'kick', type: 1 });
    rest.permissions.set(TEST_GUILD, [
      { id: '1100000000000000002', permissions: [{ id: '2', type: 1, permission: true }] },
    ]);
    await syncer.reconcile(TEST_GUILD);

    rest.permissions.set(TEST_GUILD, [
      { id: '1100000000000000001', permissions: [{ id: '2', type: 1, permission: true }] },
      { id: '1100000000000000002', permissions: [{ id: '2', type: 1, permission: true }] },
    ]);
    await syncer.retireGlobal([TEST_GUILD]);

    expect(store.records.get(TEST_GUILD)?.lostPermissions?.commands).toEqual([
      { key: 'kick', name: 'kick' },
      { key: 'ping', name: 'ping' },
    ]);
  });

  test('a permissions read that keeps failing at retirement keeps the global set', async () => {
    const { rest, syncer, waits } = fleet();
    await syncer.reconcile(TEST_GUILD);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      rest.failNext((options) =>
        options.path.endsWith('/permissions') ? { status: 500, body: 'down' } : undefined,
      );
    }

    expect(await syncer.retireGlobal([TEST_GUILD])).toEqual({
      status: 'kept',
      blockers: [{ guildId: TEST_GUILD, reason: 'permissions-unreadable' }],
    });
    expect(rest.globals).toHaveLength(1);
    expect(waits).toEqual([1_000, 2_000]);

    expect((await syncer.retireGlobal([TEST_GUILD])).status).toBe('retired');
  });

  test('a permissions read that fails once at retirement is read again in the same pass', async () => {
    const { rest, syncer, waits } = fleet();
    for (const guildId of [TEST_GUILD, OTHER_GUILD, THIRD_GUILD]) {
      await syncer.reconcile(guildId);
    }
    const reads = () => rest.calls.filter((call) => call.path.endsWith('/permissions')).length;
    const before = reads();
    rest.failNext((options) =>
      options.path.includes(`/guilds/${OTHER_GUILD}/`) && options.path.endsWith('/permissions')
        ? { status: 502, body: 'bad gateway' }
        : undefined,
    );

    expect(await syncer.retireGlobal([TEST_GUILD, OTHER_GUILD, THIRD_GUILD])).toEqual({
      status: 'retired',
      blockers: [],
    });
    expect(reads() - before).toBe(4);
    expect(waits).toEqual([1_000]);
    expect(rest.globals).toEqual([]);
  });

  test('two checks at once retire the global set with one PUT', async () => {
    const { rest, syncer } = fleet();
    await syncer.reconcile(TEST_GUILD);

    const outcomes = await Promise.all([
      syncer.retireGlobal([TEST_GUILD]),
      syncer.retireGlobal([TEST_GUILD]),
    ]);

    expect(outcomes.map((outcome) => outcome.status)).toEqual(['retired', 'retired']);
    expect(
      rest.puts().filter((put) => put.path === `/applications/${APPLICATION}/commands`),
    ).toHaveLength(1);
  });

  test('is remembered once the global list is empty', async () => {
    const { rest, syncer } = fleet();
    rest.globals = [];

    expect((await syncer.retireGlobal([TEST_GUILD])).status).toBe('none');
    const calls = rest.calls.length;
    expect((await syncer.retireGlobal([TEST_GUILD])).status).toBe('none');
    expect(rest.calls.length).toBe(calls);
  });
});

function manualTimers() {
  const pending: Array<{ run: () => void; ms: number; cleared: boolean }> = [];
  const timers: SyncTimers = {
    set: (run, ms) => {
      const handle = { run, ms, cleared: false };
      pending.push(handle);
      return handle;
    },
    clear: (handle) => {
      (handle as { cleared: boolean }).cleared = true;
    },
  };
  return {
    timers,
    pending,
    fire: () => {
      for (const handle of pending.splice(0)) if (!handle.cleared) handle.run();
    },
  };
}

function scriptedSyncer(outcomes: Record<string, ReconcileOutcome> = {}) {
  const runs: Array<{
    guildId: string;
    skipHash: boolean;
    ignoreHolds: boolean;
    liftAccess: boolean;
  }> = [];
  const gates: Array<() => void> = [];
  let hold = false;

  return {
    runs,
    holdNext: () => {
      hold = true;
    },
    release: () => {
      for (const open of gates.splice(0)) open();
    },
    syncer: {
      async reconcile(guildId: string, options: ReconcileOptions = {}) {
        runs.push({
          guildId,
          skipHash: options.skipHash === true,
          ignoreHolds: options.ignoreHolds === true,
          liftAccess: options.liftAccess === true,
        });
        if (hold) {
          hold = false;
          await new Promise<void>((resolve) => gates.push(resolve));
        }
        return outcomes[guildId] ?? ({ status: 'unchanged' } as ReconcileOutcome);
      },
    },
  };
}

describe('CommandSyncQueue', () => {
  test('interactive work always drains before bulk work', async () => {
    const scripted = scriptedSyncer();
    const queue = new CommandSyncQueue({
      syncer: scripted.syncer,
      logger: collectingLogger().logger,
    });

    scripted.holdNext();
    queue.enqueue('1', { lane: 'bulk' });
    queue.enqueue('2', { lane: 'bulk' });
    queue.enqueue('3', { lane: 'bulk' });
    queue.enqueue('9', { lane: 'interactive' });
    scripted.release();
    await queue.idle();

    expect(scripted.runs.map((run) => run.guildId)).toEqual(['1', '9', '2', '3']);
  });

  test('repeated triggers for one guild coalesce, keeping each option and the faster lane', async () => {
    const scripted = scriptedSyncer();
    const queue = new CommandSyncQueue({
      syncer: scripted.syncer,
      logger: collectingLogger().logger,
    });

    scripted.holdNext();
    queue.enqueue('1', { lane: 'bulk' });
    queue.enqueue('2', { lane: 'bulk' });
    queue.enqueue('2', { lane: 'bulk', ignoreHolds: true });
    queue.enqueue('3', { lane: 'bulk' });
    queue.enqueue('3', { lane: 'interactive', skipHash: true });
    queue.enqueue('3', { lane: 'bulk', liftAccess: true });
    queue.enqueue('3', { lane: 'bulk' });
    scripted.release();
    await queue.idle();

    expect(scripted.runs).toEqual([
      { guildId: '1', skipHash: false, ignoreHolds: false, liftAccess: false },
      { guildId: '3', skipHash: true, ignoreHolds: false, liftAccess: true },
      { guildId: '2', skipHash: false, ignoreHolds: true, liftAccess: false },
    ]);
  });

  test('a trigger during a guild’s own run is not lost', async () => {
    const scripted = scriptedSyncer();
    const queue = new CommandSyncQueue({
      syncer: scripted.syncer,
      logger: collectingLogger().logger,
    });

    scripted.holdNext();
    queue.enqueue('1');
    await Bun.sleep(0);
    queue.enqueue('1');
    scripted.release();
    await queue.idle();

    expect(scripted.runs.map((run) => run.guildId)).toEqual(['1', '1']);
  });

  test('a guild in backoff never holds the lane, and comes back on its timer', async () => {
    const manual = manualTimers();
    const scripted = scriptedSyncer({
      '1': {
        status: 'failed',
        retryInMs: 5_000,
        failure: {
          code: null,
          status: 502,
          message: 'x',
          detail: 'x',
          at: new Date(NOW).toISOString(),
          retryAt: null,
          hash: null,
        },
      },
    });
    const queue = new CommandSyncQueue({
      syncer: scripted.syncer,
      logger: collectingLogger().logger,
      timers: manual.timers,
    });

    queue.enqueue('1', { lane: 'bulk' });
    queue.enqueue('2', { lane: 'bulk' });
    queue.enqueue('3', { lane: 'bulk' });
    await queue.idle();

    expect(scripted.runs.map((run) => run.guildId)).toEqual(['1', '2', '3']);
    expect(manual.pending.map((timer) => timer.ms)).toEqual([5_000 + RETRY_MARGIN_MS]);

    manual.fire();
    await queue.idle();
    expect(scripted.runs.map((run) => run.guildId)).toEqual(['1', '2', '3', '1']);
  });

  test('an error outcome is retried on a timer as well', async () => {
    const manual = manualTimers();
    const scripted = scriptedSyncer({ '1': { status: 'error', retryInMs: 10_000 } });
    const queue = new CommandSyncQueue({
      syncer: scripted.syncer,
      logger: collectingLogger().logger,
      timers: manual.timers,
    });

    queue.enqueue('1');
    await queue.idle();

    expect(manual.pending).toHaveLength(1);
  });

  test('a reconcile that throws is logged and the queue moves on', async () => {
    const { logger, lines } = collectingLogger();
    const runs: string[] = [];
    const queue = new CommandSyncQueue({
      logger,
      syncer: {
        async reconcile(guildId) {
          runs.push(guildId);
          if (guildId === '1') throw new Error('boom');
          return { status: 'unchanged' };
        },
      },
    });

    queue.enqueue('1');
    queue.enqueue('2');
    await queue.idle();

    expect(runs).toEqual(['1', '2']);
    expect(lines.some((line) => line.includes('boom'))).toBe(true);
  });

  test('cancel drops waiting work and timers; close stops everything', async () => {
    const manual = manualTimers();
    const scripted = scriptedSyncer({ '2': { status: 'error', retryInMs: 1_000 } });
    const queue = new CommandSyncQueue({
      syncer: scripted.syncer,
      logger: collectingLogger().logger,
      timers: manual.timers,
    });

    scripted.holdNext();
    queue.enqueue('1');
    queue.enqueue('2');
    queue.enqueue('3');
    queue.cancel('3');
    scripted.release();
    await queue.idle();
    expect(scripted.runs.map((run) => run.guildId)).toEqual(['1', '2']);

    await queue.close();
    expect(manual.pending[0]?.cleared).toBe(true);
    queue.enqueue('4');
    await queue.idle();
    expect(scripted.runs).toHaveLength(2);
  });
});

describe('CommandSettingsProvider', () => {
  test('serves dispatch from cache inside the TTL and re-reads after invalidate', async () => {
    const views = new MemoryViews();
    const provider = new CommandSettingsProvider(views, { ttlMs: 5_000, now: () => NOW });

    await provider.get(TEST_GUILD);
    await provider.get(TEST_GUILD);
    expect(views.reads).toBe(1);

    provider.invalidate(TEST_GUILD);
    await provider.get(TEST_GUILD);
    expect(views.reads).toBe(2);
  });

  test('concurrent misses share one read', async () => {
    const views = new MemoryViews();
    const provider = new CommandSettingsProvider(views, { ttlMs: 5_000 });

    await Promise.all([provider.get(TEST_GUILD), provider.get(TEST_GUILD)]);

    expect(views.reads).toBe(1);
  });

  test('a read invalidated while in flight is not cached', async () => {
    let release: (view: CommandWorkerView) => void = () => undefined;
    let reads = 0;
    const provider = new CommandSettingsProvider(
      {
        get: () => {
          reads += 1;
          return new Promise((resolve) => {
            release = resolve;
          });
        },
      },
      { ttlMs: 5_000 },
    );

    const first = provider.get(TEST_GUILD);
    provider.invalidate(TEST_GUILD);
    release(viewOf({}));
    await first;

    void provider.get(TEST_GUILD);
    expect(reads).toBe(2);
    release(viewOf({}));
  });
});

describe('HttpCommandWorkerViews', () => {
  test('reads the worker view with the shared secret and parses it', async () => {
    const requests: Array<{ url: string; secret: string | null }> = [];
    const views = new HttpCommandWorkerViews('http://api.test/', 'secret-secret-secret', {
      fetch: (async (url: string, init?: RequestInit) => {
        requests.push({
          url,
          secret: new Headers(init?.headers).get('x-proton-secret'),
        });
        return Response.json({ settings: { ban: { name: 'punish' } }, modulesOn: { ping: true } });
      }) as unknown as typeof fetch,
    });

    const view = await views.get(TEST_GUILD);

    expect(requests).toEqual([
      {
        url: `http://api.test/guilds/${TEST_GUILD}/commands/worker-view`,
        secret: 'secret-secret-secret',
      },
    ]);
    expect(view.settings.ban?.name).toBe('punish');
    expect(view.settings.ban?.enabled).toBe(true);
  });

  test('a non-2xx answer or an unknown shape throws', async () => {
    const failing = new HttpCommandWorkerViews('http://api.test', 's', {
      fetch: (async () => new Response('no', { status: 503 })) as unknown as typeof fetch,
    });
    const odd = new HttpCommandWorkerViews('http://api.test', 's', {
      fetch: (async () => Response.json({ nope: true })) as unknown as typeof fetch,
    });

    expect(failing.get(TEST_GUILD)).rejects.toThrow('503');
    expect(odd.get(TEST_GUILD)).rejects.toThrow('unknown shape');
  });
});

describe('CommandRecordCache', () => {
  test('a record set while a read is in flight is not overwritten by the older read', async () => {
    let release: (value: null) => void = () => undefined;
    const cache = new CommandRecordCache({
      get: () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    });

    const reading = cache.refresh(TEST_GUILD);
    const store = new MemoryRegistrations();
    await store.recordFailure(TEST_GUILD, {
      scope: 'guild',
      failure: {
        code: null,
        status: 500,
        message: 'm',
        detail: 'd',
        at: new Date(NOW).toISOString(),
        retryAt: null,
        hash: null,
      },
    });
    const fresh = await store.get(TEST_GUILD);
    cache.set(TEST_GUILD, fresh);
    release(null);
    await reading;

    expect(await cache.get(TEST_GUILD)).toEqual(fresh);
  });

  test('keeps at most its maximum number of guilds', async () => {
    const cache = new CommandRecordCache({ get: async () => null }, { max: 2 });
    cache.set('1', null);
    cache.set('2', null);
    cache.set('3', null);

    let reads = 0;
    const counting = new CommandRecordCache(
      {
        get: async () => {
          reads += 1;
          return null;
        },
      },
      { max: 2 },
    );
    counting.set('1', null);
    counting.set('2', null);
    counting.set('3', null);
    await counting.get('1');
    await counting.get('3');

    expect(reads).toBe(1);
  });

  test('pinned ids outlive a stored record without them, a refresh and eviction, until forgotten', async () => {
    const store = new MemoryRegistrations();
    const cache = new CommandRecordCache(store, { max: 1 });
    const ban = { key: 'ban', id: '1400000000000000001', name: 'hammer', kind: 'chat' as const };
    cache.pin(TEST_GUILD, {
      scope: 'guild',
      commands: [ban],
      idHistory: { [ban.id]: 'ban' },
    });

    cache.set(TEST_GUILD, null);
    const pinned = await cache.get(TEST_GUILD);
    expect(pinned?.idHistory).toEqual({ [ban.id]: 'ban' });
    expect(pinned?.commands).toEqual([ban]);
    expect(pinned?.failure).toBeNull();
    expect(await cache.stored(TEST_GUILD)).toBeNull();

    await store.recordFailure(TEST_GUILD, {
      scope: 'guild',
      failure: {
        code: null,
        status: null,
        message: 'm',
        detail: 'd',
        at: new Date(NOW).toISOString(),
        retryAt: null,
        hash: null,
      },
    });
    const refreshed = await cache.refresh(TEST_GUILD);
    expect(refreshed?.idHistory[ban.id]).toBe('ban');
    expect(refreshed?.failure?.message).toBe('m');
    expect((await cache.stored(TEST_GUILD))?.idHistory).toEqual({});

    cache.set(OTHER_GUILD, null);
    expect((await cache.get(TEST_GUILD))?.idHistory[ban.id]).toBe('ban');

    cache.delete(TEST_GUILD);
    expect(cache.pinned(TEST_GUILD)).toBe(false);
    expect((await cache.get(TEST_GUILD))?.idHistory).toEqual({});
  });
});

describe('rollbackGuildCommands', () => {
  test('empties every in-scope guild’s commands and forgets their records', async () => {
    const rest = new FakeDiscord();
    const store = new MemoryRegistrations();
    const lines: string[] = [];

    const report = await rollbackGuildCommands({
      rest,
      rail: EVERY_RAIL,
      guildIds: [TEST_GUILD, OTHER_GUILD],
      store,
      print: (line) => lines.push(line),
    });

    expect(report.removed).toEqual([TEST_GUILD, OTHER_GUILD]);
    expect(rest.puts().map((call) => call.body)).toEqual([[], []]);
    expect(store.calls).toEqual([`forget:${TEST_GUILD}`, `forget:${OTHER_GUILD}`]);
  });

  test('a guild Discord refuses keeps its record and is reported', async () => {
    const rest = new FakeDiscord();
    const store = new MemoryRegistrations();
    rest.failNext(() => ({ status: 403, body: { message: 'Missing Access', code: 50001 } }));

    const report = await rollbackGuildCommands({
      rest,
      rail: EVERY_RAIL,
      guildIds: [TEST_GUILD],
      store,
      print: () => undefined,
    });

    expect(report.failed).toEqual([{ guildId: TEST_GUILD, detail: 'Missing Access (code 50001)' }]);
    expect(store.calls).toEqual([]);
  });

  test('guild scope only ever touches the test guild', async () => {
    const rest = new FakeDiscord();

    const report = await rollbackGuildCommands({
      rest,
      rail: GUILD_RAIL,
      guildIds: [OTHER_GUILD, TEST_GUILD],
      store: new MemoryRegistrations(),
      print: () => undefined,
    });

    expect(report.removed).toEqual([TEST_GUILD]);
    expect(rest.puts().map((call) => call.path)).toEqual([
      `/applications/${APPLICATION}/guilds/${TEST_GUILD}/commands`,
    ]);
  });
});
