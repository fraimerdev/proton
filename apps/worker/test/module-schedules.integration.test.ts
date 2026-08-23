import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type {
  ActionExecutor,
  ActionRequest,
  ActionResult,
  Logger,
  ModuleContext,
  ModuleManifest,
  ScheduledHandler,
} from '@proton/core';
import { ModuleRegistry, moduleScheduleKey, ScheduledActionSweeper } from '@proton/core';
import { createDb, type DbHandle, DrizzleScheduledActionStore, runMigrations } from '@proton/db';
import { guilds } from '@proton/db/schema';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { z } from 'zod';
import { createScheduledJobRunner } from '../src/module-jobs.ts';
import { createModuleScheduler } from '../src/module-schedule.ts';
import type { ModuleConfigSnapshot } from '../src/runtime.ts';

let postgres: StartedPostgreSqlContainer;
let handle: DbHandle;

const GUILD = '900000000000000001';
const MODULE_ID = 'reminders';
const JOB_ID = 'remind';
const NATURAL_KEY = 'reminder-42';

const START = new Date('2026-08-17T12:00:00.000Z');
const HOUR = 60 * 60 * 1000;

let clock: Date;

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

class RefusingExecutor implements ActionExecutor {
  async execute(_request: ActionRequest): Promise<ActionResult> {
    throw new Error('a scheduled module job must not reach the executor in this test');
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
  postgres = await new PostgreSqlContainer('postgres:17-alpine').start();
  handle = createDb(postgres.getConnectionUri());
  await runMigrations(handle);
}, 240_000);

afterAll(async () => {
  await handle?.close();
  await postgres?.stop();
}, 240_000);

beforeEach(async () => {
  await handle.client`delete from scheduled_actions`;
  await handle.client`delete from guilds`;
  await handle.db.insert(guilds).values({ id: GUILD, name: 'test guild' });
  clock = new Date(START);
});

function build(
  options: { handler?: ScheduledHandler<RemindersConfig>; snapshot?: ModuleConfigSnapshot } = {},
) {
  const fired: Array<{ data: unknown; ctx: ModuleContext<RemindersConfig> }> = [];
  const logger = new CollectingLogger();
  const store = new DrizzleScheduledActionStore(handle);
  const registry = new ModuleRegistry();

  const handler: ScheduledHandler<RemindersConfig> =
    options.handler ??
    (async (data, ctx) => {
      fired.push({ data, ctx });
    });

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

  const schedulerFor = createModuleScheduler({ store, registry, logger });

  const sweeper = new ScheduledActionSweeper({
    store,
    cases: store,
    executor: new RefusingExecutor(),
    logger,
    now: () => clock,
    lockMs: 30_000,

    runModuleJob: createScheduledJobRunner({
      registry,
      config: { get: async () => options.snapshot ?? ENABLED },
      executor: new RefusingExecutor(),
      logger,
      schedulerFor,
    }),
  });

  return { fired, logger, store, sweeper, ctx: schedulerFor(MODULE_ID, GUILD) };
}

async function pendingRows(): Promise<Array<{ idempotency_key: string; attempts: number }>> {
  return (await handle.client`
    select idempotency_key, attempts from scheduled_actions order by run_at
  `) as Array<{ idempotency_key: string; attempts: number }>;
}

const NOTHING = { claimed: 0, reverted: 0, ran: 0, retrying: 0, abandoned: 0, aborted: 0 };

describe('durable module schedules', () => {
  test('a scheduled job fires exactly once across two sweeper ticks', async () => {
    const { ctx, sweeper, fired } = build();

    await ctx.schedule(JOB_ID, new Date(clock.getTime() + HOUR), NATURAL_KEY, { text: 'drink' });

    expect(await pendingRows()).toHaveLength(1);
    expect(await sweeper.sweep()).toEqual(NOTHING);
    expect(fired).toHaveLength(0);

    clock = new Date(clock.getTime() + HOUR + 1000);

    expect(await sweeper.sweep()).toEqual({
      claimed: 1,
      reverted: 0,
      ran: 1,
      retrying: 0,
      abandoned: 0,
      aborted: 0,
    });
    expect(fired).toHaveLength(1);
    expect(fired[0]?.data).toEqual({ text: 'drink' });
    expect(fired[0]?.ctx.guildId).toBe(GUILD);
    expect(fired[0]?.ctx.config.message).toBe('stand up');

    expect(await sweeper.sweep()).toEqual(NOTHING);
    expect(fired).toHaveLength(1);
    expect(await pendingRows()).toHaveLength(0);
  }, 120_000);

  test('scheduling the same job id and natural key twice leaves one row', async () => {
    const { ctx, sweeper, fired } = build();
    const runAt = new Date(clock.getTime() + HOUR);

    await ctx.schedule(JOB_ID, runAt, NATURAL_KEY, { text: 'first' });
    await ctx.schedule(JOB_ID, new Date(runAt.getTime() + HOUR), NATURAL_KEY, { text: 'second' });

    const rows = await pendingRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.idempotency_key).toBe(moduleScheduleKey(MODULE_ID, JOB_ID, GUILD, NATURAL_KEY));

    clock = new Date(runAt.getTime() + 1000);
    expect((await sweeper.sweep()).ran).toBe(1);

    expect(fired).toHaveLength(1);
    expect(fired[0]?.data).toEqual({ text: 'first' });
  }, 120_000);

  test('cancelling before the run time stops it firing at all', async () => {
    const { ctx, sweeper, fired } = build();

    await ctx.schedule(JOB_ID, new Date(clock.getTime() + HOUR), NATURAL_KEY);
    await ctx.cancel(JOB_ID, NATURAL_KEY);

    expect(await pendingRows()).toHaveLength(0);

    clock = new Date(clock.getTime() + HOUR + 1000);
    expect(await sweeper.sweep()).toEqual(NOTHING);
    expect(fired).toHaveLength(0);
  }, 120_000);

  test('a handler that throws leaves the row claimable by the next tick', async () => {
    let attempts = 0;
    const { ctx, sweeper } = build({
      handler: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('the reminder channel is gone');
      },
    });

    await ctx.schedule(JOB_ID, new Date(clock.getTime() + HOUR), NATURAL_KEY);
    clock = new Date(clock.getTime() + HOUR + 1000);

    expect((await sweeper.sweep()).retrying).toBe(1);

    const retried = await pendingRows();
    expect(retried).toHaveLength(1);
    expect(retried[0]?.attempts).toBe(1);

    expect((await sweeper.sweep()).ran).toBe(1);
    expect(attempts).toBe(2);
    expect(await pendingRows()).toHaveLength(0);
  }, 120_000);

  test('a handler can reschedule itself through the same context port', async () => {
    const { ctx, sweeper, fired } = build({
      handler: async (_data, jobCtx) => {
        await jobCtx.schedule?.(JOB_ID, new Date(clock.getTime() + HOUR), 'next-run');
      },
    });

    await ctx.schedule(JOB_ID, new Date(clock.getTime() + HOUR), NATURAL_KEY);
    clock = new Date(clock.getTime() + HOUR + 1000);
    expect((await sweeper.sweep()).ran).toBe(1);

    const rows = await pendingRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.idempotency_key).toBe(moduleScheduleKey(MODULE_ID, JOB_ID, GUILD, 'next-run'));
    expect(fired).toHaveLength(0);
  }, 120_000);

  test('a job for a module switched off in this server is dropped and names the module', async () => {
    const { ctx, sweeper, fired, logger } = build({
      snapshot: { enabled: false, config: { enabled: true, message: 'stand up' } },
    });

    await ctx.schedule(JOB_ID, new Date(clock.getTime() + HOUR), NATURAL_KEY);
    clock = new Date(clock.getTime() + HOUR + 1000);

    expect((await sweeper.sweep()).ran).toBe(1);
    expect(fired).toHaveLength(0);
    expect(logger.matching('warn', 'Reminders is switched off')).toHaveLength(1);
    expect(await pendingRows()).toHaveLength(0);
  }, 120_000);

  test('a module cannot schedule a job id it never declared', async () => {
    const { ctx } = build();

    await expect(
      ctx.schedule('end-giveaway', new Date(clock.getTime() + HOUR), NATURAL_KEY),
    ).rejects.toThrow(/end-giveaway/);

    expect(await pendingRows()).toHaveLength(0);
  }, 120_000);
});
