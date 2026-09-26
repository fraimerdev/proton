import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import {
  type CaseRecorder,
  DefaultActionExecutor,
  type GuildState,
  type ModuleContext,
  Permissions,
  RedisDedupeStore,
  RedisGuildStateStore,
  type ResolveContextHints,
  RestGuildMemberLister,
  type RestProxyClient,
  type RestRequestOptions,
  type RestResponse,
  resolvePrecheckContext,
} from '@proton/core';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import Redis from 'ioredis';
import type { JoinrolesConfig } from '../src/config.ts';
import { RedisPendingGrantStore } from '../src/pending.ts';
import {
  createSyncBatchHandler,
  JOINROLES_SYNC_JOB,
  SYNC_GRANTS_PER_TICK,
} from '../src/sync/run.ts';
import {
  claimRun,
  JOINROLES_SYNC_PREFIX,
  joinrolesSyncKey,
  RedisJoinRolesRunStore,
  SYNC_AUTOSYNC_TTL_SECONDS,
  SYNC_ESTIMATE_TTL_SECONDS,
  SYNC_LAST_TTL_SECONDS,
  SYNC_RUN_TTL_SECONDS,
} from '../src/sync/store.ts';
import { queuedRun, SYNC_STALE_MS } from '../src/sync/view.ts';
import { config, GUILD, PROTON, ROLE_ABOVE_BOT, ROLE_LOW, silent } from './harness.ts';
import { FakeScheduler, NOW, syncState, user } from './sync-harness.ts';

let container: StartedRedisContainer;
let redis: Redis;

const MEMBER_PATH = new RegExp(`^/guilds/${GUILD}/members\\?limit=(\\d+)&after=(\\d+)$`);

class FakeRest implements RestProxyClient {
  readonly calls: RestRequestOptions[] = [];
  memberIds: string[] = [];
  put: RestResponse = { status: 204, body: null };

  async request(options: RestRequestOptions): Promise<RestResponse> {
    this.calls.push(options);

    const listing = MEMBER_PATH.exec(options.path);
    if (options.method === 'GET' && listing) {
      const limit = Number(listing[1]);
      const after = BigInt(listing[2] ?? '0');
      const page = this.memberIds
        .filter((id) => BigInt(id) > after)
        .slice(0, limit)
        .map((id) => ({ user: { id }, roles: [], pending: false }));
      return { status: 200, body: page };
    }

    return this.put;
  }

  puts(): RestRequestOptions[] {
    return this.calls.filter((call) => call.method === 'PUT');
  }
}

const refusingRecorder: CaseRecorder = {
  record: async () => {
    throw new Error('a sync must never write a case');
  },
};

beforeAll(async () => {
  container = await new RedisContainer('redis:7-alpine').start();
  redis = new Redis(container.getConnectionUrl());
}, 240_000);

afterAll(async () => {
  redis?.disconnect();
  await container?.stop();
}, 240_000);

beforeEach(async () => {
  await redis.flushall();
});

interface Built {
  rest: FakeRest;
  runs: RedisJoinRolesRunStore;
  scheduler: FakeScheduler;
  batch(overrides?: Partial<JoinrolesConfig>): Promise<void>;
}

async function build(state: GuildState = syncState()): Promise<Built> {
  const guildState = new RedisGuildStateStore(redis);
  await guildState.put(state);

  const rest = new FakeRest();
  const runs = new RedisJoinRolesRunStore(redis);
  const scheduler = new FakeScheduler();

  const executor = new DefaultActionExecutor({
    dedupe: new RedisDedupeStore(redis),
    rest,
    recorder: refusingRecorder,
    resolveContext: async (request, hints) => {
      const result = await resolvePrecheckContext(
        { store: guildState, botUserId: PROTON, fetchMemberRoles: async () => null },
        request,
        (hints ?? {}) as ResolveContextHints,
      );
      return 'context' in result ? result.context : result;
    },
  });

  const handler = createSyncBatchHandler({
    runs,
    members: new RestGuildMemberLister(rest),
    guildState,
    pending: new RedisPendingGrantStore(redis),
    botUserId: PROTON,
    now: () => NOW,
  });

  return {
    rest,
    runs,
    scheduler,
    async batch(overrides = {}) {
      const ctx: ModuleContext<JoinrolesConfig> = {
        guildId: GUILD,
        config: config({ memberRoleIds: [ROLE_LOW], ...overrides }),
        executor,
        logger: silent,
        schedule: scheduler.schedule,
        cancel: scheduler.cancel,
      };
      await handler(undefined, ctx);
    },
  };
}

function queue(runs: RedisJoinRolesRunStore, runId = 'run-1') {
  const run = queuedRun({
    runId,
    guildId: GUILD,
    kind: 'sync',
    trigger: 'dashboard',
    actorId: '100000000000000001',
    now: NOW,
  });
  return runs.claim(run).then(() => run);
}

async function drain(built: Built, overrides: Partial<JoinrolesConfig> = {}): Promise<number> {
  let batches = 0;
  do {
    built.scheduler.table.clear();
    await built.batch(overrides);
    batches += 1;
  } while (built.scheduler.booked(JOINROLES_SYNC_JOB) && batches < 20);
  return batches;
}

describe('join roles sync end to end', () => {
  test('pages across batches, gives each role once with the audit reason, then records it', async () => {
    const built = await build();
    built.rest.memberIds = Array.from({ length: 30 }, (_, i) => user(i + 1));
    await queue(built.runs);

    const batches = await drain(built);

    expect(batches).toBe(2);
    const puts = built.rest.puts();
    expect(puts).toHaveLength(30);
    expect(puts[0]?.path).toBe(`/guilds/${GUILD}/members/${user(1)}/roles/${ROLE_LOW}`);
    expect(puts[0]?.headers?.['x-audit-log-reason']).toBe(
      encodeURIComponent('Join Roles sync (dashboard)'),
    );
    expect(puts.slice(0, SYNC_GRANTS_PER_TICK).at(-1)?.path).toContain(user(SYNC_GRANTS_PER_TICK));

    expect(await redis.exists(joinrolesSyncKey('run', GUILD))).toBe(0);
    expect(await built.runs.last(GUILD)).toMatchObject({ outcome: 'done', updated: 30 });
    expect(await built.runs.estimate(GUILD)).toMatchObject({ missing: 0, source: 'sync' });
  });

  test('a batch redone after it died grants nothing twice', async () => {
    const built = await build();
    built.rest.memberIds = [user(1), user(2)];
    const run = await queue(built.runs);

    await built.batch();
    await built.runs.claim(run);
    await built.batch();

    expect(built.rest.puts()).toHaveLength(2);
    expect((await built.runs.last(GUILD))?.updated).toBe(2);
  });

  test('without Manage Roles nothing is sent and the last sync names the permission', async () => {
    const built = await build(syncState(Permissions.SendMessages));
    built.rest.memberIds = [user(1)];
    await queue(built.runs);

    await built.batch();

    expect(built.rest.puts()).toEqual([]);
    const last = await built.runs.last(GUILD);
    expect(last?.outcome).toBe('failed');
    expect(last?.failure?.message).toContain('Manage Roles');
  });

  test('a role above Proton sends nothing and fails as blocked', async () => {
    const built = await build();
    built.rest.memberIds = [user(1)];
    await queue(built.runs);

    await built.batch({ memberRoleIds: [ROLE_ABOVE_BOT] });

    expect(built.rest.calls).toEqual([]);
    const last = await built.runs.last(GUILD);
    expect(last?.failure?.code).toBe('roles_blocked');
    expect(last?.blockedRoles).toEqual([{ roleId: ROLE_ABOVE_BOT, code: 'above_proton' }]);
  });

  test('Discord’s first 403 stops the sync', async () => {
    const built = await build();
    built.rest.memberIds = [user(1), user(2), user(3)];
    built.rest.put = { status: 403, body: { message: 'Missing Permissions', code: 50013 } };
    await queue(built.runs);

    await built.batch();

    expect(built.rest.puts()).toHaveLength(1);
    expect((await built.runs.last(GUILD))?.failure).toMatchObject({
      code: 'role_refused',
      roleId: ROLE_LOW,
    });
  });
});

describe('RedisJoinRolesRunStore against real Redis', () => {
  const run = queuedRun({
    runId: 'run-1',
    guildId: GUILD,
    kind: 'sync',
    trigger: 'dashboard',
    actorId: '100000000000000001',
    now: NOW,
  });

  test('keys live under the sync prefix', () => {
    expect(joinrolesSyncKey('run', GUILD)).toBe(`${JOINROLES_SYNC_PREFIX}:run:${GUILD}`);
  });

  test('claims one run per guild, for a day', async () => {
    const runs = new RedisJoinRolesRunStore(redis);

    expect(await runs.claim(run)).toBe(true);
    expect(await runs.claim({ ...run, runId: 'run-2' })).toBe(false);
    expect(await runs.get(GUILD)).toEqual(run);

    const ttl = await redis.ttl(joinrolesSyncKey('run', GUILD));
    expect(ttl).toBeGreaterThan(SYNC_RUN_TTL_SECONDS - 5);
  });

  test('progress and clear only touch the run they name', async () => {
    const runs = new RedisJoinRolesRunStore(redis);
    await runs.claim(run);

    expect(await runs.putIfCurrent({ ...run, runId: 'run-2', processed: 9 })).toBe(false);
    expect(await runs.clear(GUILD, 'run-2')).toBe(false);
    expect((await runs.get(GUILD))?.processed).toBe(0);

    expect(await runs.putIfCurrent({ ...run, state: 'running', processed: 9 })).toBe(true);
    expect((await runs.get(GUILD))?.processed).toBe(9);

    expect(await runs.clear(GUILD, 'run-1')).toBe(true);
    expect(await runs.get(GUILD)).toBeNull();
    expect(await runs.putIfCurrent(run)).toBe(false);
  });

  test('finish writes the last sync and the estimate with their own lifetimes', async () => {
    const runs = new RedisJoinRolesRunStore(redis);
    await runs.claim(run);

    const finished = await runs.finish(GUILD, 'run-1', {
      last: {
        runId: 'run-1',
        trigger: 'dashboard',
        outcome: 'done',
        failure: null,
        processed: 3,
        updated: 2,
        skipped: { excluded: 1, pending: 0, outranks: 0, owner: 0, left: 0, failed: 0 },
        blockedRoles: [],
        startedAt: NOW,
        finishedAt: NOW,
      },
      estimate: {
        missing: 0,
        pending: 0,
        scanned: 3,
        countedAt: NOW,
        source: 'sync',
        fingerprint: 'm:|b:|x:|s:1',
        failure: null,
      },
    });

    expect(finished).toBe(true);
    expect(await runs.get(GUILD)).toBeNull();
    expect((await runs.last(GUILD))?.updated).toBe(2);
    expect((await runs.estimate(GUILD))?.scanned).toBe(3);
    expect(await redis.ttl(joinrolesSyncKey('last', GUILD))).toBeGreaterThan(
      SYNC_LAST_TTL_SECONDS - 5,
    );
    expect(await redis.ttl(joinrolesSyncKey('estimate', GUILD))).toBeGreaterThan(
      SYNC_ESTIMATE_TTL_SECONDS - 5,
    );
  });

  test('a run silent past the stale window is replaced, a fresh one is not', async () => {
    const runs = new RedisJoinRolesRunStore(redis);
    await runs.claim({ ...run, state: 'running' });
    const next = { ...run, runId: 'run-2' };

    expect(await claimRun(runs, next, NOW + SYNC_STALE_MS - 1)).toMatchObject({ claimed: false });
    expect((await runs.get(GUILD))?.runId).toBe('run-1');

    expect(await claimRun(runs, next, NOW + SYNC_STALE_MS)).toMatchObject({
      claimed: true,
      replaced: { runId: 'run-1', state: 'running' },
    });
    expect(await runs.get(GUILD)).toEqual(next);
    expect(await redis.ttl(joinrolesSyncKey('run', GUILD))).toBeGreaterThan(
      SYNC_RUN_TTL_SECONDS - 5,
    );
  });

  test('remembers when the scheduled sync is due, for a little over a week', async () => {
    const runs = new RedisJoinRolesRunStore(redis);

    expect(await runs.autosyncAt(GUILD)).toBeNull();
    await runs.setAutosyncAt(GUILD, NOW + 60_000);

    expect(await runs.autosyncAt(GUILD)).toBe(NOW + 60_000);
    expect(await redis.ttl(joinrolesSyncKey('autosync', GUILD))).toBeGreaterThan(
      SYNC_AUTOSYNC_TTL_SECONDS - 5,
    );
  });

  test('finish for a run that was already stopped writes nothing', async () => {
    const runs = new RedisJoinRolesRunStore(redis);
    await runs.claim(run);
    await runs.clear(GUILD, 'run-1');

    expect(
      await runs.finish(GUILD, 'run-1', {
        estimate: {
          missing: 1,
          pending: 0,
          scanned: 1,
          countedAt: NOW,
          source: 'count',
          fingerprint: '',
          failure: null,
        },
      }),
    ).toBe(false);
    expect(await runs.estimate(GUILD)).toBeNull();
  });
});
