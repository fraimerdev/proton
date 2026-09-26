import { describe, expect, test } from 'bun:test';
import { RedisMaintenanceStore } from '@proton/module-antinuke';
import { joinrolesSyncKey, RedisJoinRolesRunStore } from '@proton/module-joinroles/sync-store';
import {
  emptySkipCounts,
  type LastSync,
  queuedRun,
  type SyncEstimate,
} from '@proton/module-joinroles/sync-view';
import type { Redis } from 'ioredis';
import { loadEnv } from '../src/env.ts';
import { createApiRedis, type RedisConnect } from '../src/redis.ts';

const GUILD = '900000000000000001';
const URL = 'redis://127.0.0.1:6379';

class FakeRedis {
  readonly values = new Map<string, string>();
  readonly db: number;
  readonly label: string;

  constructor(db: number, label: string) {
    this.db = db;
    this.label = label;
  }

  async get(key: string): Promise<string | null> {
    return this.values.get(key) ?? null;
  }

  async set(key: string, value: string, ...flags: Array<string | number>): Promise<'OK' | null> {
    if (flags.includes('NX') && this.values.has(key)) return null;

    this.values.set(key, value);
    return 'OK';
  }

  async del(key: string): Promise<number> {
    return this.values.delete(key) ? 1 : 0;
  }
}

function connections(): {
  made: FakeRedis[];
  connect: RedisConnect;
  on: (db: number) => FakeRedis;
} {
  const made: FakeRedis[] = [];

  const connect: RedisConnect = (_url, { db, label }) => {
    const redis = new FakeRedis(db, label);
    made.push(redis);
    return redis as unknown as Redis;
  };

  const on = (db: number): FakeRedis => {
    const found = made.find((redis) => redis.db === db);
    if (!found) throw new Error(`no connection was opened to database ${db}`);
    return found;
  };

  return { made, connect, on };
}

function window(now: number) {
  return {
    guildId: GUILD,
    enabledBy: '200000000000000009',
    reason: 'Rebuilding the channel layout',
    startedAt: now,
    expiresAt: now + 30 * 60_000,
  };
}

describe('the api Redis connections', () => {
  test('the maintenance store reads the window the worker wrote to the modules database', async () => {
    const { connect, on } = connections();
    const redis = createApiRedis({ REDIS_URL: URL, REDIS_DB_BUS: 0, REDIS_DB_MODULES: 4 }, connect);
    const opened = window(Date.now());

    await new RedisMaintenanceStore(on(4) as unknown as Redis).set(opened);

    expect(await redis?.maintenance.get(GUILD)).toEqual(opened);
    expect(on(0).values.size).toBe(0);
  });

  test('ending maintenance clears the modules database and leaves the bus database alone', async () => {
    const { connect, on } = connections();
    const redis = createApiRedis({ REDIS_URL: URL, REDIS_DB_BUS: 0, REDIS_DB_MODULES: 4 }, connect);

    await new RedisMaintenanceStore(on(4) as unknown as Redis).set(window(Date.now()));
    await redis?.maintenance.clear(GUILD);

    expect(on(4).values.size).toBe(0);
    expect(await redis?.maintenance.get(GUILD)).toBeNull();
  });

  test('a configured REDIS_DB_MODULES is the database the maintenance store uses', async () => {
    const { connect, on } = connections();
    const redis = createApiRedis({ REDIS_URL: URL, REDIS_DB_BUS: 0, REDIS_DB_MODULES: 9 }, connect);

    await new RedisMaintenanceStore(on(9) as unknown as Redis).set(window(Date.now()));

    expect((await redis?.maintenance.get(GUILD))?.guildId).toBe(GUILD);
    expect(on(9).label).toBe('api/modules');
  });

  test('the Join Roles run store reads the run the worker claimed on the modules database', async () => {
    const { connect, on } = connections();
    const redis = createApiRedis({ REDIS_URL: URL, REDIS_DB_BUS: 0, REDIS_DB_MODULES: 4 }, connect);
    const run = queuedRun({
      runId: 's20000',
      guildId: GUILD,
      kind: 'sync',
      trigger: 'schedule',
      actorId: null,
      now: Date.now(),
    });

    expect(await new RedisJoinRolesRunStore(on(4) as unknown as Redis).claim(run)).toBe(true);

    expect(await redis?.joinrolesRuns.get(GUILD)).toEqual(run);
    expect(on(4).values.has(joinrolesSyncKey('run', GUILD))).toBe(true);
    expect(on(0).values.size).toBe(0);
  });

  test('a run the api claims holds the slot the worker checks, and a second claim is refused', async () => {
    const { connect, on } = connections();
    const redis = createApiRedis({ REDIS_URL: URL, REDIS_DB_BUS: 0, REDIS_DB_MODULES: 4 }, connect);
    const now = Date.now();
    const first = queuedRun({
      runId: '01J00000000000000000000001',
      guildId: GUILD,
      kind: 'count',
      trigger: 'dashboard',
      actorId: '200000000000000009',
      now,
    });

    expect(await redis?.joinrolesRuns.claim(first)).toBe(true);
    expect(
      await redis?.joinrolesRuns.claim({ ...first, runId: '01J00000000000000000000002' }),
    ).toBe(false);
    expect(await new RedisJoinRolesRunStore(on(4) as unknown as Redis).get(GUILD)).toEqual(first);
  });

  test('the last sync and the estimate are read from the keys the worker writes', async () => {
    const { connect, on } = connections();
    const redis = createApiRedis({ REDIS_URL: URL, REDIS_DB_BUS: 0, REDIS_DB_MODULES: 4 }, connect);
    const now = Date.now();

    const last: LastSync = {
      runId: 's20000',
      trigger: 'schedule',
      outcome: 'done',
      failure: null,
      processed: 5000,
      updated: 312,
      skipped: { ...emptySkipCounts(), pending: 20 },
      blockedRoles: [],
      startedAt: now - 60_000,
      finishedAt: now,
    };
    const estimate: SyncEstimate = {
      missing: 20,
      pending: 20,
      scanned: 5000,
      countedAt: now,
      source: 'sync',
      fingerprint: 'm:410000000000000001|b:|x:|s:1',
      failure: null,
    };

    await on(4).set(joinrolesSyncKey('last', GUILD), JSON.stringify(last));
    await on(4).set(joinrolesSyncKey('estimate', GUILD), JSON.stringify(estimate));

    expect(await redis?.joinrolesRuns.last(GUILD)).toEqual(last);
    expect(await redis?.joinrolesRuns.estimate(GUILD)).toEqual(estimate);
    expect(await redis?.joinrolesRuns.get(GUILD)).toBeNull();
  });

  test('without REDIS_URL no connection is opened at all', () => {
    const { made, connect } = connections();

    expect(createApiRedis({ REDIS_DB_BUS: 0, REDIS_DB_MODULES: 4 }, connect)).toBeNull();
    expect(made).toHaveLength(0);
  });

  test('REDIS_DB_MODULES defaults to 4, the database the worker defaults to', () => {
    const env = loadEnv({
      DATABASE_URL: 'postgres://proton:secret@127.0.0.1:5432/proton',
      API_SHARED_SECRET: 'a-shared-secret-of-length',
    });

    expect(env.REDIS_DB_MODULES).toBe(4);
  });
});
