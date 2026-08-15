import {
  DatabaseReversalScheduler,
  DefaultActionExecutor,
  HttpRestProxyClient,
  RedisDedupeStore,
  RedisGuildStateStore,
  RedisStreamsEventBus,
  type ResolveContextHints,
  ReversalSweeper,
  resolvePrecheckContext,
} from '@proton/core';
import { createDb, DrizzleCaseRecorder, DrizzleScheduledActionStore } from '@proton/db';
import { createModuleRegistry } from '@proton/modules';
import Redis from 'ioredis';
import { HttpConfigProvider } from './config-provider.ts';
import { loadEnv } from './env.ts';
import { HttpGuildRegistrar } from './guild-registrar.ts';
import { GuildStateConsumer } from './guild-state-consumer.ts';
import { registerCommands } from './registrar.ts';
import { startReversalJobs } from './reversal-jobs.ts';
import { ModuleRuntime } from './runtime.ts';

const env = loadEnv();

const busRedis = new Redis(env.REDIS_URL, { db: env.REDIS_DB_BUS });
const dedupeRedis = new Redis(env.REDIS_URL, { db: env.REDIS_DB_DEDUPE });
const stateRedis = new Redis(env.REDIS_URL, { db: env.REDIS_DB_STATE });
const handle = createDb(env.DATABASE_URL);

const registry = createModuleRegistry();

const rest = new HttpRestProxyClient(env.REST_PROXY_URL);
const bus = new RedisStreamsEventBus(busRedis);

const guildState = new RedisGuildStateStore(stateRedis);
const schedule = new DrizzleScheduledActionStore(handle);
const reversals = new DatabaseReversalScheduler({ store: schedule, logger: console });

const executor = new DefaultActionExecutor({
  dedupe: new RedisDedupeStore(dedupeRedis),
  rest,
  recorder: new DrizzleCaseRecorder(handle),

  /** Makes `expiresAt` honourable: without this the executor refuses temp actions. */
  scheduleReversal: (request, caseId) => reversals.schedule(request, caseId),

  /**
   * Real guild state, and it fails closed.
   *
   * The Gate 0 version fabricated `guildOwnerId: ''` and
   * `botHighestRolePosition: MAX_SAFE_INTEGER` — values engineered so I8 always
   * passed. That was survivable while `ping` was the only module; it is not
   * survivable next to /ban.
   */
  resolveContext: async (request, hints) => {
    const result = await resolvePrecheckContext(
      {
        store: guildState,
        botUserId: env.DISCORD_APPLICATION_ID,
        fetchMemberRoles: async (guildId, userId) => {
          const response = await rest.request({
            method: 'GET',
            path: `/guilds/${guildId}/members/${userId}`,
          });
          if (response.status >= 400) return null;
          const roles = (response.body as { roles?: unknown })?.roles;
          return Array.isArray(roles)
            ? roles.filter((r): r is string => typeof r === 'string')
            : null;
        },
      },
      request,
      (hints ?? {}) as ResolveContextHints,
    );

    return 'context' in result ? result.context : result;
  },
});

const runtime = new ModuleRuntime({
  bus,
  registry,
  executor,
  config: new HttpConfigProvider(env.API_URL, env.API_SHARED_SECRET),
  logger: console,
});

const registered = await registerCommands(rest, registry, {
  applicationId: env.DISCORD_APPLICATION_ID,
  scope: env.COMMAND_REGISTRATION_SCOPE,
  testGuildId: env.DISCORD_TEST_GUILD_ID,
});
console.log(`registered ${registered.count} command(s) at ${registered.path}`);

const stateConsumer = new GuildStateConsumer({
  bus,
  store: guildState,
  registrar: new HttpGuildRegistrar(env.API_URL, env.API_SHARED_SECRET),
  botUserId: env.DISCORD_APPLICATION_ID,
  logger: console,
});

const subscriptions = [stateConsumer.start(), runtime.start()];

const reversalJobs = startReversalJobs({
  // BullMQ owns its own connection (it needs blocking clients and
  // `maxRetriesPerRequest: null`), on the logical DB reserved for jobs.
  connection: { url: env.REDIS_URL, db: env.REDIS_DB_JOBS, maxRetriesPerRequest: null },
  sweeper: new ReversalSweeper({
    store: schedule,
    executor,
    logger: console,
    now: () => new Date(),
  }),
  intervalMs: env.REVERSAL_SWEEP_INTERVAL_MS,
  logger: console,
});

console.log('worker consuming events');

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    void (async () => {
      await Promise.all(subscriptions.map((s) => s.close()));
      await reversalJobs.close();
      busRedis.disconnect();
      dedupeRedis.disconnect();
      stateRedis.disconnect();
      await handle.close();
      process.exit(0);
    })();
  });
}
