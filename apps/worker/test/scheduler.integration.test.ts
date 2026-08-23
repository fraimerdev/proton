import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type {
  ActionRequest,
  Logger,
  ModuleManifest,
  PrecheckInput,
  RestProxyClient,
  RestRequestOptions,
  RestResponse,
  ScheduledHandler,
} from '@proton/core';
import {
  AUTO_REVERSAL_ACTOR,
  DatabaseReversalScheduler,
  DefaultActionExecutor,
  ModuleRegistry,
  moduleScheduleKey,
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
  scheduledActions,
} from '@proton/db';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import Redis from 'ioredis';
import { z } from 'zod';
import { createScheduledJobRunner } from '../src/module-jobs.ts';
import { createModuleScheduler } from '../src/module-schedule.ts';
import type { ModuleConfigSnapshot } from '../src/runtime.ts';

let postgres: StartedPostgreSqlContainer;
let redisContainer: StartedRedisContainer;
let handle: DbHandle;
let redis: Redis;

const GUILD = '900000000000000001';
const OTHER_GUILD = '900000000000000002';
const BOT = '300000000000000000';
const OWNER = '200000000000000000';
const MOD = '100000000000000000';
const TARGET = '400000000000000000';

const MODULE_ID = 'reminders';
const JOB_ID = 'remind';
const NATURAL_KEY = 'reminder-42';

const START = new Date('2026-08-17T12:00:00.000Z');
const HOUR = 60 * 60 * 1000;

let clock: Date;

class FakeRest implements RestProxyClient {
  readonly calls: RestRequestOptions[] = [];

  failPathContains: string | undefined;

  async request(options: RestRequestOptions): Promise<RestResponse> {
    this.calls.push(options);
    if (this.failPathContains && options.path.includes(this.failPathContains)) {
      return { status: 500, body: { message: 'Internal Server Error' } };
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

const remindersConfigSchema = z.object({
  enabled: z.boolean().default(true),
  message: z.string().default('stand up'),
});

type RemindersConfig = z.infer<typeof remindersConfigSchema>;

const ENABLED: ModuleConfigSnapshot = {
  enabled: true,
  config: { enabled: true, message: 'stand up' },
};

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
  await handle.client`delete from scheduled_actions`;
  await handle.client`delete from cases`;
  await handle.client`delete from guilds`;
  await handle.db.insert(guilds).values([
    { id: GUILD, name: 'test guild' },
    { id: OTHER_GUILD, name: 'other test guild' },
  ]);
  clock = new Date(START);
});

interface Fired {
  data: unknown;
  guildId: string;
  message: string;
}

function build(
  options: {
    handler?: ScheduledHandler<RemindersConfig>;
    maxAttempts?: number;
    renewMs?: number;
  } = {},
) {
  const rest = new FakeRest();
  const logger = new CollectingLogger();
  const store = new DrizzleScheduledActionStore(handle);
  const registry = new ModuleRegistry();
  const fired: Fired[] = [];

  const inner = options.handler ?? (async () => {});
  const handler: ScheduledHandler<RemindersConfig> = async (data, ctx) => {
    await inner(data, ctx);
    fired.push({ data, guildId: ctx.guildId, message: ctx.config.message });
  };

  const manifest: ModuleManifest<typeof remindersConfigSchema> = {
    id: MODULE_ID,
    name: 'Reminders',
    category: 'utility',
    configSchema: remindersConfigSchema,
    defaultConfig: { enabled: true, message: 'stand up' },
    schemaVersion: 1,
    requiredIntents: [],
    requiredPermissions: [],

    schedules: [JOB_ID],
    scheduledHandlers: { [JOB_ID]: handler },
  };
  registry.register(manifest as ModuleManifest);

  const reversals = new DatabaseReversalScheduler({ store, logger });

  const executor = new DefaultActionExecutor({
    dedupe: new RedisDedupeStore(redis),
    rest,
    recorder: new DrizzleCaseRecorder(handle),
    scheduleReversal: (request, caseId) => reversals.schedule(request, caseId),

    resolveContext: async (request): Promise<PrecheckInput> => ({
      guildId: request.guildId,
      guildOwnerId: OWNER,
      botUserId: BOT,
      botHighestRolePosition: 10,
      botChannelPermissions: Permissions.BanMembers | Permissions.ModerateMembers,
      requiredPermissions: requiredPermissionsFor(request.kind, request.payload),
      ...(request.targetId ? { target: { id: request.targetId, highestRolePosition: 1 } } : {}),
    }),
  });

  const schedulerFor = createModuleScheduler({ store, registry, logger });

  const sweeperOf = () =>
    new ScheduledActionSweeper({
      store,
      cases: store,
      executor,
      logger,
      now: () => clock,
      lockMs: 30_000,
      // long enough that no heartbeat fires unless a test asks for one
      renewMs: options.renewMs ?? 10 * 60_000,
      ...(options.maxAttempts === undefined ? {} : { maxAttempts: options.maxAttempts }),

      runModuleJob: createScheduledJobRunner({
        registry,
        config: { get: async () => ENABLED },
        executor,
        logger,
        schedulerFor,
      }),
    });

  return {
    rest,
    logger,
    store,
    executor,
    fired,
    schedulerFor,
    ctx: schedulerFor(MODULE_ID, GUILD),
    sweeper: sweeperOf(),
    sweeperOf,
  };
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

interface ScheduledRow {
  kind: string;
  attempts: number;
  locked_ms: number | null;
  run_at_ms: number;
  idempotency_key: string;
}

async function pendingRows(): Promise<ScheduledRow[]> {
  return (await handle.client`
    select kind, attempts, idempotency_key,
           (extract(epoch from locked_until) * 1000)::float8 as locked_ms,
           (extract(epoch from run_at) * 1000)::float8 as run_at_ms
      from scheduled_actions order by idempotency_key
  `) as ScheduledRow[];
}

async function pendingIds(): Promise<string[]> {
  const rows = (await handle.client`select id from scheduled_actions`) as Array<{ id: string }>;
  return rows.map((row) => row.id);
}

interface CaseRow {
  reverted_ms: number | null;
  reverted_by: string | null;
}

async function caseRow(idempotencyKey: string): Promise<CaseRow | undefined> {
  const rows = (await handle.client`
    select reverted_by,
           (extract(epoch from reverted_at) * 1000)::float8 as reverted_ms
      from cases where idempotency_key = ${idempotencyKey}
  `) as CaseRow[];
  return rows[0];
}

const NOTHING = { claimed: 0, reverted: 0, ran: 0, retrying: 0, abandoned: 0, aborted: 0 };

async function until(condition: () => Promise<boolean>): Promise<boolean> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (await condition()) return true;
    await Bun.sleep(10);
  }
  return false;
}

describe('one scheduled_actions table serving both arms', () => {
  test('a single sweep drains a reversal and a module job without either taking the other path', async () => {
    const { ctx, sweeper, fired, rest, executor } = build();
    const ban = tempBan();

    expect((await executor.execute(ban)).status).toBe('executed');
    await ctx.schedule(JOB_ID, new Date(clock.getTime() + HOUR), NATURAL_KEY, { text: 'drink' });

    const pending = await pendingRows();
    expect(pending.map((r) => r.kind).sort()).toEqual(['module_job', 'unban']);

    expect(await sweeper.sweep()).toEqual(NOTHING);

    clock = new Date(clock.getTime() + HOUR + 1000);

    expect(await sweeper.sweep()).toEqual({
      claimed: 2,
      reverted: 1,
      ran: 1,
      retrying: 0,
      abandoned: 0,
      aborted: 0,
    });

    expect(rest.callsTo('DELETE', `/guilds/${GUILD}/bans/${TARGET}`)).toHaveLength(1);
    expect((await caseRow(ban.idempotencyKey))?.reverted_ms).toBe(clock.getTime());
    expect((await caseRow(ban.idempotencyKey))?.reverted_by).toBe(AUTO_REVERSAL_ACTOR);

    expect(fired).toEqual([{ data: { text: 'drink' }, guildId: GUILD, message: 'stand up' }]);

    expect(await pendingRows()).toHaveLength(0);
    expect(await sweeper.sweep()).toEqual(NOTHING);
  }, 120_000);

  test('a module job that throws does not hold back the reversal claimed beside it', async () => {
    const { ctx, sweeper, fired, rest, executor } = build({
      handler: async () => {
        throw new Error('the reminder channel is gone');
      },
    });
    const ban = tempBan();

    await executor.execute(ban);
    await ctx.schedule(JOB_ID, new Date(clock.getTime() + HOUR), NATURAL_KEY);
    clock = new Date(clock.getTime() + HOUR + 1000);

    expect(await sweeper.sweep()).toEqual({
      claimed: 2,
      reverted: 1,
      ran: 0,
      retrying: 1,
      abandoned: 0,
      aborted: 0,
    });

    expect(rest.callsTo('DELETE', `/guilds/${GUILD}/bans/${TARGET}`)).toHaveLength(1);
    expect((await caseRow(ban.idempotencyKey))?.reverted_ms).toBe(clock.getTime());
    expect(fired).toHaveLength(0);

    const stuck = await pendingRows();
    expect(stuck).toHaveLength(1);
    expect(stuck[0]?.kind).toBe('module_job');
    expect(stuck[0]?.attempts).toBe(1);
    expect(stuck[0]?.locked_ms).toBeNull();
  }, 120_000);

  test('a reversal Discord rejects does not hold back the module job claimed beside it', async () => {
    const { ctx, sweeper, fired, rest, executor } = build();
    const ban = tempBan();

    await executor.execute(ban);
    await ctx.schedule(JOB_ID, new Date(clock.getTime() + HOUR), NATURAL_KEY);
    clock = new Date(clock.getTime() + HOUR + 1000);

    // set after the ban lands: set it earlier and the ban itself 500s, scheduling no reversal
    rest.failPathContains = `/bans/${TARGET}`;

    expect(await sweeper.sweep()).toEqual({
      claimed: 2,
      reverted: 0,
      ran: 1,
      retrying: 1,
      abandoned: 0,
      aborted: 0,
    });

    expect(fired).toHaveLength(1);
    expect((await caseRow(ban.idempotencyKey))?.reverted_ms).toBeNull();

    const stuck = await pendingRows();
    expect(stuck).toHaveLength(1);
    expect(stuck[0]?.kind).toBe('unban');
    expect(stuck[0]?.attempts).toBe(1);

    rest.failPathContains = undefined;
    expect((await sweeper.sweep()).reverted).toBe(1);
    expect((await caseRow(ban.idempotencyKey))?.reverted_ms).toBe(clock.getTime());
    expect(fired).toHaveLength(1);
  }, 120_000);

  test('two sweepers racing over a mixed batch fire every row exactly once', async () => {
    const { schedulerFor, sweeperOf, fired, rest, executor } = build();
    const targets = Array.from({ length: 3 }, (_, i) =>
      (400000000000000010n + BigInt(i)).toString(),
    );

    for (const target of targets) {
      const request = tempBan({
        targetId: target,
        payload: { userId: target, deleteMessageSeconds: 0 },
      });
      expect((await executor.execute(request)).status).toBe('executed');
    }

    const ctx = schedulerFor(MODULE_ID, GUILD);
    for (const target of targets) {
      await ctx.schedule(JOB_ID, new Date(clock.getTime() + HOUR), `reminder-${target}`, {
        target,
      });
    }

    expect(await pendingRows()).toHaveLength(6);
    clock = new Date(clock.getTime() + HOUR + 1000);

    const [a, b] = await Promise.all([sweeperOf().sweep(), sweeperOf().sweep()]);

    expect(a.claimed + b.claimed).toBe(6);
    expect(a.reverted + b.reverted).toBe(3);
    expect(a.ran + b.ran).toBe(3);
    expect(a.retrying + b.retrying).toBe(0);

    const unbans = rest.callsTo('DELETE', `/guilds/${GUILD}/bans/`);
    expect(unbans).toHaveLength(3);
    expect(new Set(unbans.map((c) => c.path)).size).toBe(3);

    expect(fired).toHaveLength(3);
    expect(new Set(fired.map((f) => JSON.stringify(f.data))).size).toBe(3);

    expect(await pendingRows()).toHaveLength(0);
  }, 120_000);
});

describe('module schedule keys', () => {
  test('the same job id and natural key in two servers are two rows that each fire once', async () => {
    const { schedulerFor, sweeper, fired } = build();

    await schedulerFor(MODULE_ID, GUILD).schedule(
      JOB_ID,
      new Date(clock.getTime() + HOUR),
      NATURAL_KEY,
      { which: 'here' },
    );
    await schedulerFor(MODULE_ID, OTHER_GUILD).schedule(
      JOB_ID,
      new Date(clock.getTime() + HOUR),
      NATURAL_KEY,
      { which: 'there' },
    );

    expect((await pendingRows()).map((r) => r.idempotency_key).sort()).toEqual(
      [
        moduleScheduleKey(MODULE_ID, JOB_ID, GUILD, NATURAL_KEY),
        moduleScheduleKey(MODULE_ID, JOB_ID, OTHER_GUILD, NATURAL_KEY),
      ].sort(),
    );

    clock = new Date(clock.getTime() + HOUR + 1000);
    expect((await sweeper.sweep()).ran).toBe(2);

    expect(fired.map((f) => f.guildId).sort()).toEqual([GUILD, OTHER_GUILD].sort());
    expect(await pendingRows()).toHaveLength(0);
  }, 120_000);

  test('cancelling one server’s job leaves the other server’s and the reversals alone', async () => {
    const { schedulerFor, sweeper, fired, executor } = build();
    const ban = tempBan();

    await executor.execute(ban);
    await schedulerFor(MODULE_ID, GUILD).schedule(
      JOB_ID,
      new Date(clock.getTime() + HOUR),
      NATURAL_KEY,
    );
    await schedulerFor(MODULE_ID, OTHER_GUILD).schedule(
      JOB_ID,
      new Date(clock.getTime() + HOUR),
      NATURAL_KEY,
    );

    await schedulerFor(MODULE_ID, GUILD).cancel(JOB_ID, NATURAL_KEY);

    expect((await pendingRows()).map((r) => r.kind).sort()).toEqual(['module_job', 'unban']);

    clock = new Date(clock.getTime() + HOUR + 1000);
    expect(await sweeper.sweep()).toEqual({
      claimed: 2,
      reverted: 1,
      ran: 1,
      retrying: 0,
      abandoned: 0,
      aborted: 0,
    });

    expect(fired.map((f) => f.guildId)).toEqual([OTHER_GUILD]);
    expect((await caseRow(ban.idempotencyKey))?.reverted_ms).toBe(clock.getTime());
  }, 120_000);

  test('a natural key is free to schedule again once the job it named has run', async () => {
    const { ctx, sweeper, fired } = build();
    const key = moduleScheduleKey(MODULE_ID, JOB_ID, GUILD, NATURAL_KEY);

    await ctx.schedule(JOB_ID, new Date(clock.getTime() + HOUR), NATURAL_KEY, { run: 1 });
    clock = new Date(clock.getTime() + HOUR + 1000);
    expect((await sweeper.sweep()).ran).toBe(1);
    expect(await pendingRows()).toHaveLength(0);

    await ctx.schedule(JOB_ID, new Date(clock.getTime() + HOUR), NATURAL_KEY, { run: 2 });

    const again = await pendingRows();
    expect(again).toHaveLength(1);
    expect(again[0]?.idempotency_key).toBe(key);
    expect(again[0]?.attempts).toBe(0);

    clock = new Date(clock.getTime() + HOUR + 1000);
    expect((await sweeper.sweep()).ran).toBe(1);

    expect(fired.map((f) => f.data)).toEqual([{ run: 1 }, { run: 2 }]);
  }, 120_000);
});

describe('a module schedule that renews itself', () => {
  test('a handler rescheduling its own natural key retires its row and inserts the next one', async () => {
    const { ctx, sweeper, fired } = build({
      handler: async (_data, jobCtx) => {
        await jobCtx.schedule?.(JOB_ID, new Date(clock.getTime() + HOUR), NATURAL_KEY);
      },
    });

    await ctx.schedule(JOB_ID, new Date(clock.getTime() + HOUR), NATURAL_KEY);
    const [firstId] = await pendingIds();
    const seen = new Set(firstId ? [firstId] : []);

    for (let tick = 0; tick < 3; tick += 1) {
      clock = new Date(clock.getTime() + HOUR + 1000);
      expect((await sweeper.sweep()).ran).toBe(1);
      for (const id of await pendingIds()) seen.add(id);
    }

    expect(fired).toHaveLength(3);

    const pending = await pendingRows();
    expect(pending).toHaveLength(1);
    expect(pending[0]?.idempotency_key).toBe(
      moduleScheduleKey(MODULE_ID, JOB_ID, GUILD, NATURAL_KEY),
    );
    expect(pending[0]?.attempts).toBe(0);
    expect(pending[0]?.run_at_ms).toBe(clock.getTime() + HOUR);

    // a cycle books a new row rather than reusing the one it ran: the run that booked it must not
    // be able to retire it afterwards
    expect(seen.size).toBe(4);
    expect(await pendingIds()).not.toEqual([firstId ?? '']);
  }, 120_000);

  test('a cycle that failed once renews with its whole retry budget back', async () => {
    let attempt = 0;
    const { ctx, sweeper, fired } = build({
      maxAttempts: 2,
      handler: async (_data, jobCtx) => {
        attempt += 1;
        if (attempt % 2 === 1) throw new Error('the reminder channel is gone');
        await jobCtx.schedule?.(JOB_ID, new Date(clock.getTime() + HOUR), NATURAL_KEY);
      },
    });

    await ctx.schedule(JOB_ID, new Date(clock.getTime() + HOUR), NATURAL_KEY);

    for (let cycle = 0; cycle < 3; cycle += 1) {
      clock = new Date(clock.getTime() + HOUR + 1000);
      expect((await sweeper.sweep()).retrying).toBe(1);
      expect((await sweeper.sweep()).ran).toBe(1);
    }

    expect(attempt).toBe(6);
    expect(fired).toHaveLength(3);

    const pending = await pendingRows();
    expect(pending).toHaveLength(1);
    expect(pending[0]?.attempts).toBe(0);
  }, 120_000);

  test('a renewing job and a reversal drain the same batch without either losing its row', async () => {
    const { ctx, sweeper, fired, rest, executor } = build({
      handler: async (_data, jobCtx) => {
        await jobCtx.schedule?.(JOB_ID, new Date(clock.getTime() + HOUR), NATURAL_KEY);
      },
    });
    const ban = tempBan();

    expect((await executor.execute(ban)).status).toBe('executed');
    await ctx.schedule(JOB_ID, new Date(clock.getTime() + HOUR), NATURAL_KEY);

    clock = new Date(clock.getTime() + HOUR + 1000);
    expect(await sweeper.sweep()).toEqual({
      claimed: 2,
      reverted: 1,
      ran: 1,
      retrying: 0,
      abandoned: 0,
      aborted: 0,
    });

    expect(rest.callsTo('DELETE', `/guilds/${GUILD}/bans/${TARGET}`)).toHaveLength(1);
    expect((await caseRow(ban.idempotencyKey))?.reverted_ms).toBe(clock.getTime());
    expect(fired).toHaveLength(1);

    const pending = await pendingRows();
    expect(pending).toHaveLength(1);
    expect(pending[0]?.kind).toBe('module_job');
  }, 120_000);

  test('a handler that renews and then throws keeps the renewal and is not retried on top of it', async () => {
    const { ctx, sweeper, fired, logger } = build({
      handler: async (_data, jobCtx) => {
        await jobCtx.schedule?.(JOB_ID, new Date(clock.getTime() + HOUR), NATURAL_KEY);
        throw new Error('the reminder channel is gone');
      },
    });

    await ctx.schedule(JOB_ID, new Date(clock.getTime() + HOUR), NATURAL_KEY);
    clock = new Date(clock.getTime() + HOUR + 1000);

    expect((await sweeper.sweep()).aborted).toBe(1);
    expect(fired).toHaveLength(0);

    const [broken] = logger.matching('error', 'booked its next run and then failed');
    expect(broken?.message).toContain('the reminder channel is gone');

    const pending = await pendingRows();
    expect(pending).toHaveLength(1);
    expect(pending[0]?.attempts).toBe(0);
    expect(pending[0]?.locked_ms).toBeNull();
  }, 120_000);

  test('a cycle that renews and then throws every time runs once a cycle, not once a sweep', async () => {
    let cycles = 0;
    const { ctx, sweeper, logger } = build({
      maxAttempts: 3,
      handler: async (_data, jobCtx) => {
        cycles += 1;
        await jobCtx.schedule?.(JOB_ID, new Date(clock.getTime() + HOUR), NATURAL_KEY);
        throw new Error('the reminder channel is gone');
      },
    });

    await ctx.schedule(JOB_ID, new Date(clock.getTime() + HOUR), NATURAL_KEY);

    for (let tick = 0; tick < 5; tick += 1) {
      clock = new Date(clock.getTime() + HOUR + 1000);
      expect((await sweeper.sweep()).aborted).toBe(1);
      expect(await sweeper.sweep()).toEqual(NOTHING);
    }

    // the budget covers retries of one run; booking the next run is a new run with its own budget
    expect(cycles).toBe(5);
    expect(logger.matching('error', 'by hand')).toHaveLength(0);

    const pending = await pendingRows();
    expect(pending).toHaveLength(1);
    expect(pending[0]?.attempts).toBe(0);
    expect(pending[0]?.locked_ms).toBeNull();
  }, 120_000);
});

describe('rows written before the payload became a discriminated union', () => {
  test('a payload with no kind still lifts the ban it was scheduled to lift', async () => {
    const { sweeper, rest, executor, logger } = build();
    const ban = tempBan();

    expect((await executor.execute(ban)).status).toBe('executed');
    // exactly what the previous build wrote: a reversal payload with no discriminator
    await handle.client`update scheduled_actions set payload = payload - 'kind'`;

    clock = new Date(clock.getTime() + HOUR + 1000);

    expect(await sweeper.sweep()).toEqual({
      claimed: 1,
      reverted: 1,
      ran: 0,
      retrying: 0,
      abandoned: 0,
      aborted: 0,
    });

    expect(rest.callsTo('DELETE', `/guilds/${GUILD}/bans/${TARGET}`)).toHaveLength(1);
    expect((await caseRow(ban.idempotencyKey))?.reverted_ms).toBe(clock.getTime());
    expect((await caseRow(ban.idempotencyKey))?.reverted_by).toBe(AUTO_REVERSAL_ACTOR);

    expect(logger.matching('warn', 'no longer matches the expected shape')).toHaveLength(0);
    expect(await pendingRows()).toHaveLength(0);
  }, 120_000);

  test('the migration stamps the discriminator onto rows the old build left behind', async () => {
    await handle.db.insert(scheduledActions).values({
      id: newId(),
      guildId: GUILD,
      runAt: new Date(clock.getTime() - 1000),
      kind: 'unban',
      idempotencyKey: `reversal:${newId()}`,
      payload: {
        caseId: newId(),
        moduleId: 'moderation',
        actorId: MOD,
        targetId: TARGET,
        originalKind: 'ban',
        action: { userId: TARGET },
      },
    });

    const migration = `${import.meta.dir}/../../../packages/db/drizzle/0007_scheduled_action_kind.sql`;
    await handle.client.unsafe(await Bun.file(migration).text());

    const [row] = (await handle.client`
      select payload->>'kind' as kind from scheduled_actions
    `) as Array<{ kind: string | null }>;

    expect(row?.kind).toBe('reversal');
  }, 120_000);
});

describe('a module job whose handler outlives its lock', () => {
  function heldOpen(options: { renewMs?: number } = {}) {
    let started: () => void = () => {};
    let finish: () => void = () => {};
    const handlerStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const handlerMayFinish = new Promise<void>((resolve) => {
      finish = resolve;
    });

    const built = build({
      ...(options.renewMs === undefined ? {} : { renewMs: options.renewMs }),
      handler: async () => {
        started();
        await handlerMayFinish;
      },
    });

    return { ...built, handlerStarted, finish: () => finish() };
  }

  test('keeps its row: the heartbeat renews the lease under the running handler', async () => {
    const { ctx, sweeperOf, fired, handlerStarted, finish } = heldOpen({ renewMs: 20 });

    await ctx.schedule(JOB_ID, new Date(clock.getTime() + HOUR), NATURAL_KEY, { text: 'drink' });
    clock = new Date(clock.getTime() + HOUR + 1000);

    const overrunning = sweeperOf().sweep();
    await handlerStarted;

    clock = new Date(clock.getTime() + 31_000);
    const renewed = await until(async () => {
      const [row] = await pendingRows();
      return (row?.locked_ms ?? 0) > clock.getTime();
    });

    expect(renewed).toBe(true);
    expect(await sweeperOf().sweep()).toEqual(NOTHING);

    finish();
    expect((await overrunning).ran).toBe(1);

    expect(fired).toEqual([{ data: { text: 'drink' }, guildId: GUILD, message: 'stand up' }]);
    expect(await pendingRows()).toHaveLength(0);
  }, 120_000);

  test('leaves the row to the sweep that reclaimed it rather than retiring it underneath', async () => {
    const { ctx, sweeperOf, fired, logger, handlerStarted, finish } = heldOpen();

    await ctx.schedule(JOB_ID, new Date(clock.getTime() + HOUR), NATURAL_KEY, { text: 'drink' });
    clock = new Date(clock.getTime() + HOUR + 1000);

    const overrunning = sweeperOf().sweep();
    await handlerStarted;

    clock = new Date(clock.getTime() + 31_000);
    const reclaimed = sweeperOf().sweep();

    const relocked = await until(async () => {
      const [row] = await pendingRows();
      return (row?.locked_ms ?? 0) > clock.getTime();
    });
    expect(relocked).toBe(true);

    finish();

    expect(await overrunning).toEqual({ ...NOTHING, claimed: 1, aborted: 1 });
    expect(await reclaimed).toEqual({ ...NOTHING, claimed: 1, ran: 1 });

    // a lapsed lease means the job really does run twice; what must not happen is the first run
    // deleting, unlocking or rescheduling the row the second one holds
    expect(fired).toHaveLength(2);
    expect(await pendingRows()).toHaveLength(0);

    const [stopped] = logger.matching('error', 'left the row untouched');
    expect(stopped?.message).toContain(`${MODULE_ID}:${JOB_ID}`);
    expect(stopped?.message).toContain('lockMs');
    expect(logger.matching('warn', 'will retry')).toHaveLength(0);
  }, 120_000);

  test('a holder killed mid-handler leaves a row that runs exactly once afterwards', async () => {
    const { ctx, sweeperOf, store, fired } = build();

    await ctx.schedule(JOB_ID, new Date(clock.getTime() + HOUR), NATURAL_KEY, { text: 'drink' });
    clock = new Date(clock.getTime() + HOUR + 1000);

    // exactly what a killed sweep leaves behind: the row leased, no heartbeat, nothing retired
    const leased = await store.claimDue({
      now: clock,
      lockUntil: new Date(clock.getTime() + 30_000),
      limit: 10,
      maxAttempts: 5,
    });
    expect(leased).toHaveLength(1);

    expect(await sweeperOf().sweep()).toEqual(NOTHING);

    clock = new Date(clock.getTime() + 31_000);
    expect(await sweeperOf().sweep()).toEqual({ ...NOTHING, claimed: 1, ran: 1 });

    expect(fired).toHaveLength(1);
    expect(await pendingRows()).toHaveLength(0);

    clock = new Date(clock.getTime() + 5 * 60_000);
    expect(await sweeperOf().sweep()).toEqual(NOTHING);
    expect(fired).toHaveLength(1);

    // the killed holder's token is not the token the row was re-claimed under
    expect(await store.complete(leased[0]?.id ?? '', leased[0]?.lockToken ?? '')).toBe('lost');
  }, 120_000);
});
