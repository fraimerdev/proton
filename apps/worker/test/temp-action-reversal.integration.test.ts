import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type {
  ActionRequest,
  Logger,
  PrecheckInput,
  RestProxyClient,
  RestResponse,
} from '@proton/core';
import {
  AUTO_REVERSAL_ACTOR,
  DatabaseReversalScheduler,
  DefaultActionExecutor,
  newId,
  Permissions,
  RedisDedupeStore,
  requiredPermissionsFor,
  ScheduledActionSweeper,
} from '@proton/core';
import {
  createDb,
  type DbHandle,
  DrizzleCaseRecorder,
  DrizzleScheduledActionStore,
  guilds,
  runMigrations,
} from '@proton/db';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import Redis from 'ioredis';

let postgres: StartedPostgreSqlContainer;
let redisContainer: StartedRedisContainer;
let handle: DbHandle;
let redis: Redis;

const GUILD = '900000000000000001';
const BOT = '300000000000000000';
const OWNER = '200000000000000000';
const MOD = '100000000000000000';
const TARGET = '400000000000000000';

const START = new Date('2026-08-14T12:00:00.000Z');
const HOUR = 60 * 60 * 1000;

let clock: Date;

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
  await handle.client`delete from scheduled_actions`;
  await handle.client`delete from cases`;
  await handle.client`delete from guilds`;
  await handle.db.insert(guilds).values({ id: GUILD, name: 'test guild' });
  await redis.flushall();
  clock = new Date(START);
});

class FakeRest implements RestProxyClient {
  readonly calls: Array<{ method: string; path: string; body?: unknown }> = [];

  failPathContains: string | undefined;
  failureStatus = 500;

  async request(options: { method: string; path: string; body?: unknown }): Promise<RestResponse> {
    this.calls.push(options);
    if (this.failPathContains && options.path.includes(this.failPathContains)) {
      return { status: this.failureStatus, body: { message: 'Internal Server Error' } };
    }
    return { status: 204, body: {} };
  }

  callsTo(method: string, pathFragment: string) {
    return this.calls.filter((c) => c.method === method && c.path.includes(pathFragment));
  }
}

class CollectingLogger implements Logger {
  readonly lines: Array<{ level: string; message: string }> = [];
  info(message: string) {
    this.lines.push({ level: 'info', message });
  }
  warn(message: string) {
    this.lines.push({ level: 'warn', message });
  }
  error(message: string) {
    this.lines.push({ level: 'error', message });
  }
  matching(level: string, fragment: string) {
    return this.lines.filter((l) => l.level === level && l.message.includes(fragment));
  }
}

function build(options: { maxAttempts?: number } = {}) {
  const rest = new FakeRest();
  const logger = new CollectingLogger();
  const store = new DrizzleScheduledActionStore(handle);
  const scheduler = new DatabaseReversalScheduler({ store, logger });

  const executor = new DefaultActionExecutor({
    dedupe: new RedisDedupeStore(redis),
    rest,
    recorder: new DrizzleCaseRecorder(handle),
    scheduleReversal: (request, caseId) => scheduler.schedule(request, caseId),

    resolveContext: async (request): Promise<PrecheckInput> => ({
      guildId: GUILD,
      guildOwnerId: OWNER,
      botUserId: BOT,
      botHighestRolePosition: 10,
      botChannelPermissions: Permissions.BanMembers | Permissions.ModerateMembers,
      requiredPermissions: requiredPermissionsFor(request.kind, request.payload),
      ...(request.targetId ? { target: { id: request.targetId, highestRolePosition: 1 } } : {}),
    }),
  });

  const sweeperOf = () =>
    new ScheduledActionSweeper({
      store,
      cases: store,
      executor,
      logger,
      now: () => clock,
      lockMs: 30_000,
      ...(options.maxAttempts === undefined ? {} : { maxAttempts: options.maxAttempts }),
    });

  return { rest, logger, store, executor, sweeper: sweeperOf(), sweeperOf };
}

function tempBan(overrides: Partial<ActionRequest> = {}): ActionRequest {
  return {
    guildId: GUILD,
    moduleId: 'moderation',
    kind: 'ban',
    targetId: TARGET,
    actorId: MOD,
    reason: 'spam',
    payload: { userId: TARGET, deleteMessageSeconds: 0 },
    expiresAt: new Date(clock.getTime() + HOUR),
    dryRun: false,
    idempotencyKey: newId(),
    ...overrides,
  };
}

interface CaseRow {
  id: string;
  type: string;
  expires_ms: number | null;
  reverted_ms: number | null;
  reverted_by: string | null;
}

async function caseRow(idempotencyKey: string): Promise<CaseRow | undefined> {
  const found = (await handle.client`
    select id, type, reverted_by,
           (extract(epoch from expires_at) * 1000)::float8 as expires_ms,
           (extract(epoch from reverted_at) * 1000)::float8 as reverted_ms
      from cases where idempotency_key = ${idempotencyKey}
  `) as CaseRow[];
  return found[0];
}

interface ScheduledRow {
  id: string;
  kind: string;
  run_at_ms: number;
  attempts: number;
  locked_ms: number | null;
  idempotency_key: string;
}

async function scheduledRows(): Promise<ScheduledRow[]> {
  return (await handle.client`
    select id, kind, attempts, idempotency_key,
           (extract(epoch from run_at) * 1000)::float8 as run_at_ms,
           (extract(epoch from locked_until) * 1000)::float8 as locked_ms
      from scheduled_actions order by run_at
  `) as ScheduledRow[];
}

const NOTHING = { claimed: 0, reverted: 0, ran: 0, retrying: 0, abandoned: 0, aborted: 0 };

describe('temp action auto-reversal (Gate 1 acceptance)', () => {
  test('a temp ban lifts itself exactly once when its expiry passes', async () => {
    const { rest, sweeper, executor } = build();
    const request = tempBan();
    const expiresAt = request.expiresAt as Date;

    expect((await executor.execute(request)).status).toBe('executed');

    const banCase = await caseRow(request.idempotencyKey);
    expect(banCase?.expires_ms).toBe(expiresAt.getTime());
    expect(banCase?.reverted_ms).toBeNull();

    const pending = await scheduledRows();
    expect(pending).toHaveLength(1);
    expect(pending[0]?.kind).toBe('unban');
    expect(pending[0]?.run_at_ms).toBe(expiresAt.getTime());
    expect(pending[0]?.idempotency_key).toBe(`reversal:${request.idempotencyKey}`);

    expect(await sweeper.sweep()).toEqual(NOTHING);
    expect(rest.callsTo('DELETE', '/bans/')).toHaveLength(0);

    clock = new Date(clock.getTime() + HOUR + 1000);

    expect(await sweeper.sweep()).toEqual({
      claimed: 1,
      reverted: 1,
      ran: 0,
      retrying: 0,
      abandoned: 0,
      aborted: 0,
    });

    expect(rest.callsTo('PUT', `/guilds/${GUILD}/bans/${TARGET}`)).toHaveLength(1);
    expect(rest.callsTo('DELETE', `/guilds/${GUILD}/bans/${TARGET}`)).toHaveLength(1);

    const reverted = await caseRow(request.idempotencyKey);
    expect(reverted?.reverted_ms).toBe(clock.getTime());

    expect(reverted?.reverted_by).toBe(AUTO_REVERSAL_ACTOR);

    expect((await caseRow(`reversal:${request.idempotencyKey}`))?.type).toBe('unban');
    expect(await scheduledRows()).toHaveLength(0);
  }, 120_000);

  test('a temp timeout schedules and performs an untimeout', async () => {
    const { rest, sweeper, executor } = build();

    const until = new Date(Date.now() + HOUR);
    const request = tempBan({
      kind: 'timeout',
      payload: { userId: TARGET, until },
      expiresAt: until,
    });

    expect((await executor.execute(request)).status).toBe('executed');

    const pending = await scheduledRows();
    expect(pending).toHaveLength(1);
    expect(pending[0]?.kind).toBe('untimeout');

    clock = new Date(until.getTime() + 1000);
    expect((await sweeper.sweep()).reverted).toBe(1);

    const patches = rest.callsTo('PATCH', `/guilds/${GUILD}/members/${TARGET}`);
    expect(patches).toHaveLength(2);
    expect(patches[1]?.body).toEqual({ communication_disabled_until: null });
    expect((await caseRow(request.idempotencyKey))?.reverted_ms).toBe(clock.getTime());
  }, 120_000);

  test('a second sweep after the first changes nothing', async () => {
    const { rest, sweeper, store, executor } = build();
    const request = tempBan();
    await executor.execute(request);
    clock = new Date(clock.getTime() + HOUR + 1000);
    await sweeper.sweep();

    const callsAfterFirstSweep = rest.calls.length;

    expect(await sweeper.sweep()).toEqual(NOTHING);
    expect(rest.calls).toHaveLength(callsAfterFirstSweep);

    await store.schedule({
      guildId: GUILD,
      runAt: clock,
      kind: 'unban',
      idempotencyKey: `reversal:${request.idempotencyKey}`,
      payload: {
        kind: 'reversal',
        caseId: (await caseRow(request.idempotencyKey))?.id ?? '',
        moduleId: 'moderation',
        actorId: MOD,
        targetId: TARGET,
        originalKind: 'ban',
        action: { userId: TARGET },
      },
    });

    expect((await sweeper.sweep()).claimed).toBe(1);
    expect(rest.callsTo('DELETE', `/guilds/${GUILD}/bans/${TARGET}`)).toHaveLength(1);
  }, 120_000);

  test('two concurrent sweepers never take the same reversal', async () => {
    const { rest, executor, sweeperOf } = build();
    const targets = Array.from({ length: 6 }, (_, i) =>
      (400000000000000010n + BigInt(i)).toString(),
    );

    for (const target of targets) {
      const request = tempBan({
        targetId: target,
        payload: { userId: target, deleteMessageSeconds: 0 },
      });
      expect((await executor.execute(request)).status).toBe('executed');
    }

    clock = new Date(clock.getTime() + HOUR + 1000);

    const [a, b] = await Promise.all([sweeperOf().sweep(), sweeperOf().sweep()]);

    expect(a.claimed + b.claimed).toBe(6);
    expect(a.reverted + b.reverted).toBe(6);

    const unbans = rest.callsTo('DELETE', `/guilds/${GUILD}/bans/`);
    expect(unbans).toHaveLength(6);

    expect(new Set(unbans.map((c) => c.path)).size).toBe(6);
    expect(await scheduledRows()).toHaveLength(0);
  }, 120_000);

  test('a reversal Discord rejects is retried, and attempts climbs', async () => {
    const { rest, logger, sweeper, executor } = build();
    const request = tempBan();
    await executor.execute(request);
    clock = new Date(clock.getTime() + HOUR + 1000);

    rest.failPathContains = `/bans/${TARGET}`;

    expect(await sweeper.sweep()).toEqual({
      claimed: 1,
      reverted: 0,
      ran: 0,
      retrying: 1,
      abandoned: 0,
      aborted: 0,
    });

    let pending = await scheduledRows();
    expect(pending).toHaveLength(1);
    expect(pending[0]?.attempts).toBe(1);

    expect(pending[0]?.locked_ms).toBeNull();

    expect((await sweeper.sweep()).retrying).toBe(1);
    pending = await scheduledRows();
    expect(pending[0]?.attempts).toBe(2);

    expect((await caseRow(request.idempotencyKey))?.reverted_ms).toBeNull();
    expect(logger.matching('warn', 'will retry').length).toBeGreaterThan(0);

    rest.failPathContains = undefined;
    expect((await sweeper.sweep()).reverted).toBe(1);

    expect(rest.callsTo('DELETE', `/guilds/${GUILD}/bans/${TARGET}`)).toHaveLength(3);
    expect((await caseRow(request.idempotencyKey))?.reverted_ms).toBe(clock.getTime());
    expect(await scheduledRows()).toHaveLength(0);
  }, 120_000);

  test('a reversal that keeps failing is abandoned and reported, not retried forever', async () => {
    const { rest, logger, sweeper, executor } = build({ maxAttempts: 2 });
    const request = tempBan();
    await executor.execute(request);
    clock = new Date(clock.getTime() + HOUR + 1000);
    rest.failPathContains = `/bans/${TARGET}`;

    expect((await sweeper.sweep()).retrying).toBe(1);
    expect(await sweeper.sweep()).toEqual({
      claimed: 1,
      reverted: 0,
      ran: 0,
      retrying: 0,
      abandoned: 1,
      aborted: 0,
    });

    expect(await sweeper.sweep()).toEqual(NOTHING);
    expect(rest.callsTo('DELETE', `/guilds/${GUILD}/bans/${TARGET}`)).toHaveLength(2);

    const stuck = await scheduledRows();
    expect(stuck).toHaveLength(1);
    expect(stuck[0]?.attempts).toBe(2);

    const gaveUp = logger.matching('error', 'giving up');
    expect(gaveUp).toHaveLength(1);
    expect(gaveUp[0]?.message).toContain('by hand');
  }, 120_000);

  test('an action with no reversal is refused before Discord is touched', async () => {
    const { rest, executor } = build();
    const request = tempBan({ kind: 'kick', payload: { userId: TARGET } });

    const result = await executor.execute(request);

    expect(result.status).toBe('failed_precheck');
    expect(result.failure?.code).toBe('not_reversible');
    expect(result.failure?.humanReason).toContain("'kick'");
    expect(rest.calls).toHaveLength(0);
    expect(await scheduledRows()).toHaveLength(0);
    expect(await caseRow(request.idempotencyKey)).toBeUndefined();
  }, 120_000);

  test('a permanent ban schedules nothing at all', async () => {
    const { sweeper, executor } = build();
    const { expiresAt: _dropped, ...permanent } = tempBan();

    expect((await executor.execute(permanent)).status).toBe('executed');

    expect(await scheduledRows()).toHaveLength(0);
    expect((await caseRow(permanent.idempotencyKey))?.expires_ms).toBeNull();

    clock = new Date(clock.getTime() + 365 * 24 * HOUR);
    expect(await sweeper.sweep()).toEqual(NOTHING);
  }, 120_000);
});
