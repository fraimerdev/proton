import {
  createUserResolver,
  DatabaseReversalScheduler,
  DefaultActionExecutor,
  HttpRestProxyClient,
  RedisCorrelationStore,
  RedisDedupeStore,
  RedisGuildStateStore,
  RedisMessageContentCache,
  RedisRateWindow,
  RedisStreamsEventBus,
  RedisUserProfileCache,
  type ResolveContextHints,
  ReversalSweeper,
  RuleEngine,
  resolvePrecheckContext,
} from '@proton/core';
import {
  createDb,
  DrizzleCaseRecorder,
  DrizzleGuildRuleStore,
  DrizzleMemberXpStore,
  DrizzleScheduledActionStore,
} from '@proton/db';
import { RedisMaintenanceStore } from '@proton/module-antinuke';
import { DrizzleBackupStore } from '@proton/module-backup';
import { DrizzleStickyRoleStore, RedisPendingGrantStore } from '@proton/module-joinroles';
import { levelForXp, MAX_XP, RedisVoiceSessionStore } from '@proton/module-leveling';
import { PostgresMessageLogStore, runMessageLogMaintenance } from '@proton/module-logging';
import { RedisBlocklistStore, refreshBlocklist } from '@proton/module-phishing';
import {
  SERVERLOG_ACTOR,
  SERVERLOG_MODULE_ID,
  type ServerlogDeps,
  serverlogConfigSchema,
} from '@proton/module-serverlog';
import { DrizzleStarboardStore } from '@proton/module-starboard';
import { RedisQuarantineStore } from '@proton/module-verification';
import { createModuleRegistry } from '@proton/modules';
import Redis from 'ioredis';
import { PublishingCaseRecorder, publishableCase } from './action-events.ts';
import { readNativeAutomodRules } from './automod-rules.ts';
import { CachingConfigProvider, HttpConfigProvider } from './config-provider.ts';
import { verifyApplicationEmojis } from './emoji-check.ts';
import { loadEnv } from './env.ts';
import { GuildLayoutConsumer, RedisGuildLayoutStore } from './guild-layout.ts';
import { HttpGuildRegistrar } from './guild-registrar.ts';
import { GuildStateConsumer } from './guild-state-consumer.ts';
import { ModuleListenerRuntime } from './listener-runtime.ts';
import { createFetchMemberRoles } from './member-roles.ts';
import { MessageCacheConsumer } from './message-cache.ts';
import { assertHandlersCoverJobs, startModuleJobs } from './module-jobs.ts';
import { createModulePublisher } from './module-publish.ts';
import { registerCommands } from './registrar.ts';
import { startReversalJobs } from './reversal-jobs.ts';
import { RuleCronScheduler, RuleDispatchRuntime, RulePresetSeeder } from './rule-runtime.ts';
import { ModuleRuntime } from './runtime.ts';
import { type ServerlogFlushJobs, startServerlogFlush } from './serverlog-flush.ts';
import { createStarboardSource } from './starboard-source.ts';

const env = loadEnv();

const busRedis = new Redis(env.REDIS_URL, { db: env.REDIS_DB_BUS });
const dedupeRedis = new Redis(env.REDIS_URL, { db: env.REDIS_DB_DEDUPE });
const stateRedis = new Redis(env.REDIS_URL, { db: env.REDIS_DB_STATE });

const moduleRedis = new Redis(env.REDIS_URL, { db: env.REDIS_DB_MODULES });
const userRedis = new Redis(env.REDIS_URL, { db: env.REDIS_DB_USERS });
const messageRedis = new Redis(env.REDIS_URL, { db: env.REDIS_DB_MESSAGES });
const handle = createDb(env.DATABASE_URL);

const rest = new HttpRestProxyClient(env.REST_PROXY_URL);

const bus = new RedisStreamsEventBus(busRedis, {
  onHandlerError: (event, error, group) => {
    console.error(
      `${group} failed to handle ${event.type}, so it will be redelivered: ${
        error instanceof Error ? error.message : String(error)
      }`,
      {
        group,
        eventId: event.id,
        guildId: event.guildId,
        ...(error instanceof Error && error.stack ? { stack: error.stack } : {}),
      },
    );
  },
  onDeadLetter: (event, deliveries, group) => {
    console.error(
      `${group} is giving up on ${event.type} after ${deliveries} deliveries — it has been ` +
        'moved to the dead-letter stream and will NOT be handled',
      { group, eventId: event.id, guildId: event.guildId },
    );
  },
  onMalformed: (streamKey, id) => {
    console.error('discarded an unreadable stream entry', { streamKey, id });
  },
  onSubscriptionError: (group, error) => {
    console.error(
      `${group} could not read from the bus: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { group },
    );
  },
});

const guildState = new RedisGuildStateStore(stateRedis);
const layoutStore = new RedisGuildLayoutStore(moduleRedis);
const schedule = new DrizzleScheduledActionStore(handle);
const reversals = new DatabaseReversalScheduler({ store: schedule, logger: console });

const fetchMemberRoles = createFetchMemberRoles(rest, {
  onUnavailable: (guildId, userId, status) => {
    console.error(
      `could not read ${userId}'s roles in ${guildId}: the REST proxy answered ${status}. Any ` +
        'action needing their role list has been refused rather than guessed.',
      { guildId, userId, status },
    );
  },
});

const rateWindow = new RedisRateWindow(moduleRedis);
const blocklist = new RedisBlocklistStore(moduleRedis);
const messageLogStore = new PostgresMessageLogStore(handle);
const messageCache = new RedisMessageContentCache(messageRedis);

const correlation = new RedisCorrelationStore(moduleRedis);
const users = createUserResolver({
  cache: new RedisUserProfileCache(userRedis),
  rest,
  pseudoActors: { [SERVERLOG_ACTOR]: { username: 'Proton', avatarUrl: null } },
  onUnavailable: (userId, status) => {
    console.warn(
      `could not read ${userId}'s profile: the REST proxy answered ${status}. The log that ` +
        'needed it names the executor as Unknown rather than being dropped.',
      { userId, status },
    );
  },
});

const logEmojis = await verifyApplicationEmojis(
  rest,
  env.DISCORD_APPLICATION_ID,
  { stemId: env.PROTON_EMOJI_STEM, replyId: env.PROTON_EMOJI_REPLY },
  console,
);

let flushJobs: ServerlogFlushJobs | null = null;

const serverlogDeps: ServerlogDeps = {
  correlation,
  users,
  emojis: logEmojis,
  burst: rateWindow,

  botUserId: env.DISCORD_APPLICATION_ID,

  scheduleFlush: async (request) => {
    await flushJobs?.schedule(request);
  },
};

const executor = new DefaultActionExecutor({
  dedupe: new RedisDedupeStore(dedupeRedis),
  rest,
  recorder: new PublishingCaseRecorder({
    inner: new DrizzleCaseRecorder(handle),
    bus,
    logger: console,
    publishFor: publishableCase,
  }),

  scheduleReversal: (request, caseId) => reversals.schedule(request, caseId),

  resolveContext: async (request, hints) => {
    const result = await resolvePrecheckContext(
      { store: guildState, botUserId: env.DISCORD_APPLICATION_ID, fetchMemberRoles },
      request,
      (hints ?? {}) as ResolveContextHints,
    );

    return 'context' in result ? result.context : result;
  },
});

const registry = createModuleRegistry({
  antinuke: {
    rateWindow,
    maintenance: new RedisMaintenanceStore(moduleRedis),
    guildState,
    fetchMemberRoles,

    botUserId: env.DISCORD_APPLICATION_ID,
  },
  antiraid: { rateWindow },
  verification: {
    guildState,
    fetchMemberRoles,
    quarantine: new RedisQuarantineStore(moduleRedis),
  },
  backup: {
    store: new DrizzleBackupStore(handle, {
      onUnreadable: (backupId, detail) => {
        console.error(
          `backup ${backupId} is stored in a shape Proton can no longer read, so it was left ` +
            `out of the list and cannot be restored from: ${detail}`,
          { backupId },
        );
      },
    }),
    readLayout: (guildId) => layoutStore.get(guildId),
  },
  phishing: {
    blocklist,

    botUserId: env.DISCORD_APPLICATION_ID,
  },
  automod: {
    rateWindow,
    guildState,
    botUserId: env.DISCORD_APPLICATION_ID,
    readNativeRules: (guildId) => readNativeAutomodRules(rest, guildId),
  },
  logging: { store: messageLogStore, cache: messageCache },
  serverlog: serverlogDeps,

  leveling: {
    xp: new DrizzleMemberXpStore(handle, { levelForXp, maxXp: MAX_XP }),
    sessions: new RedisVoiceSessionStore(moduleRedis),
  },
  joinroles: {
    store: new DrizzleStickyRoleStore(handle),
    pending: new RedisPendingGrantStore(moduleRedis),

    guildState,

    botUserId: env.DISCORD_APPLICATION_ID,
  },
  rolemenu: {
    applicationId: env.DISCORD_APPLICATION_ID,

    botUserId: env.DISCORD_APPLICATION_ID,
  },
  welcome: { guildState },
  starboard: {
    store: new DrizzleStarboardStore(handle),
    ...createStarboardSource(rest, {
      onUnavailable: (what, status) => {
        console.error(
          `starboard could not read ${what}: the REST proxy answered ${status}. The board was ` +
            'left as it is rather than being updated from an incomplete read.',
          { status },
        );
      },
    }),
  },
});

const config = new CachingConfigProvider(
  new HttpConfigProvider(env.API_URL, env.API_SHARED_SECRET),
  { ttlMs: env.CONFIG_CACHE_TTL_MS },
);

const publisherFor = createModulePublisher({ bus, registry, logger: console });

const runtime = new ModuleRuntime({
  bus,
  registry,
  executor,
  config,
  logger: console,
  publisherFor,
  dashboardUrl: env.DASHBOARD_URL,
});
const listeners = new ModuleListenerRuntime({
  bus,
  registry,
  executor,
  config,
  logger: console,
  publisherFor,
});

const ruleStore = new DrizzleGuildRuleStore(handle, {
  onInvalidRule: (context, detail) => {
    console.error(
      context.source === 'preset'
        ? `${context.moduleId} ships a preset rule '${context.ruleId}' that is not valid, so it ` +
            `was not written to guild ${context.guildId}: ${detail}`
        : `rule ${context.moduleId}:${context.ruleId} in guild ${context.guildId} is stored in a ` +
            `shape Proton can no longer read, so it was skipped rather than evaluated: ${detail}`,
      { ...context },
    );
  },
});

const ruleEngine = new RuleEngine({ executor, rateWindow });

const ruleCron = new RuleCronScheduler({
  connection: { url: env.REDIS_URL, db: env.REDIS_DB_JOBS, maxRetriesPerRequest: null },
  engine: ruleEngine,
  store: ruleStore,
  logger: console,
});

const ruleDispatch = new RuleDispatchRuntime({
  bus,
  registry,
  engine: ruleEngine,
  store: ruleStore,
  config,
  logger: console,
});

const rulePresets = new RulePresetSeeder({
  bus,
  registry,
  store: ruleStore,
  cron: ruleCron,
  logger: console,
});

const stateConsumer = new GuildStateConsumer({
  bus,
  store: guildState,
  registrar: new HttpGuildRegistrar(env.API_URL, env.API_SHARED_SECRET),
  botUserId: env.DISCORD_APPLICATION_ID,
  logger: console,
});

const layoutConsumer = new GuildLayoutConsumer({ bus, store: layoutStore, logger: console });

const messageCacheConsumer = new MessageCacheConsumer({
  bus,
  cache: messageCache,
  config,
  botUserId: env.DISCORD_APPLICATION_ID,
  logger: console,
});

const moduleJobHandlers = {
  'phishing:refresh-blocklist': () => refreshBlocklist({ store: blocklist, logger: console }),
  'logging:partition-maintenance': (payload: Record<string, unknown>) =>
    runMessageLogMaintenance(messageLogStore, { ...payload, now: new Date() }),
};
assertHandlersCoverJobs(registry, moduleJobHandlers, console);

const subscriptions = [
  stateConsumer.start(),
  layoutConsumer.start(),
  messageCacheConsumer.start(),
  runtime.start(),
  ...listeners.start(),
  ...ruleDispatch.start(),
  rulePresets.start(),
];

void registerCommands(rest, registry, {
  applicationId: env.DISCORD_APPLICATION_ID,
  scope: env.COMMAND_REGISTRATION_SCOPE,
  testGuildId: env.DISCORD_TEST_GUILD_ID,
})
  .then((registered) => {
    console.log(`registered ${registered.count} command(s) at ${registered.path}`);
  })
  .catch((error: unknown) => {
    console.error(
      'could not register slash commands — existing commands keep working, but any command ' +
        `added or changed in this build will NOT appear in Discord: ${
          error instanceof Error ? error.message : String(error)
        }`,
    );
  });

const reversalJobs = startReversalJobs({
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

flushJobs = startServerlogFlush({
  connection: { url: env.REDIS_URL, db: env.REDIS_DB_JOBS, maxRetriesPerRequest: null },
  serverlog: serverlogDeps,
  logger: console,

  contextFor: async (guildId) => {
    const snapshot = await config.get(guildId, SERVERLOG_MODULE_ID);
    if (!snapshot.enabled) return null;

    const parsed = serverlogConfigSchema.safeParse(snapshot.config);
    if (!parsed.success) return null;

    return { guildId, config: parsed.data, executor, logger: console };
  },
});

const moduleJobs = startModuleJobs({
  connection: { url: env.REDIS_URL, db: env.REDIS_DB_JOBS, maxRetriesPerRequest: null },
  registry,
  handlers: moduleJobHandlers,
  logger: console,
});

console.log(`declared ${moduleJobs.scheduled.length} module job(s)`);

console.log('worker consuming events');

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    void (async () => {
      try {
        await Promise.allSettled([
          ...subscriptions.map((s) => s.close()),
          reversalJobs.close(),
          moduleJobs.close(),
          flushJobs?.close() ?? Promise.resolve(),
          ruleCron.close(),
        ]);
        busRedis.disconnect();
        dedupeRedis.disconnect();
        stateRedis.disconnect();
        moduleRedis.disconnect();
        await handle.close();
      } catch (error) {
        console.error(
          `shutdown did not complete cleanly: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      } finally {
        process.exit(0);
      }
    })();
  });
}
