import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import {
  type EventBus,
  joinrolesSyncRequestedSchema,
  ModuleRegistry,
  type ProtonEvent,
  RedisStreamsEventBus,
  streamKey,
} from '@proton/core';
import { createDb, type DbHandle, runMigrations } from '@proton/db';
import { guilds } from '@proton/db/schema';
import { joinrolesModule } from '@proton/module-joinroles';
import { type JoinrolesConfig, joinrolesDefaultConfig } from '@proton/module-joinroles/config';
import {
  joinrolesSyncKey,
  RedisJoinRolesRunStore,
  SYNC_RUN_TTL_SECONDS,
} from '@proton/module-joinroles/sync-store';
import {
  COUNT_COOLDOWN_MS,
  emptySkipCounts,
  queuedRun,
  SYNC_STALE_MS,
  syncFingerprint,
  syncRunSchema,
  syncStartResultSchema,
  syncStatusSchema,
} from '@proton/module-joinroles/sync-view';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import Redis from 'ioredis';
import type { ApiDeps } from '../src/app.ts';
import { createApiApp } from '../src/app.ts';
import { JoinRolesSyncService } from '../src/joinroles/sync.ts';
import { auditTrailWriter } from '../src/leveling/xp-events.ts';
import { ModuleConfigService } from '../src/modules/service.ts';

let postgres: StartedPostgreSqlContainer;
let redisContainer: StartedRedisContainer;
let handle: DbHandle;
let redis: Redis;

const SECRET = 'shared-secret-for-tests';
const GUILD = '900000000000000001';
const ADMIN = '100000000000000001';
const MEMBER_ROLE = '410000000000000001';
const BOT_ROLE = '410000000000000002';

const SYNC = `/guilds/${GUILD}/joinroles/sync`;
const REQUESTS = streamKey('joinroles.sync_requested');

const HERE = {
  presence: (ids: readonly string[]) => Promise.resolve({ present: [...ids], known: true }),
};

const registry = new ModuleRegistry();
registry.register(joinrolesModule);

beforeAll(async () => {
  [postgres, redisContainer] = await Promise.all([
    new PostgreSqlContainer('postgres:17-alpine').start(),
    new RedisContainer('redis:7-alpine').start(),
  ]);

  handle = createDb(postgres.getConnectionUri());
  await runMigrations(handle);
  redis = new Redis(redisContainer.getConnectionUrl());
}, 240_000);

afterAll(async () => {
  redis?.disconnect();
  await handle?.close();
  await Promise.all([postgres?.stop(), redisContainer?.stop()]);
}, 240_000);

beforeEach(async () => {
  await redis.flushall();
  await handle.client`delete from audit_trail`;
  await handle.client`delete from guild_modules`;
  await handle.client`delete from guilds`;
  await handle.db.insert(guilds).values({ id: GUILD, name: 'test guild' });
});

async function waitFor(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await Bun.sleep(25);
  }
  throw new Error('waitFor timed out');
}

function harness(bus: EventBus = new RedisStreamsEventBus(redis, { blockMs: 100 })) {
  const modules = new ModuleConfigService(handle, registry);
  const runs = new RedisJoinRolesRunStore(redis);
  const logs: string[] = [];

  const joinrolesSync = new JoinRolesSyncService({
    modules,
    runs,
    bus,
    audit: auditTrailWriter(handle),
    logger: { error: (line: string) => logs.push(line), warn: (line: string) => logs.push(line) },
  });

  const app = createApiApp({
    guilds: HERE,
    modules,
    joinrolesSync,
    sharedSecret: SECRET,
  } as unknown as ApiDeps);

  const save = (enabled: boolean, config: Partial<JoinrolesConfig> = {}) =>
    modules.update({
      guildId: GUILD,
      moduleId: 'joinroles',
      enabled,
      config: { ...joinrolesDefaultConfig, memberRoleIds: [MEMBER_ROLE], ...config },
      actorId: ADMIN,
      source: 'dashboard',
    });

  const send = (method: 'GET' | 'POST', body?: unknown) =>
    app.request(SYNC, {
      method,
      headers: { 'content-type': 'application/json', 'x-proton-secret': SECRET },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  return { app, runs, logs, save, send };
}

const START = { kind: 'sync', actorId: ADMIN, source: 'dashboard', ipHash: 'hashed-ip' };
const COUNT = { ...START, kind: 'count' };

async function syncAudits() {
  return (await handle.client`
    select id, guild_id, actor_id, source, action, before, after, ip_hash
    from audit_trail
    where action like 'module.joinroles.sync.%'
    order by id
  `) as unknown as Array<{
    id: string;
    guild_id: string;
    actor_id: string;
    source: string;
    action: string;
    before: unknown;
    after: unknown;
    ip_hash: string | null;
  }>;
}

async function published(): Promise<ProtonEvent[]> {
  const entries = await redis.xrange(REQUESTS, '-', '+');
  return entries.map(([, fields]) => JSON.parse(fields[1] ?? 'null') as ProtonEvent);
}

describe('starting a Join Roles sync against Postgres and Redis', () => {
  test('writes the audit row, claims the slot and publishes the request onto the bus', async () => {
    const { save, send } = harness();
    await save(true);

    const response = await send('POST', START);
    expect(response.status).toBe(200);
    const { runId, kind } = syncStartResultSchema.parse(await response.json());
    expect(kind).toBe('sync');

    const audits = await syncAudits();
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      guild_id: GUILD,
      actor_id: ADMIN,
      source: 'dashboard',
      action: 'module.joinroles.sync.start',
      before: null,
      after: { runId, kind: 'sync' },
      ip_hash: 'hashed-ip',
    });

    const key = joinrolesSyncKey('run', GUILD);
    const ttl = await redis.ttl(key);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(SYNC_RUN_TTL_SECONDS);
    expect(syncRunSchema.parse(JSON.parse((await redis.get(key)) ?? 'null'))).toMatchObject({
      runId,
      guildId: GUILD,
      kind: 'sync',
      trigger: 'dashboard',
      actorId: ADMIN,
      state: 'queued',
      after: '0',
    });

    const events = await published();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      id: `joinroles.sync_requested:${GUILD}:${runId}`,
      type: 'joinroles.sync_requested',
      guildId: GUILD,
    });
    expect(joinrolesSyncRequestedSchema.parse(events[0]?.payload)).toEqual({
      auditId: audits[0]?.id ?? '',
      guildId: GUILD,
      runId,
      kind: 'sync',
      actorId: ADMIN,
    });
  });

  test('a consumer group reading the stream receives the request', async () => {
    const bus = new RedisStreamsEventBus(redis, { blockMs: 100 });
    const { save, send } = harness(bus);
    await save(true);

    const response = await send('POST', START);
    const { runId } = syncStartResultSchema.parse(await response.json());

    const seen: ProtonEvent[] = [];
    const subscription = bus.subscribe(
      'joinroles',
      ['joinroles.sync_requested'],
      async (event) => {
        seen.push(event);
      },
      { startId: '0' },
    );

    try {
      await waitFor(() => seen.length === 1);
      expect(joinrolesSyncRequestedSchema.parse(seen[0]?.payload).runId).toBe(runId);
    } finally {
      await subscription.close();
    }
  });

  test('a second start while the first is queued is refused with no audit row and no event', async () => {
    const { save, send } = harness();
    await save(true, { memberRoleIds: [], botRoleIds: [BOT_ROLE] });

    const first = syncStartResultSchema.parse(await (await send('POST', START)).json());
    const second = await send('POST', COUNT);

    expect(second.status).toBe(409);
    expect(((await second.json()) as { error: string }).error).toBe('already_running');
    expect(await syncAudits()).toHaveLength(1);
    expect(await published()).toHaveLength(1);
    expect(
      syncRunSchema.parse(JSON.parse((await redis.get(joinrolesSyncKey('run', GUILD))) ?? 'null'))
        .runId,
    ).toBe(first.runId);
  });

  test('a queued run the worker never picked up is replaced once it has been silent too long', async () => {
    const { save, send, logs } = harness();
    await save(true);

    const lost = queuedRun({
      runId: 'lost-request',
      guildId: GUILD,
      kind: 'sync',
      trigger: 'dashboard',
      actorId: ADMIN,
      now: Date.now() - SYNC_STALE_MS,
    });
    await redis.set(
      joinrolesSyncKey('run', GUILD),
      JSON.stringify(lost),
      'EX',
      SYNC_RUN_TTL_SECONDS,
    );

    const response = await send('POST', START);

    expect(response.status).toBe(200);
    const { runId } = syncStartResultSchema.parse(await response.json());
    expect(
      syncRunSchema.parse(JSON.parse((await redis.get(joinrolesSyncKey('run', GUILD))) ?? 'null'))
        .runId,
    ).toBe(runId);
    expect(await syncAudits()).toHaveLength(1);
    expect(await published()).toHaveLength(1);
    expect(logs.join('\n')).toContain('lost-request');
  });

  test('a switched-off Join Roles is refused before any slot is claimed', async () => {
    const { save, send } = harness();
    await save(false);

    const response = await send('POST', START);

    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: string }).error).toBe('module_disabled');
    expect(await redis.exists(joinrolesSyncKey('run', GUILD))).toBe(0);
    expect(await syncAudits()).toHaveLength(0);
    expect(await published()).toHaveLength(0);
  });

  test('a failed publish releases the slot in Redis, and the next start goes through', async () => {
    const failing: EventBus = {
      publish: async () => {
        throw new Error('READONLY You cannot write against a read only replica.');
      },
      subscribe: () => {
        throw new Error('the api never subscribes');
      },
    };
    const broken = harness(failing);
    await broken.save(true);

    const response = await broken.send('POST', START);

    expect(response.status).toBe(503);
    expect(((await response.json()) as { error: string }).error).toBe('not_started');
    expect(await redis.exists(joinrolesSyncKey('run', GUILD))).toBe(0);
    expect(await syncAudits()).toHaveLength(1);
    expect(broken.logs.join('\n')).toContain('READONLY');

    expect((await harness().send('POST', START)).status).toBe(200);
    expect(await published()).toHaveLength(1);
  });
});

describe('reading Join Roles sync status against Postgres and Redis', () => {
  test('reports the finished count, its cooldown, and staleness against the saved roles', async () => {
    const { runs, save, send } = harness();
    await save(true);

    const { runId } = syncStartResultSchema.parse(await (await send('POST', COUNT)).json());

    const countedAt = Date.now() - 60_000;
    const config = { ...joinrolesDefaultConfig, enabled: true, memberRoleIds: [MEMBER_ROLE] };
    expect(
      await runs.finish(GUILD, runId, {
        estimate: {
          missing: 12,
          pending: 3,
          scanned: 40,
          countedAt,
          source: 'count',
          fingerprint: syncFingerprint(config),
          failure: null,
        },
      }),
    ).toBe(true);

    const status = syncStatusSchema.parse(await (await send('GET')).json());
    expect(status.run).toBeNull();
    expect(status.last).toBeNull();
    expect(status.estimate).toMatchObject({ missing: 12, pending: 3, stale: false });
    expect(status.nextCountAt).toBe(countedAt + COUNT_COOLDOWN_MS);

    const again = await send('POST', COUNT);
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({
      error: 'counted_recently',
      nextCountAt: countedAt + COUNT_COOLDOWN_MS,
    });

    await save(true, { memberRoleIds: [MEMBER_ROLE, BOT_ROLE] });
    expect(syncStatusSchema.parse(await (await send('GET')).json()).estimate?.stale).toBe(true);
  });

  test('shows a queued sync and then the last sync the worker finished', async () => {
    const { runs, save, send } = harness();
    await save(true);

    const { runId } = syncStartResultSchema.parse(await (await send('POST', START)).json());

    const queued = syncStatusSchema.parse(await (await send('GET')).json());
    expect(queued.run).toMatchObject({ runId, state: 'queued', kind: 'sync' });
    expect(queued.run).not.toHaveProperty('after');

    const now = Date.now();
    await runs.finish(GUILD, runId, {
      last: {
        runId,
        trigger: 'dashboard',
        outcome: 'done',
        failure: null,
        processed: 40,
        updated: 28,
        skipped: { ...emptySkipCounts(), outranks: 2 },
        blockedRoles: [],
        startedAt: now - 30_000,
        finishedAt: now,
      },
    });

    const done = syncStatusSchema.parse(await (await send('GET')).json());
    expect(done.run).toBeNull();
    expect(done.last).toMatchObject({ runId, outcome: 'done', updated: 28 });
    expect(await redis.ttl(joinrolesSyncKey('last', GUILD))).toBeGreaterThan(SYNC_RUN_TTL_SECONDS);
  });
});
