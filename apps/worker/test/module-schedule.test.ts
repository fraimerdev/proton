import { beforeEach, describe, expect, test } from 'bun:test';
import type {
  ActionExecutor,
  ActionRequest,
  ActionResult,
  CaseReversalInput,
  CaseReversalStore,
  ClaimDueOptions,
  CompleteOutcome,
  Logger,
  ModuleManifest,
  ScheduledActionInput,
  ScheduledActionRecord,
  ScheduledActionStore,
  ScheduledHandler,
  ScheduleOutcome,
} from '@proton/core';
import {
  ModuleRegistry,
  moduleScheduleKey,
  ScheduledActionSweeper,
  UndeclaredScheduleError,
} from '@proton/core';
import { z } from 'zod';
import { ConfigUnavailableError } from '../src/config-provider.ts';
import { createScheduledJobRunner } from '../src/module-jobs.ts';
import { createModuleScheduler } from '../src/module-schedule.ts';
import type { ModuleConfigSnapshot } from '../src/runtime.ts';

const GUILD = '900000000000000001';
const OTHER_GUILD = '900000000000000002';

const MODULE_ID = 'reminders';
const JOB_ID = 'remind';
const NATURAL_KEY = 'reminder-42';

const START = new Date('2026-08-17T12:00:00.000Z');
const HOUR = 60 * 60 * 1000;

let clock: Date;

type Row = Omit<ScheduledActionRecord, 'lockToken'> & {
  lockedUntil: Date | null;
  lockToken: string | null;
};

const holdsLock = (row: Row, lockToken: string): boolean => row.lockToken === lockToken;

class MemoryStore implements ScheduledActionStore, CaseReversalStore {
  readonly rows: Row[] = [];
  readonly reverted: CaseReversalInput[] = [];
  // ids and tokens are never recycled: a reused one would let a superseded sweep retire the row
  // that replaced the one it actually ran
  #nextId = 1;
  #nextToken = 1;

  #insert(input: Omit<ScheduledActionInput, 'onConflict'>): Row {
    const row: Row = {
      id: `row-${this.#nextId++}`,
      guildId: input.guildId,
      runAt: input.runAt,
      kind: input.kind,
      attempts: 0,
      idempotencyKey: input.idempotencyKey,
      payload: input.payload,
      lockedUntil: null,
      lockToken: null,
    };

    this.rows.push(row);
    return row;
  }

  async schedule(input: ScheduledActionInput): Promise<ScheduleOutcome> {
    const existing = this.rows.find((row) => row.idempotencyKey === input.idempotencyKey);

    if (existing) {
      if (input.onConflict !== 'replace') return { scheduled: false, replaced: false };

      existing.runAt = input.runAt;
      existing.kind = input.kind;
      existing.payload = input.payload;
      existing.attempts = 0;
      existing.lockedUntil = null;
      existing.lockToken = null;
      return { scheduled: true, replaced: true };
    }

    this.#insert(input);
    return { scheduled: true, replaced: false };
  }

  async claimDue(options: ClaimDueOptions): Promise<ScheduledActionRecord[]> {
    return this.rows
      .filter(
        (row) =>
          row.runAt <= options.now &&
          (row.lockedUntil === null || row.lockedUntil < options.now) &&
          row.attempts < options.maxAttempts,
      )
      .sort((a, b) => a.runAt.getTime() - b.runAt.getTime())
      .slice(0, options.limit)
      .map((row) => {
        row.attempts += 1;
        row.lockedUntil = options.lockUntil;
        row.lockToken = `token-${this.#nextToken++}`;
        return { ...row, lockToken: row.lockToken };
      });
  }

  async renew(scheduledActionId: string, lockToken: string, lockUntil: Date): Promise<boolean> {
    const row = this.rows.find((r) => r.id === scheduledActionId && holdsLock(r, lockToken));
    if (row) row.lockedUntil = lockUntil;

    return row !== undefined;
  }

  async complete(scheduledActionId: string, lockToken: string): Promise<CompleteOutcome> {
    const index = this.rows.findIndex(
      (row) => row.id === scheduledActionId && holdsLock(row, lockToken),
    );
    if (index < 0) return 'lost';

    this.rows.splice(index, 1);
    return 'retired';
  }

  async completeAndSchedule(
    scheduledActionId: string,
    lockToken: string,
    next: Omit<ScheduledActionInput, 'onConflict'>,
  ): Promise<CompleteOutcome> {
    if ((await this.complete(scheduledActionId, lockToken)) === 'lost') return 'lost';

    this.#insert(next);
    return 'retired';
  }

  async cancel(idempotencyKey: string): Promise<{ cancelled: boolean }> {
    const index = this.rows.findIndex((row) => row.idempotencyKey === idempotencyKey);
    if (index < 0) return { cancelled: false };
    this.rows.splice(index, 1);
    return { cancelled: true };
  }

  async release(scheduledActionId: string, lockToken: string): Promise<void> {
    const row = this.rows.find((r) => r.id === scheduledActionId && holdsLock(r, lockToken));
    if (!row) return;

    row.lockedUntil = null;
    row.lockToken = null;
  }

  async markReverted(input: CaseReversalInput): Promise<void> {
    this.reverted.push(input);
  }

  keys(): string[] {
    return this.rows.map((row) => row.idempotencyKey).sort();
  }
}

class RefusingExecutor implements ActionExecutor {
  async execute(_request: ActionRequest): Promise<ActionResult> {
    throw new Error('a scheduled module job must not reach the executor in this test');
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

interface Fired {
  data: unknown;
  guildId: string;
  message: string;
}

interface BuildOptions {
  handler?: ScheduledHandler<RemindersConfig>;
  snapshot?: ModuleConfigSnapshot;
  readConfig?: () => Promise<ModuleConfigSnapshot>;
  declare?: string[];
  maxAttempts?: number;
}

function build(options: BuildOptions = {}) {
  const store = new MemoryStore();
  const logger = new CollectingLogger();
  const registry = new ModuleRegistry();
  const fired: Fired[] = [];

  const inner = options.handler ?? (async () => {});
  const handler: ScheduledHandler<RemindersConfig> = async (data, ctx) => {
    await inner(data, ctx);
    fired.push({ data, guildId: ctx.guildId, message: ctx.config.message });
  };

  const declared = options.declare ?? [JOB_ID];

  const manifest: ModuleManifest<typeof remindersConfigSchema> = {
    id: MODULE_ID,
    name: 'Reminders',
    category: 'utility',
    configSchema: remindersConfigSchema,
    defaultConfig: { enabled: true, message: 'stand up' },
    schemaVersion: 1,
    requiredIntents: [],
    requiredPermissions: [],

    schedules: declared,
    scheduledHandlers: Object.fromEntries(declared.map((id) => [id, handler])),
  };

  registry.register(manifest as ModuleManifest);

  const schedulerFor = createModuleScheduler({ store, registry, logger });

  const sweeper = new ScheduledActionSweeper({
    store,
    cases: store,
    executor: new RefusingExecutor(),
    logger,
    now: () => clock,
    lockMs: 30_000,
    ...(options.maxAttempts === undefined ? {} : { maxAttempts: options.maxAttempts }),

    runModuleJob: createScheduledJobRunner({
      registry,
      config: {
        get: options.readConfig ?? (async () => options.snapshot ?? ENABLED),
      },
      executor: new RefusingExecutor(),
      logger,
      schedulerFor,
    }),
  });

  return {
    store,
    logger,
    registry,
    sweeper,
    fired,
    schedulerFor,
    ctx: schedulerFor(MODULE_ID, GUILD),
  };
}

beforeEach(() => {
  clock = new Date(START);
});

const NOTHING = { claimed: 0, reverted: 0, ran: 0, retrying: 0, abandoned: 0, aborted: 0 };

describe('the scheduling port handed to a module', () => {
  test('a module cannot schedule a job id its manifest never declared', async () => {
    const { ctx, store } = build();

    await expect(
      ctx.schedule('end-giveaway', new Date(clock.getTime() + HOUR), NATURAL_KEY),
    ).rejects.toThrow(UndeclaredScheduleError);
    expect(store.rows).toHaveLength(0);
  });

  test('the refusal to schedule names the module, the job id and the manifest field to fix', async () => {
    const { ctx } = build();
    const refused = () => ctx.schedule('end-giveaway', new Date(clock.getTime() + HOUR), 'k');

    await expect(refused()).rejects.toThrow(new RegExp(MODULE_ID));
    await expect(refused()).rejects.toThrow(/end-giveaway/);
    await expect(refused()).rejects.toThrow(/`schedules`/);
  });

  test('a module cannot cancel a job id its manifest never declared either', async () => {
    const { ctx } = build();

    await expect(ctx.cancel('end-giveaway', NATURAL_KEY)).rejects.toThrow(UndeclaredScheduleError);
  });

  test('the row is keyed by module, job, guild and natural key together', async () => {
    const { ctx, store } = build();

    await ctx.schedule(JOB_ID, new Date(clock.getTime() + HOUR), NATURAL_KEY);

    expect(store.keys()).toEqual([moduleScheduleKey(MODULE_ID, JOB_ID, GUILD, NATURAL_KEY)]);
    expect(store.rows[0]?.kind).toBe('module_job');
    expect(store.rows[0]?.payload).toEqual({
      kind: 'module',
      moduleId: MODULE_ID,
      jobId: JOB_ID,
      guildId: GUILD,
      data: undefined,
    });
  });

  test('the same job id and natural key in two servers are two independent rows', async () => {
    const { schedulerFor, store } = build();
    const runAt = new Date(clock.getTime() + HOUR);

    await schedulerFor(MODULE_ID, GUILD).schedule(JOB_ID, runAt, NATURAL_KEY);
    await schedulerFor(MODULE_ID, OTHER_GUILD).schedule(JOB_ID, runAt, NATURAL_KEY);

    expect(store.keys()).toEqual(
      [
        moduleScheduleKey(MODULE_ID, JOB_ID, GUILD, NATURAL_KEY),
        moduleScheduleKey(MODULE_ID, JOB_ID, OTHER_GUILD, NATURAL_KEY),
      ].sort(),
    );
  });

  test('scheduling a key that is already pending keeps the first row and says so', async () => {
    const { ctx, store, logger } = build();
    const runAt = new Date(clock.getTime() + HOUR);

    await ctx.schedule(JOB_ID, runAt, NATURAL_KEY, { text: 'first' });
    const second = await ctx.schedule(JOB_ID, new Date(runAt.getTime() + HOUR), NATURAL_KEY, {
      text: 'second',
    });

    expect(second).toEqual({ scheduled: false, replaced: false });
    expect(store.rows).toHaveLength(1);
    expect(store.rows[0]?.runAt).toEqual(runAt);

    const [ignored] = logger.matching('info', 'had already scheduled');
    expect(ignored?.message).toContain('replace: true');
  });

  test('the caller is told a fresh key was scheduled rather than an existing one moved', async () => {
    const { ctx } = build();

    expect(await ctx.schedule(JOB_ID, new Date(clock.getTime() + HOUR), NATURAL_KEY)).toEqual({
      scheduled: true,
      replaced: false,
    });
  });

  test('a caller asking to replace moves the pending row and is told it moved one', async () => {
    const { ctx, store, logger } = build();
    const moved = new Date(clock.getTime() + 2 * HOUR);

    await ctx.schedule(JOB_ID, new Date(clock.getTime() + HOUR), NATURAL_KEY, { text: 'first' });
    const outcome = await ctx.schedule(
      JOB_ID,
      moved,
      NATURAL_KEY,
      { text: 'second' },
      { replace: true },
    );

    expect(outcome).toEqual({ scheduled: true, replaced: true });
    expect(store.rows).toHaveLength(1);
    expect(store.rows[0]?.runAt).toEqual(moved);
    expect(logger.matching('info', `moved '${JOB_ID}'`)).toHaveLength(1);
  });

  test('replacing a row that failed before hands the new run a whole retry budget', async () => {
    const { ctx, store } = build();

    await ctx.schedule(JOB_ID, new Date(clock.getTime() + HOUR), NATURAL_KEY);
    const [pending] = store.rows;
    if (pending) pending.attempts = 4;

    await ctx.schedule(JOB_ID, new Date(clock.getTime() + 2 * HOUR), NATURAL_KEY, undefined, {
      replace: true,
    });

    expect(store.rows[0]?.attempts).toBe(0);
  });

  test('cancelling a key nothing is pending under reports that, not a cancellation', async () => {
    const { ctx, logger } = build();

    await ctx.cancel(JOB_ID, NATURAL_KEY);

    expect(logger.matching('info', 'which was not pending')).toHaveLength(1);
    expect(logger.matching('info', `${MODULE_ID} cancelled '${JOB_ID}'`)).toHaveLength(1);
  });

  test('cancelling one server’s pending job leaves the other server’s alone', async () => {
    const { schedulerFor, store } = build();
    const runAt = new Date(clock.getTime() + HOUR);

    await schedulerFor(MODULE_ID, GUILD).schedule(JOB_ID, runAt, NATURAL_KEY);
    await schedulerFor(MODULE_ID, OTHER_GUILD).schedule(JOB_ID, runAt, NATURAL_KEY);
    await schedulerFor(MODULE_ID, GUILD).cancel(JOB_ID, NATURAL_KEY);

    expect(store.keys()).toEqual([moduleScheduleKey(MODULE_ID, JOB_ID, OTHER_GUILD, NATURAL_KEY)]);
  });
});

describe('the runner that turns a claimed row back into a module handler', () => {
  test('the handler is given its parsed config, the guild and the data it was scheduled with', async () => {
    const { ctx, sweeper, fired } = build();

    await ctx.schedule(JOB_ID, new Date(clock.getTime() + HOUR), NATURAL_KEY, { text: 'drink' });
    clock = new Date(clock.getTime() + HOUR + 1000);

    expect((await sweeper.sweep()).ran).toBe(1);
    expect(fired).toEqual([{ data: { text: 'drink' }, guildId: GUILD, message: 'stand up' }]);
  });

  test('a row for a module this worker no longer loads is retried and names the stale schedule', async () => {
    const { ctx, store, logger } = build();
    await ctx.schedule(JOB_ID, new Date(clock.getTime() + HOUR), NATURAL_KEY);

    const orphaned = new ScheduledActionSweeper({
      store,
      cases: store,
      executor: new RefusingExecutor(),
      logger,
      now: () => clock,

      runModuleJob: createScheduledJobRunner({
        registry: new ModuleRegistry(),
        config: { get: async () => ENABLED },
        executor: new RefusingExecutor(),
        logger,
      }),
    });

    clock = new Date(clock.getTime() + HOUR + 1000);
    expect((await orphaned.sweep()).retrying).toBe(1);

    const [warned] = logger.matching('warn', 'older build');
    expect(warned?.message).toContain(MODULE_ID);
    expect(store.rows).toHaveLength(1);
  });

  test('a row for a job the manifest no longer handles names the manifest field to fix', async () => {
    const { ctx, store } = build();
    await ctx.schedule(JOB_ID, new Date(clock.getTime() + HOUR), NATURAL_KEY);

    const renamed = build({ declare: ['remind-v2'] });
    for (const row of store.rows) renamed.store.rows.push(row);

    clock = new Date(clock.getTime() + HOUR + 1000);
    expect((await renamed.sweeper.sweep()).retrying).toBe(1);

    const [warned] = renamed.logger.matching('warn', 'scheduledHandlers');
    expect(warned?.message).toContain('Reminders');
    expect(warned?.message).toContain(JOB_ID);
  });

  test('a stale row whose job id is an Object prototype method is refused rather than invoked as that method', async () => {
    const scheduled = build({ declare: ['constructor'] });
    await scheduled.ctx.schedule('constructor', new Date(clock.getTime() + HOUR), NATURAL_KEY);

    const renamed = build({ declare: [JOB_ID] });
    for (const row of scheduled.store.rows) renamed.store.rows.push(row);

    clock = new Date(clock.getTime() + HOUR + 1000);
    expect((await renamed.sweeper.sweep()).retrying).toBe(1);

    expect(renamed.fired).toHaveLength(0);
    const [warned] = renamed.logger.matching('warn', 'scheduledHandlers');
    expect(warned?.message).toContain('constructor');
  });

  test('a module switched off through its own config field drops the job rather than running it', async () => {
    const { ctx, sweeper, fired, store, logger } = build({
      snapshot: { enabled: true, config: { enabled: false, message: 'stand up' } },
    });

    await ctx.schedule(JOB_ID, new Date(clock.getTime() + HOUR), NATURAL_KEY);
    clock = new Date(clock.getTime() + HOUR + 1000);

    expect((await sweeper.sweep()).ran).toBe(1);
    expect(fired).toHaveLength(0);
    expect(logger.matching('warn', 'Reminders is switched off')).toHaveLength(1);
    expect(store.rows).toHaveLength(0);
  });

  test('settings that no longer parse stop the job and name the offending field', async () => {
    const { ctx, sweeper, fired, store, logger } = build({
      snapshot: { enabled: true, config: { enabled: true, message: 42 } },
    });

    await ctx.schedule(JOB_ID, new Date(clock.getTime() + HOUR), NATURAL_KEY);
    clock = new Date(clock.getTime() + HOUR + 1000);

    expect((await sweeper.sweep()).retrying).toBe(1);
    expect(fired).toHaveLength(0);

    const [warned] = logger.matching('warn', 'are not valid');
    expect(warned?.message).toContain('message');
    expect(store.rows).toHaveLength(1);
  });

  test('a config the API will never serve drops the job and points an admin at the dashboard', async () => {
    const { ctx, sweeper, fired, store, logger } = build({
      readConfig: async () => {
        throw new ConfigUnavailableError({
          message: 'the API answered 404',
          permanent: true,
          guildId: GUILD,
          moduleId: MODULE_ID,
          status: 404,
        });
      },
    });

    await ctx.schedule(JOB_ID, new Date(clock.getTime() + HOUR), NATURAL_KEY);
    clock = new Date(clock.getTime() + HOUR + 1000);

    expect((await sweeper.sweep()).ran).toBe(1);
    expect(fired).toHaveLength(0);
    expect(logger.matching('error', 'Proton dashboard')).toHaveLength(1);
    expect(store.rows).toHaveLength(0);
  });

  test('a config the API could not serve right now leaves the row for the next tick', async () => {
    const { ctx, sweeper, store } = build({
      readConfig: async () => {
        throw new ConfigUnavailableError({
          message: 'the API answered 503',
          permanent: false,
          guildId: GUILD,
          moduleId: MODULE_ID,
          status: 503,
        });
      },
    });

    await ctx.schedule(JOB_ID, new Date(clock.getTime() + HOUR), NATURAL_KEY);
    clock = new Date(clock.getTime() + HOUR + 1000);

    expect((await sweeper.sweep()).retrying).toBe(1);
    expect(store.rows).toHaveLength(1);
    expect(store.rows[0]?.attempts).toBe(1);
    expect(store.rows[0]?.lockedUntil).toBeNull();
  });

  test('a sweeper built without a job runner keeps the row instead of dropping the job', async () => {
    const { ctx, store, logger } = build();
    await ctx.schedule(JOB_ID, new Date(clock.getTime() + HOUR), NATURAL_KEY);

    const portless = new ScheduledActionSweeper({
      store,
      cases: store,
      executor: new RefusingExecutor(),
      logger,
      now: () => clock,
    });

    clock = new Date(clock.getTime() + HOUR + 1000);
    expect((await portless.sweep()).retrying).toBe(1);

    const [warned] = logger.matching('warn', 'runModuleJob');
    expect(warned?.message).toContain(`${MODULE_ID}:${JOB_ID}`);
    expect(store.rows).toHaveLength(1);
  });

  test('a job that keeps failing is abandoned with a message an operator can act on', async () => {
    const { ctx, sweeper, store, logger } = build({
      maxAttempts: 2,
      handler: async () => {
        throw new Error('the reminder channel is gone');
      },
    });

    await ctx.schedule(JOB_ID, new Date(clock.getTime() + HOUR), NATURAL_KEY);
    clock = new Date(clock.getTime() + HOUR + 1000);

    expect((await sweeper.sweep()).retrying).toBe(1);
    expect((await sweeper.sweep()).abandoned).toBe(1);
    expect(await sweeper.sweep()).toEqual(NOTHING);

    const [gaveUp] = logger.matching('error', 'by hand');
    expect(gaveUp?.message).toContain('the reminder channel is gone');
    expect(store.rows).toHaveLength(1);
    expect(store.rows[0]?.attempts).toBe(2);
  });
});

describe('a module schedule that renews itself', () => {
  test('a handler rescheduling its own natural key keeps the recurrence alive tick after tick', async () => {
    const runs: number[] = [];
    const { ctx, sweeper, store } = build({
      handler: async (_data, jobCtx) => {
        runs.push(clock.getTime());
        await jobCtx.schedule?.(JOB_ID, new Date(clock.getTime() + HOUR), NATURAL_KEY);
      },
    });

    await ctx.schedule(JOB_ID, new Date(clock.getTime() + HOUR), NATURAL_KEY);
    const first = store.rows[0]?.id;

    for (let tick = 0; tick < 3; tick += 1) {
      clock = new Date(clock.getTime() + HOUR + 1000);
      expect((await sweeper.sweep()).ran).toBe(1);
    }

    expect(runs).toHaveLength(3);
    expect(store.keys()).toEqual([moduleScheduleKey(MODULE_ID, JOB_ID, GUILD, NATURAL_KEY)]);
    expect(store.rows[0]?.attempts).toBe(0);
    // each cycle retires its own row and inserts the next: the same id surviving would mean the
    // run that booked it could still retire it
    expect(store.rows[0]?.id).not.toBe(first ?? '');
    expect(store.rows[0]?.lockToken).toBeNull();
    expect(store.rows[0]?.runAt).toEqual(new Date(clock.getTime() + HOUR));
  });

  test('a renewal replaces the running row rather than colliding with it and stopping', async () => {
    const { ctx, sweeper, store, logger } = build({
      handler: async (_data, jobCtx) => {
        await jobCtx.schedule?.(JOB_ID, new Date(clock.getTime() + HOUR), NATURAL_KEY);
      },
    });

    await ctx.schedule(JOB_ID, new Date(clock.getTime() + HOUR), NATURAL_KEY);
    clock = new Date(clock.getTime() + HOUR + 1000);

    expect((await sweeper.sweep()).ran).toBe(1);

    expect(logger.matching('info', 'had already scheduled')).toHaveLength(0);
    expect(store.rows).toHaveLength(1);
    expect(store.rows[0]?.runAt).toEqual(new Date(clock.getTime() + HOUR));
  });

  test('a cycle that renews and then succeeds hands the next cycle a whole retry budget', async () => {
    let attempt = 0;
    const { ctx, sweeper, store } = build({
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
    expect(store.rows).toHaveLength(1);
    expect(store.rows[0]?.attempts).toBe(0);
  });

  test('renewing under a different natural key retires the row that was running', async () => {
    const { ctx, sweeper, store } = build({
      handler: async (_data, jobCtx) => {
        await jobCtx.schedule?.(JOB_ID, new Date(clock.getTime() + HOUR), 'next-run');
      },
    });

    await ctx.schedule(JOB_ID, new Date(clock.getTime() + HOUR), NATURAL_KEY);
    clock = new Date(clock.getTime() + HOUR + 1000);
    expect((await sweeper.sweep()).ran).toBe(1);

    expect(store.keys()).toEqual([moduleScheduleKey(MODULE_ID, JOB_ID, GUILD, 'next-run')]);
  });

  test('a handler that renews and then throws keeps the renewal and is not retried on top of it', async () => {
    const { ctx, sweeper, store, logger } = build({
      handler: async (_data, jobCtx) => {
        await jobCtx.schedule?.(JOB_ID, new Date(clock.getTime() + HOUR), NATURAL_KEY);
        throw new Error('the reminder channel is gone');
      },
    });

    await ctx.schedule(JOB_ID, new Date(clock.getTime() + HOUR), NATURAL_KEY);
    clock = new Date(clock.getTime() + HOUR + 1000);

    expect((await sweeper.sweep()).aborted).toBe(1);

    const [broken] = logger.matching('error', 'booked its next run and then failed');
    expect(broken?.message).toContain('the reminder channel is gone');

    expect(store.keys()).toEqual([moduleScheduleKey(MODULE_ID, JOB_ID, GUILD, NATURAL_KEY)]);
    expect(store.rows[0]?.attempts).toBe(0);
    expect(store.rows[0]?.runAt.getTime()).toBe(clock.getTime() + HOUR);
  });

  test('a job that renews and then throws every cycle runs once a cycle, not once a sweep', async () => {
    let cycles = 0;
    const { ctx, sweeper, store, logger } = build({
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
    expect(store.rows).toHaveLength(1);
    expect(store.rows[0]?.attempts).toBe(0);
  });
});
