import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import {
  type GuildStateStore,
  MODULE_JOB_KIND,
  moduleScheduleKey,
  type RuleEngine,
} from '@proton/core';
import {
  createDb,
  type DbHandle,
  DrizzleScheduledActionStore,
  type GuildRuleStore,
  guilds,
  runMigrations,
} from '@proton/db';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { Queue } from 'bullmq';
import { type GuildRegistrar, GuildStateConsumer } from '../src/guild-state-consumer.ts';
import { RULE_CRON_QUEUE, RuleCronScheduler } from '../src/rule-runtime.ts';

const GUILD = '900000000000000001';
const OTHER = '900000000000000002';
const RUN_AT = new Date('2026-10-01T12:00:00.000Z');

const silent = { info: () => {}, warn: () => {}, error: () => {} };

let postgres: StartedPostgreSqlContainer;
let redisContainer: StartedRedisContainer;
let handle: DbHandle;
let store: DrizzleScheduledActionStore;
let cron: RuleCronScheduler;
let queue: Queue;

beforeAll(async () => {
  [postgres, redisContainer] = await Promise.all([
    new PostgreSqlContainer('postgres:17-alpine').start(),
    new RedisContainer('redis:7-alpine').start(),
  ]);

  handle = createDb(postgres.getConnectionUri());
  await runMigrations(handle);
  store = new DrizzleScheduledActionStore(handle);

  const connection = { url: redisContainer.getConnectionUrl(), maxRetriesPerRequest: null };
  cron = new RuleCronScheduler({
    connection,
    engine: {} as RuleEngine,
    store: { listCron: async () => [] } as unknown as GuildRuleStore,
    logger: silent,
  });
  queue = new Queue(RULE_CRON_QUEUE, { connection });
}, 240_000);

afterAll(async () => {
  await queue?.close();
  await cron?.close();
  await handle?.close();
  await Promise.all([postgres?.stop(), redisContainer?.stop()]);
}, 240_000);

async function schedule(guildId: string, naturalKey: string): Promise<void> {
  await store.schedule({
    guildId,
    runAt: RUN_AT,
    kind: MODULE_JOB_KIND,
    idempotencyKey: moduleScheduleKey('reminders', 'deliver', guildId, naturalKey),
    payload: { kind: 'module', moduleId: 'reminders', jobId: 'deliver', guildId, data: {} },
  });
}

async function cronRule(guildId: string, ruleId: string): Promise<void> {
  const id = `${guildId}:automod:${ruleId}`;
  await queue.upsertJobScheduler(
    id,
    { pattern: '0 0 1 1 *' },
    { name: id, data: { guildId, moduleId: 'automod', ruleId } },
  );
}

const pending = async (guildId: string) => {
  const [row] = await handle.client<{ n: number }[]>`
    select count(*)::int as n from scheduled_actions where guild_id = ${guildId}`;
  return row?.n ?? 0;
};

const schedulers = async (guildId: string) =>
  (await queue.getJobSchedulers())
    .map((scheduler) => scheduler.key)
    .filter((key) => key.startsWith(`${guildId}:`))
    .sort();

function consumer(confirmed = true): { consumer: GuildStateConsumer; left: string[] } {
  const left: string[] = [];
  const registrar: GuildRegistrar = {
    ensure: async () => {},
    markLeft: async (guildId) => {
      left.push(guildId);
      return confirmed;
    },
  };
  const states: GuildStateStore = {
    get: async () => null,
    put: async () => undefined,
    patch: async () => undefined,
    delete: async () => undefined,
  };

  return {
    consumer: new GuildStateConsumer({
      bus: { publish: async () => {}, subscribe: () => ({ group: 'x', close: async () => {} }) },
      store: states,
      registrar,
      botUserId: '1200000000000000001',
      logger: silent,
      removal: { cron },
    }),
    left,
  };
}

const removal = (unavailable?: true) => ({
  id: `guild.unavailable:${GUILD}:${unavailable ? 'outage' : 'removed'}`,
  type: 'guild.unavailable',
  guildId: GUILD,
  payload: unavailable ? { id: GUILD, unavailable } : { id: GUILD },
});

beforeEach(async () => {
  await handle.client`delete from scheduled_actions`;
  await handle.client`delete from guilds`;
  await handle.db.insert(guilds).values([
    { id: GUILD, name: 'removed server' },
    { id: OTHER, name: 'other server' },
  ]);
  for (const scheduler of await queue.getJobSchedulers()) {
    await queue.removeJobScheduler(scheduler.key);
  }

  await schedule(GUILD, 'reminder-1');
  await schedule(GUILD, 'reminder-2');
  await schedule(OTHER, 'reminder-1');
  await cronRule(GUILD, 'daily');
  await cronRule(GUILD, 'orphaned');
  await cronRule(OTHER, 'daily');
});

describe('a removal Discord confirms', () => {
  test('keeps every pending scheduled action', async () => {
    const { consumer: c, left } = consumer();

    await c.handle(removal());

    expect(left).toEqual([GUILD]);
    expect(await pending(GUILD)).toBe(2);
    expect(await pending(OTHER)).toBe(1);
  });

  test('removes every cron schedule filed under the server and no other server’s', async () => {
    await consumer().consumer.handle(removal());

    expect(await schedulers(GUILD)).toEqual([]);
    expect(await schedulers(OTHER)).toEqual([`${OTHER}:automod:daily`]);
  });

  test('a redelivered removal finds nothing left and does not fail', async () => {
    const { consumer: c } = consumer();

    await c.handle(removal());
    await c.handle(removal());

    expect(await schedulers(GUILD)).toEqual([]);
    expect(await schedulers(OTHER)).toHaveLength(1);
    expect(await pending(GUILD)).toBe(2);
  });
});

test('a removal Discord contradicts is older than a rejoin and keeps everything', async () => {
  const { consumer: c, left } = consumer(false);

  await c.handle(removal());

  expect(left).toEqual([GUILD]);
  expect(await pending(GUILD)).toBe(2);
  expect(await schedulers(GUILD)).toEqual([`${GUILD}:automod:daily`, `${GUILD}:automod:orphaned`]);
});

test('an outage keeps everything: the server is coming back', async () => {
  await consumer().consumer.handle(removal(true));

  expect(await pending(GUILD)).toBe(2);
  expect(await schedulers(GUILD)).toEqual([`${GUILD}:automod:daily`, `${GUILD}:automod:orphaned`]);
});
