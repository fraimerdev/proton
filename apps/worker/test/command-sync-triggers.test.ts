import { describe, expect, test } from 'bun:test';
import { commandCatalogue, type ProtonEvent, type RestRequestOptions } from '@proton/core';
import type { CommandRegistrationRecord } from '@proton/db';
import { dispatch } from '@proton/fixtures';
import { normalise } from '@proton/gateway/normaliser';
import { CommandResolver } from '../src/command-resolver.ts';
import {
  CommandRecordCache,
  type CommandRegistrationRail,
  CommandSyncer,
  CommandSyncQueue,
  DRIFT_RECONCILE,
  type Retirement,
  type SyncLane,
} from '../src/command-sync.ts';
import {
  COMMAND_SYNC_GROUP,
  CommandSyncTriggers,
  discordGuilds,
} from '../src/command-sync-triggers.ts';
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

const GUILD_RAIL: CommandRegistrationRail = {
  applicationId: APPLICATION,
  scope: 'guild',
  testGuildId: TEST_GUILD,
};
const EVERY_RAIL: CommandRegistrationRail = { applicationId: APPLICATION, scope: 'every-guild' };

interface Enqueued {
  guildId: string;
  lane: SyncLane | undefined;
  skipHash?: boolean | undefined;
  ignoreHolds?: boolean | undefined;
  liftAccess?: boolean | undefined;
}

function recorded(overrides: Partial<CommandRegistrationRecord> = {}): CommandRegistrationRecord {
  return {
    guildId: TEST_GUILD,
    scope: 'guild',
    definitionHash: 'h',
    commands: [],
    idHistory: {},
    checkedAt: '2026-09-20T00:00:00.000Z',
    syncedAt: '2026-09-20T00:00:00.000Z',
    failure: null,
    permissionsCheckedAt: null,
    lostPermissions: null,
    ...overrides,
  };
}

function fakeQueueHarness(
  rail: CommandRegistrationRail = GUILD_RAIL,
  options: {
    retirements?: Retirement[];
    sleep?: (ms: number) => Promise<void>;
  } = {},
) {
  const enqueued: Enqueued[] = [];
  const cancelled: string[] = [];
  const invalidated: string[] = [];
  const ensured: string[] = [];
  const retired: string[][] = [];
  const idles: number[] = [];
  const store = new MemoryRegistrations();
  const records = new CommandRecordCache(store);
  const rest = new FakeDiscord();
  const { logger, lines } = collectingLogger();

  const triggers = new CommandSyncTriggers({
    bus: {
      publish: async () => undefined,
      subscribe: (group, types, _handler, subscribeOptions) => {
        lines.push(`subscribed ${group} ${types.join(',')} ${subscribeOptions?.startId ?? ''}`);
        return { group, close: async () => undefined };
      },
    },
    rest,
    rail,
    queue: {
      enqueue: (guildId, enqueueOptions) =>
        enqueued.push({
          guildId,
          lane: enqueueOptions?.lane,
          ...(enqueueOptions?.skipHash === undefined ? {} : { skipHash: enqueueOptions.skipHash }),
          ...(enqueueOptions?.ignoreHolds === undefined
            ? {}
            : { ignoreHolds: enqueueOptions.ignoreHolds }),
          ...(enqueueOptions?.liftAccess === undefined
            ? {}
            : { liftAccess: enqueueOptions.liftAccess }),
        }),
      cancel: (guildId) => cancelled.push(guildId),
      idle: async () => {
        idles.push(enqueued.length);
      },
    },
    syncer: {
      globalRetired: rail.scope !== 'every-guild',
      retireGlobal: async (guildIds) => {
        retired.push([...guildIds]);
        return options.retirements?.shift() ?? { status: 'kept', blockers: [] };
      },
    },
    records,
    store,
    registrar: {
      ensure: async (guildId) => {
        ensured.push(guildId);
      },
    },
    settings: { invalidate: (guildId) => invalidated.push(guildId) },
    logger,
    ...(options.sleep ? { sleep: options.sleep } : {}),
  });

  return {
    triggers,
    enqueued,
    cancelled,
    invalidated,
    ensured,
    retired,
    idles,
    store,
    records,
    rest,
    lines,
  };
}

function event(type: ProtonEvent['type'], payload: Record<string, unknown>): ProtonEvent {
  return { id: `${type}:1`, type, guildId: TEST_GUILD, occurredAt: 0, payload };
}

function commandsChanged(guildId: string, registration: boolean): ProtonEvent {
  return event('proton.commands_changed', {
    auditId: 'a1',
    guildId,
    actorId: '100000000000000001',
    source: 'dashboard',
    key: 'ban',
    displayName: 'ban',
    changed: registration ? ['name'] : ['privateReply'],
    enabledBefore: true,
    enabledAfter: true,
    registration,
  });
}

function configChanged(
  guildId: string,
  change: { enabledBefore?: boolean; enabledAfter?: boolean; changedKeys?: string[] },
): ProtonEvent {
  return event('proton.config_changed', {
    auditId: 'a2',
    guildId,
    moduleId: 'moderation',
    actorId: '100000000000000001',
    source: 'dashboard',
    enabledBefore: change.enabledBefore ?? true,
    enabledAfter: change.enabledAfter ?? true,
    changedKeys: change.changedKeys ?? [],
  });
}

describe('bus triggers', () => {
  test('subscribes one group from the newest event, not the retained history', () => {
    const { triggers, lines } = fakeQueueHarness();

    triggers.start();

    expect(lines).toContain(
      `subscribed ${COMMAND_SYNC_GROUP} proton.commands_changed,proton.config_changed $`,
    );
  });

  test('a registration change is synced on the interactive lane, past an access hold', async () => {
    const { triggers, enqueued, invalidated } = fakeQueueHarness();

    await triggers.handle(commandsChanged(TEST_GUILD, true));

    expect(invalidated).toEqual([TEST_GUILD]);
    expect(enqueued).toEqual([{ guildId: TEST_GUILD, lane: 'interactive', liftAccess: true }]);
  });

  test('a visibility-only change clears the dispatch cache and registers nothing', async () => {
    const { triggers, enqueued, invalidated } = fakeQueueHarness();

    await triggers.handle(commandsChanged(TEST_GUILD, false));

    expect(invalidated).toEqual([TEST_GUILD]);
    expect(enqueued).toEqual([]);
  });

  test('a module switched on or off, or its enabled field, syncs; other settings do not', async () => {
    const { triggers, enqueued, invalidated } = fakeQueueHarness();

    await triggers.handle(configChanged(TEST_GUILD, { enabledBefore: false, enabledAfter: true }));
    await triggers.handle(configChanged(TEST_GUILD, { changedKeys: ['enabled'] }));
    await triggers.handle(configChanged(TEST_GUILD, { changedKeys: ['publicReplies'] }));

    expect(enqueued).toEqual([
      { guildId: TEST_GUILD, lane: 'interactive', liftAccess: true },
      { guildId: TEST_GUILD, lane: 'interactive', liftAccess: true },
    ]);
    expect(invalidated).toEqual([TEST_GUILD, TEST_GUILD, TEST_GUILD]);
  });

  test('a guild outside the scope is never enqueued', async () => {
    const { triggers, enqueued } = fakeQueueHarness();

    await triggers.handle(commandsChanged(OTHER_GUILD, true));
    await triggers.handle(configChanged(OTHER_GUILD, { enabledBefore: false }));
    await triggers.available(OTHER_GUILD, null);

    expect(enqueued).toEqual([]);
  });

  test('an event in an unknown shape is ignored with a warning', async () => {
    const { triggers, enqueued, lines } = fakeQueueHarness();

    await triggers.handle(event('proton.commands_changed', { guildId: TEST_GUILD }));

    expect(enqueued).toEqual([]);
    expect(lines.some((line) => line.includes('unknown shape'))).toBe(true);
  });
});

describe('guild.available', () => {
  test('a guild with no record is forced past both the hash and any hold', async () => {
    const { triggers, enqueued } = fakeQueueHarness();

    await triggers.available(TEST_GUILD, '2026-09-21T00:00:00.000Z');

    expect(enqueued).toEqual([
      { guildId: TEST_GUILD, lane: 'interactive', skipHash: true, ignoreHolds: true },
    ]);
  });

  test('a join after the last sync is forced; an older join only checks', async () => {
    const newer = fakeQueueHarness();
    newer.store.records.set(TEST_GUILD, recorded());
    await newer.triggers.available(TEST_GUILD, '2026-09-21T00:00:00.000Z');

    const older = fakeQueueHarness();
    older.store.records.set(TEST_GUILD, recorded());
    await older.triggers.available(TEST_GUILD, '2026-09-01T00:00:00.000Z');

    expect(newer.enqueued[0]).toMatchObject({ skipHash: true, ignoreHolds: true });
    expect(older.enqueued[0]).toMatchObject({ skipHash: false, ignoreHolds: false });
  });

  test('a guild Proton could not manage is retried on its next GUILD_CREATE', async () => {
    const { triggers, enqueued, store } = fakeQueueHarness();
    store.records.set(
      TEST_GUILD,
      recorded({
        definitionHash: null,
        failure: {
          code: '50001',
          status: 403,
          message: 'm',
          detail: 'd',
          at: '2026-09-20T00:00:00.000Z',
          retryAt: null,
          hash: 'h',
        },
      }),
    );

    await triggers.available(TEST_GUILD, '2026-09-01T00:00:00.000Z');

    expect(enqueued[0]).toMatchObject({ skipHash: true, ignoreHolds: true });
  });

  test('a record that cannot be read forces rather than throws', async () => {
    const { triggers, enqueued, store } = fakeQueueHarness();
    store.get = async () => {
      throw new Error('database unreachable');
    };

    await triggers.available(TEST_GUILD, null);

    expect(enqueued[0]).toMatchObject({ skipHash: true, ignoreHolds: true });
  });
});

describe('confirmed removal', () => {
  test('forgets the registration record and drops any waiting sync', async () => {
    const { triggers, cancelled, store, records, invalidated } = fakeQueueHarness();
    store.records.set(TEST_GUILD, recorded());
    await records.get(TEST_GUILD);

    await triggers.forget(TEST_GUILD);

    expect(cancelled).toEqual([TEST_GUILD]);
    expect(store.records.has(TEST_GUILD)).toBe(false);
    expect(invalidated).toEqual([TEST_GUILD]);
    expect(await records.get(TEST_GUILD)).toBeNull();
  });
});

describe('boot fan-out', () => {
  test('checks only the guilds Discord lists that are in scope, on the bulk lane', async () => {
    const { triggers, enqueued, rest } = fakeQueueHarness();
    rest.guilds = [
      { id: TEST_GUILD, name: 'Test' },
      { id: OTHER_GUILD, name: 'Other' },
    ];

    await triggers.bootFanOut();

    expect(enqueued).toEqual([{ guildId: TEST_GUILD, lane: 'bulk' }]);
  });

  test('ensures a guilds row before a guild with no record is reconciled', async () => {
    const { triggers, ensured, enqueued, rest, store } = fakeQueueHarness(EVERY_RAIL);
    rest.guilds = [
      { id: TEST_GUILD, name: 'Test' },
      { id: OTHER_GUILD, name: 'Other' },
    ];
    store.records.set(TEST_GUILD, recorded({ scope: 'every-guild' }));

    await triggers.bootFanOut();

    expect(ensured).toEqual([OTHER_GUILD]);
    expect(enqueued.map((entry) => entry.guildId)).toEqual([TEST_GUILD, OTHER_GUILD]);
  });

  test('a guild known only by ids the store never took still has its row ensured', async () => {
    const { triggers, ensured, rest, records } = fakeQueueHarness(EVERY_RAIL);
    rest.guilds = [{ id: OTHER_GUILD, name: 'Other' }];
    records.pin(OTHER_GUILD, {
      scope: 'every-guild',
      commands: [{ key: 'ban', id: '1400000000000000001', name: 'ban', kind: 'chat' }],
      idHistory: { '1400000000000000001': 'ban' },
    });

    await triggers.bootFanOut();

    expect(ensured).toEqual([OTHER_GUILD]);
  });

  test('a guild whose row cannot be ensured is skipped, not failed', async () => {
    const h = fakeQueueHarness(EVERY_RAIL);
    h.rest.guilds = [{ id: OTHER_GUILD, name: 'Other' }];
    const failing = new CommandSyncTriggers({
      bus: {
        publish: async () => undefined,
        subscribe: () => ({ group: 'x', close: async () => {} }),
      },
      rest: h.rest,
      rail: EVERY_RAIL,
      queue: {
        enqueue: () => h.enqueued.push({ guildId: 'x', lane: 'bulk' }),
        cancel: () => {},
        idle: async () => {},
      },
      syncer: {
        globalRetired: true,
        retireGlobal: async () => ({ status: 'none', blockers: [] }),
      },
      records: h.records,
      store: h.store,
      registrar: {
        ensure: async () => {
          throw new Error('api returned 503');
        },
      },
      logger: collectingLogger().logger,
    });

    await failing.bootFanOut();

    expect(h.enqueued).toEqual([]);
  });

  test('checks the global set for retirement once the fan-out drains', async () => {
    const { triggers, retired, rest } = fakeQueueHarness(EVERY_RAIL);
    rest.guilds = [
      { id: TEST_GUILD, name: 'Test' },
      { id: OTHER_GUILD, name: 'Other' },
    ];

    await triggers.bootFanOut();

    expect(retired).toEqual([[TEST_GUILD, OTHER_GUILD]]);
  });

  test('an unreadable guild list is asked for again with capped backoff, then the fan-out runs', async () => {
    const waits: number[] = [];
    const { triggers, enqueued, retired, rest, lines } = fakeQueueHarness(EVERY_RAIL, {
      sleep: async (ms) => {
        waits.push(ms);
      },
    });
    rest.guilds = [{ id: TEST_GUILD, name: 'Test' }];
    for (let failure = 0; failure < 8; failure += 1) {
      rest.failNext(() => ({ status: 500, body: 'down' }));
    }

    await triggers.bootFanOut();

    expect(waits).toEqual([5_000, 10_000, 20_000, 40_000, 80_000, 160_000, 300_000, 300_000]);
    expect(enqueued).toEqual([{ guildId: TEST_GUILD, lane: 'bulk' }]);
    expect(retired).toEqual([[TEST_GUILD]]);
    expect(lines.filter((line) => line.includes('waits'))).toHaveLength(8);
  });

  test('a network failure on the guild list is retried the same way', async () => {
    const waits: number[] = [];
    const { triggers, enqueued, rest } = fakeQueueHarness(GUILD_RAIL, {
      sleep: async (ms) => {
        waits.push(ms);
      },
    });
    rest.guilds = [{ id: TEST_GUILD, name: 'Test' }];
    rest.failNext(() => new Error('connect ECONNREFUSED 127.0.0.1:9001'));

    await triggers.bootFanOut();

    expect(waits).toEqual([5_000]);
    expect(enqueued).toEqual([{ guildId: TEST_GUILD, lane: 'bulk' }]);
  });

  test('servers that hold up retirement are checked again, then retirement is re-checked', async () => {
    const { triggers, enqueued, retired, ensured, idles, rest } = fakeQueueHarness(EVERY_RAIL, {
      retirements: [
        {
          status: 'kept',
          blockers: [
            { guildId: TEST_GUILD, reason: 'permissions-unchecked' },
            { guildId: OTHER_GUILD, reason: 'unsynced' },
            { guildId: THIRD_GUILD, reason: '50035' },
          ],
        },
      ],
    });
    rest.guilds = [
      { id: TEST_GUILD, name: 'Test' },
      { id: OTHER_GUILD, name: 'Other' },
      { id: THIRD_GUILD, name: 'Third' },
    ];

    await triggers.bootFanOut();

    expect(enqueued.slice(3)).toEqual([
      { guildId: TEST_GUILD, lane: 'bulk' },
      { guildId: OTHER_GUILD, lane: 'bulk' },
    ]);
    expect(ensured.filter((guildId) => guildId === OTHER_GUILD)).toHaveLength(2);
    expect(idles.at(-1)).toBe(5);
    expect(retired).toHaveLength(2);
  });
});

describe('the periodic sweep', () => {
  test('enqueues stale guilds in scope on the bulk lane', async () => {
    const { triggers, enqueued, store, retired } = fakeQueueHarness();
    store.stale = [TEST_GUILD, OTHER_GUILD];

    await triggers.sweep();

    expect(enqueued).toEqual([{ guildId: TEST_GUILD, lane: 'bulk' }]);
    expect(retired).toEqual([]);
  });

  test('in guild scope asks the store for the test guild only, before its limit', async () => {
    const { triggers, store } = fakeQueueHarness();

    await triggers.sweep();

    expect(store.staleCalls).toEqual([
      { limit: 500, options: { onlyGuildId: TEST_GUILD, includeUnchecked: false } },
    ]);
  });

  test('guild scope without a test guild asks for nothing', async () => {
    const { triggers, store } = fakeQueueHarness({ applicationId: APPLICATION, scope: 'guild' });

    await triggers.sweep();

    expect(store.staleCalls).toEqual([]);
  });

  test('while the global set exists, also picks up servers never synced or never permission-checked', async () => {
    const { triggers, store, enqueued } = fakeQueueHarness(EVERY_RAIL);
    store.unchecked = [OTHER_GUILD];

    await triggers.sweep();

    expect(store.staleCalls).toEqual([{ limit: 500, options: { includeUnchecked: true } }]);
    expect(enqueued).toContainEqual({ guildId: OTHER_GUILD, lane: 'bulk' });
  });

  test('re-checks the global retirement in every-guild scope', async () => {
    const { triggers, retired, rest, store } = fakeQueueHarness(EVERY_RAIL);
    rest.guilds = [{ id: THIRD_GUILD, name: 'Third' }];
    store.stale = [];

    await triggers.sweep();

    expect(retired).toEqual([[THIRD_GUILD]]);
  });
});

describe('discordGuilds', () => {
  test('pages through the bot’s guild list', async () => {
    const calls: RestRequestOptions[] = [];
    const first = Array.from({ length: 200 }, (_, i) => ({
      id: String(900000000000001000n + BigInt(i)),
      name: `g${i}`,
    }));
    const pages = [first, [{ id: '900000000000009999', name: 'last' }]];

    const guilds = await discordGuilds({
      request: async (options) => {
        calls.push(options);
        return { status: 200, body: pages[calls.length - 1] ?? [] };
      },
    });

    expect(guilds.size).toBe(201);
    expect(calls[1]?.path).toContain(`after=${first.at(-1)?.id}`);
  });
});

function realFleet(rail: CommandRegistrationRail = EVERY_RAIL) {
  const rest = new FakeDiscord();
  const views = new MemoryViews();
  const store = new MemoryRegistrations();
  const records = new CommandRecordCache(store);
  const { logger, lines } = collectingLogger();
  const syncer = new CommandSyncer({
    rest,
    rail,
    catalogue: commandCatalogue(commandRegistry()),
    views,
    store,
    records,
    logger,
  });
  const queue = new CommandSyncQueue({ syncer, logger });
  const triggers = new CommandSyncTriggers({
    bus: {
      publish: async () => undefined,
      subscribe: () => ({ group: 'x', close: async () => {} }),
    },
    rest,
    rail,
    queue,
    syncer,
    records,
    store,
    registrar: { ensure: async () => undefined },
    logger,
    sleep: async () => undefined,
  });
  return { rest, views, store, records, syncer, queue, triggers, lines };
}

const GLOBAL_LIST = `/applications/${APPLICATION}/commands`;

describe('healing what holds up global retirement', () => {
  function migrating() {
    const fleet = realFleet();
    fleet.rest.guilds = [{ id: OTHER_GUILD, name: 'Other' }];
    fleet.rest.globals = [{ id: '700000000000000001', name: 'ban', type: 1 }];
    fleet.views.views.set(OTHER_GUILD, viewOf({ ping: true, help: true, moderation: true }));
    return fleet;
  }

  test('a 503 on the global list during the boot fan-out is healed and retirement completes', async () => {
    const { rest, store, syncer, triggers } = migrating();
    rest.failNext((options) =>
      options.method === 'GET' && options.path === GLOBAL_LIST
        ? { status: 503, body: { message: 'upstream' } }
        : undefined,
    );

    await triggers.bootFanOut();

    expect(store.records.get(OTHER_GUILD)?.permissionsCheckedAt).not.toBeNull();
    expect(rest.calls.filter((call) => call.path.endsWith('/commands/permissions')).length).toBe(2);
    expect(rest.globals).toEqual([]);
    expect(syncer.globalRetired).toBe(true);
  });

  test('a server still unchecked after the boot fan-out is healed by the next sweep', async () => {
    const { rest, store, triggers } = migrating();
    rest.failNext((options) =>
      options.method === 'GET' && options.path === GLOBAL_LIST
        ? { status: 503, body: { message: 'upstream' } }
        : undefined,
    );
    for (let failure = 0; failure < 2; failure += 1) {
      rest.failNext((options) =>
        options.path.endsWith('/commands/permissions') ? { status: 500, body: 'down' } : undefined,
      );
    }
    store.unchecked = [OTHER_GUILD];

    await triggers.bootFanOut();
    expect(rest.globals).toHaveLength(1);
    expect(store.records.get(OTHER_GUILD)?.permissionsCheckedAt).toBeNull();

    await triggers.sweep();

    expect(store.records.get(OTHER_GUILD)?.permissionsCheckedAt).not.toBeNull();
    expect(rest.globals).toEqual([]);
  });
});

describe('end to end with a real queue and syncer', () => {
  test('a GUILD_CREATE for a re-added guild registers again even with an unchanged set', async () => {
    const rest = new FakeDiscord();
    const views = new MemoryViews();
    const store = new MemoryRegistrations();
    const records = new CommandRecordCache(store);
    const { logger } = collectingLogger();
    const syncer = new CommandSyncer({
      rest,
      rail: GUILD_RAIL,
      catalogue: commandCatalogue(commandRegistry()),
      views,
      store,
      records,
      logger,
    });
    const queue = new CommandSyncQueue({ syncer, logger });
    const triggers = new CommandSyncTriggers({
      bus: {
        publish: async () => undefined,
        subscribe: () => ({ group: 'x', close: async () => {} }),
      },
      rest,
      rail: GUILD_RAIL,
      queue,
      syncer,
      records,
      store,
      registrar: { ensure: async () => undefined },
      logger,
    });
    views.views.set(TEST_GUILD, viewOf({ ping: true }));

    await triggers.available(TEST_GUILD, null);
    await queue.idle();
    await triggers.forget(TEST_GUILD);
    await triggers.available(TEST_GUILD, new Date().toISOString());
    await queue.idle();

    expect(rest.puts(TEST_GUILD)).toHaveLength(2);
  });

  test('a drifted invocation lifts an access hold, but not a refusal of the very same set', async () => {
    const rest = new FakeDiscord();
    const views = new MemoryViews();
    const store = new MemoryRegistrations();
    const records = new CommandRecordCache(store);
    const { logger } = collectingLogger();
    const catalogue = commandCatalogue(commandRegistry());
    const syncer = new CommandSyncer({
      rest,
      rail: GUILD_RAIL,
      catalogue,
      views,
      store,
      records,
      logger,
    });
    const queue = new CommandSyncQueue({ syncer, logger });
    const resolver = new CommandResolver({
      catalogue,
      records,
      logger,
      reconcile: (guildId) => queue.enqueue(guildId, DRIFT_RECONCILE),
    });
    const drifted = () => {
      const d = normalise(dispatch('interactionCreateGuildCommand'))[0]?.payload as Record<
        string,
        unknown
      >;
      (d.data as Record<string, unknown>).options = [{ name: 'purge', type: 1, options: [] }];
      return d;
    };
    views.views.set(TEST_GUILD, viewOf({ moderation: true }));

    rest.failNext(() => ({ status: 403, body: { message: 'Missing Access', code: 50001 } }));
    expect((await syncer.reconcile(TEST_GUILD)).status).toBe('failed');
    expect(await resolver.resolve(TEST_GUILD, drifted())).toEqual({ unresolved: 'updating' });
    await queue.idle();
    expect(rest.puts(TEST_GUILD)).toHaveLength(2);
    expect(store.records.get(TEST_GUILD)?.failure).toBeNull();

    views.views.set(TEST_GUILD, viewOf({ ping: true }));
    rest.failNext(() => ({ status: 400, body: { message: 'Invalid Form Body', code: 50035 } }));
    expect((await syncer.reconcile(TEST_GUILD)).status).toBe('failed');
    expect(await resolver.resolve(TEST_GUILD, drifted())).toEqual({ unresolved: 'updating' });
    await queue.idle();
    expect(rest.puts(TEST_GUILD)).toHaveLength(3);
  });
});
