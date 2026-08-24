import { HttpImageFetcher } from '@proton/cards';
import {
  BulkMemberContextLoader,
  createUserResolver,
  DatabaseReversalScheduler,
  DefaultActionExecutor,
  HttpRestProxyClient,
  ProviderRegistry,
  RedisCorrelationStore,
  RedisDedupeStore,
  RedisGuildStateStore,
  RedisMessageContentCache,
  RedisRateWindow,
  RedisStreamsEventBus,
  RedisUserProfileCache,
  type ResolveContextHints,
  RestMemberContextLoader,
  RuleEngine,
  resolvePrecheckContext,
  ScheduledActionSweeper,
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
import { DrizzleCaseHistoryStore } from '@proton/module-cases/store';
import {
  DrizzleGiveawayStore,
  RedisDirtyCounts,
  RedisDraftStore,
  RedisEntryBucket,
} from '@proton/module-giveaways';
import { RedisHoneypotLock } from '@proton/module-honeypot';
import { DrizzleStickyRoleStore, RedisPendingGrantStore } from '@proton/module-joinroles';
import { levelForXp, MAX_XP, RedisVoiceSessionStore } from '@proton/module-leveling';
import { DrizzleActivityStore } from '@proton/module-leveling/activity-store';
import { PostgresMessageLogStore, runMessageLogMaintenance } from '@proton/module-logging';
import { RedisBlocklistStore, refreshBlocklist } from '@proton/module-phishing';
import { DrizzlePollStore } from '@proton/module-polls';
import { DrizzleReminderStore } from '@proton/module-reminders';
import {
  SERVERLOG_ACTOR,
  SERVERLOG_MODULE_ID,
  type ServerlogDeps,
  serverlogConfigSchema,
} from '@proton/module-serverlog';
import { DrizzleStarboardStore } from '@proton/module-starboard';
import { DrizzleSuggestionStore } from '@proton/module-suggestions';
import { DrizzleTagStore } from '@proton/module-tags';
import {
  DrizzleTempVoiceRepository,
  RedisCooldownGate,
  RedisPresenceStore,
} from '@proton/module-tempvc';
import { DrizzleTicketStore } from '@proton/module-tickets';
import {
  RedisCaptchaStore,
  RedisPanelStore,
  RedisQuarantineStore,
} from '@proton/module-verification';
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
import { moduleExecutor } from './module-actions.ts';
import {
  assertHandlersCoverJobs,
  createScheduledJobRunner,
  startModuleJobs,
} from './module-jobs.ts';
import { createModulePublisher } from './module-publish.ts';
import { createModuleScheduler } from './module-schedule.ts';
import { registerCommands } from './registrar.ts';
import { RuleCronScheduler, RuleDispatchRuntime, RulePresetSeeder } from './rule-runtime.ts';
import { ModuleRuntime } from './runtime.ts';
import { startScheduledActionJobs } from './scheduled-jobs.ts';
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

const cardImages = {
  images: new HttpImageFetcher({
    onSkip: (reason) => console.warn(`card image skipped: ${reason}`),
  }),
};

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
  cache: messageCache,

  botUserId: env.DISCORD_APPLICATION_ID,

  scheduleFlush: async (request) => {
    await flushJobs?.schedule(request);
  },
};

const dedupe = new RedisDedupeStore(dedupeRedis);

const executor = new DefaultActionExecutor({
  dedupe,
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

// Created before the modules so a module that consumes providers (giveaways) and the modules
// that register them (leveling, cases, core) all share one instance.
const providerRegistry = new ProviderRegistry();

const registry = createModuleRegistry(
  {
    cases: { history: new DrizzleCaseHistoryStore(handle) },
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
      captcha: new RedisCaptchaStore(moduleRedis),
      panel: new RedisPanelStore(moduleRedis),
      applicationId: env.DISCORD_APPLICATION_ID,
      verifyLinkBaseUrl: env.DASHBOARD_URL,
      ...(env.VERIFY_LINK_SECRET ? { verifyLinkSecret: env.VERIFY_LINK_SECRET } : {}),
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
    honeypot: {
      lock: new RedisHoneypotLock(moduleRedis),
      guildState,

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
      activity: new DrizzleActivityStore(handle, { levelForXp }),
      sessions: new RedisVoiceSessionStore(moduleRedis),
      cards: cardImages,
      userProfile: async (userId) => {
        const profile = await users.resolve(userId);
        if (!profile) return null;
        return {
          displayName: profile.globalName ?? profile.username,
          avatarHash: profile.avatarHash,
        };
      },
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
    welcome: { guildState, cards: cardImages },
    tags: { store: new DrizzleTagStore(handle) },
    tickets: {
      store: new DrizzleTicketStore(handle),
      applicationId: env.DISCORD_APPLICATION_ID,

      botUserId: env.DISCORD_APPLICATION_ID,
    },
    tempvc: {
      repository: new DrizzleTempVoiceRepository(handle),
      presence: new RedisPresenceStore(moduleRedis),
      cooldown: new RedisCooldownGate(moduleRedis),
      guildState,
      botUserId: env.DISCORD_APPLICATION_ID,
    },
    reminders: { store: new DrizzleReminderStore(handle) },
    messages: { applicationId: env.DISCORD_APPLICATION_ID },
    counters: { guildState },
    suggestions: {
      store: new DrizzleSuggestionStore(handle),
      applicationId: env.DISCORD_APPLICATION_ID,
    },
    polls: {
      store: new DrizzlePollStore(handle),
      applicationId: env.DISCORD_APPLICATION_ID,
    },
    giveaways: {
      store: new DrizzleGiveawayStore(handle),
      applicationId: env.DISCORD_APPLICATION_ID,
      providers: providerRegistry,
      dirty: new RedisDirtyCounts(moduleRedis),
      bucket: new RedisEntryBucket(moduleRedis),
      drafts: new RedisDraftStore(moduleRedis),
      availability: {
        // The same cached config path every module surface already reads, so the picker never
        // offers a requirement whose owning module is switched off in this guild.
        async isEnabled(guildId, moduleId) {
          try {
            return (await config.get(guildId, moduleId)).enabled;
          } catch {
            return false;
          }
        },
      },
      members: new BulkMemberContextLoader(rest, {
        onUnavailable: (guildId, detail) => {
          console.warn(
            `giveaways could not re-check entrants in ${guildId}, so the draw fell back to what ` +
              `each entrant looked like when they joined: ${detail}`,
            { guildId },
          );
        },
      }),
    },
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
  },
  { providers: providerRegistry },
);

const config = new CachingConfigProvider(
  new HttpConfigProvider(env.API_URL, env.API_SHARED_SECRET),
  { ttlMs: env.CONFIG_CACHE_TTL_MS },
);

const publisherFor = createModulePublisher({ bus, registry, logger: console });
const schedulerFor = createModuleScheduler({ store: schedule, registry, logger: console });

const runtime = new ModuleRuntime({
  bus,
  registry,
  executor,
  config,
  logger: console,
  publisherFor,
  schedulerFor,
  dashboardUrl: env.DASHBOARD_URL,
});
const listeners = new ModuleListenerRuntime({
  bus,
  registry,
  executor,
  config,
  logger: console,
  publisherFor,
  schedulerFor,
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

const memberContext = new RestMemberContextLoader(rest, {
  onUnavailable: (guildId, detail) => {
    console.warn(
      `could not load a member in ${guildId} for a rule condition, so the rule was refused ` +
        `rather than judged on facts it did not have: ${detail}`,
      { guildId },
    );
  },
});

const ruleEngine = new RuleEngine({
  executor,
  rateWindow,
  providers: registry.providers(),
  memberContext,
});

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

const scheduledJobs = startScheduledActionJobs({
  connection: { url: env.REDIS_URL, db: env.REDIS_DB_JOBS, maxRetriesPerRequest: null },
  sweeper: new ScheduledActionSweeper({
    store: schedule,
    cases: schedule,
    executor,
    logger: console,
    now: () => new Date(),

    runModuleJob: createScheduledJobRunner({
      registry,
      config,
      executor,
      logger: console,
      publisherFor,
      schedulerFor,
    }),
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

    return {
      guildId,
      config: parsed.data,
      executor: moduleExecutor(registry, SERVERLOG_MODULE_ID, executor),
      logger: console,
    };
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
          scheduledJobs.close(),
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
