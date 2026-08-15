import {
  DatabaseReversalScheduler,
  DefaultActionExecutor,
  HttpRestProxyClient,
  RedisDedupeStore,
  RedisGuildStateStore,
  RedisRateWindow,
  RedisStreamsEventBus,
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
import { DrizzleStickyRoleStore } from '@proton/module-autorole';
import { DrizzleBackupStore } from '@proton/module-backup';
import { levelForXp, MAX_XP, RedisVoiceSessionStore } from '@proton/module-leveling';
import { PostgresMessageLogStore, runMessageLogMaintenance } from '@proton/module-logging';
import { RedisBlocklistStore, refreshBlocklist } from '@proton/module-phishing';
import { DrizzleStarboardStore } from '@proton/module-starboard';
import { RedisQuarantineStore } from '@proton/module-verification';
import { createModuleRegistry } from '@proton/modules';
import Redis from 'ioredis';
import { CachingConfigProvider, HttpConfigProvider } from './config-provider.ts';
import { loadEnv } from './env.ts';
import { GuildLayoutConsumer, RedisGuildLayoutStore } from './guild-layout.ts';
import { HttpGuildRegistrar } from './guild-registrar.ts';
import { GuildStateConsumer } from './guild-state-consumer.ts';
import { ModuleListenerRuntime } from './listener-runtime.ts';
import { createFetchMemberRoles } from './member-roles.ts';
import { assertHandlersCoverJobs, startModuleJobs } from './module-jobs.ts';
import { createModulePublisher } from './module-publish.ts';
import { registerCommands } from './registrar.ts';
import { startReversalJobs } from './reversal-jobs.ts';
import { RuleCronScheduler, RuleDispatchRuntime, RulePresetSeeder } from './rule-runtime.ts';
import { ModuleRuntime } from './runtime.ts';
import { createStarboardSource } from './starboard-source.ts';

const env = loadEnv();

const busRedis = new Redis(env.REDIS_URL, { db: env.REDIS_DB_BUS });
const dedupeRedis = new Redis(env.REDIS_URL, { db: env.REDIS_DB_DEDUPE });
const stateRedis = new Redis(env.REDIS_URL, { db: env.REDIS_DB_STATE });
/** Module-owned data: rate windows, maintenance flag, blocklist, quarantine, layouts. */
const moduleRedis = new Redis(env.REDIS_URL, { db: env.REDIS_DB_MODULES });
const handle = createDb(env.DATABASE_URL);

const rest = new HttpRestProxyClient(env.REST_PROXY_URL);

/**
 * The bus, now with its diagnostics connected.
 *
 * Every one of these callbacks defaults to undefined, and running without them
 * means a retry, a dead-letter and an unparseable entry are all *completely
 * silent*. Dead-lettering in particular is the bus giving up on an event
 * permanently — exactly the thing nobody can afford to learn about from a user.
 */
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
    // The read loop itself, not a handler. Named by group, because with one
    // group per module "a subscription failed" does not tell an operator which
    // protection is currently off.
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

/** One implementation, shared by the executor's prechecks, anti-nuke and verification. */
const fetchMemberRoles = createFetchMemberRoles(rest, {
  onUnavailable: (guildId, userId, status) => {
    // Callers fail closed on an unreadable member, which for anti-nuke means
    // stripping nothing. Distinguishing "they left" from "Discord said 429" is
    // the difference between a correct no-op and a missed response.
    console.error(
      `could not read ${userId}'s roles in ${guildId}: the REST proxy answered ${status}. Any ` +
        'action needing their role list has been refused rather than guessed.',
      { guildId, userId, status },
    );
  },
});

/** One counter, shared by anti-nuke and anti-raid — see `REDIS_DB_MODULES`. */
const rateWindow = new RedisRateWindow(moduleRedis);
const blocklist = new RedisBlocklistStore(moduleRedis);
const messageLogStore = new PostgresMessageLogStore(handle);

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
      { store: guildState, botUserId: env.DISCORD_APPLICATION_ID, fetchMemberRoles },
      request,
      (hints ?? {}) as ResolveContextHints,
    );

    return 'context' in result ? result.context : result;
  },
});

/**
 * The registry, with every module's runtime ports bound.
 *
 * This is what turns five registered-but-inert Phase 2 manifests into working
 * ones. Built here rather than in `@proton/modules` because these are Redis
 * connections, a database handle and a REST client — things a package imported by
 * the dashboard has no business holding.
 */
const registry = createModuleRegistry({
  antinuke: {
    rateWindow,
    maintenance: new RedisMaintenanceStore(moduleRedis),
    guildState,
    fetchMemberRoles,
    // The breaker's own ban arrives back as an audit event; without this the
    // module would read its own response as an attack and strip its own roles.
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
    // The alert names the domain that matched, so the alert itself contains a
    // blocklisted domain. Without this the module matches its own alert and loops.
    botUserId: env.DISCORD_APPLICATION_ID,
  },
  logging: { store: messageLogStore },

  /**
   * Phase 3 (§8): engagement.
   *
   * `leveling` gets the curve alongside the handle, because the level a member
   * is on is computed inside the same statement that adds their XP — a store
   * that returned raw XP and left the arithmetic to the caller would make
   * "did they level up" a second, racy read.
   */
  leveling: {
    xp: new DrizzleMemberXpStore(handle, { levelForXp, maxXp: MAX_XP }),
    sessions: new RedisVoiceSessionStore(moduleRedis),
  },
  autorole: {
    store: new DrizzleStickyRoleStore(handle),
    // Restoring a role needs to know where it sits relative to the bot, which is
    // the same snapshot the executor's prechecks read.
    guildState,
  },
  rolemenu: {
    applicationId: env.DISCORD_APPLICATION_ID,
    // `/rolemenu` seeds a reaction menu by reacting to its own message, and those
    // reactions arrive back like anyone else's. Without this the module would
    // read seeding a menu as a member picking every option on it.
    botUserId: env.DISCORD_APPLICATION_ID,
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
});

/**
 * One provider, shared by the command and listener paths.
 *
 * The cache is what makes listener dispatch affordable: a listener reads config
 * once per event, and `message.created` fires per Discord message.
 */
const config = new CachingConfigProvider(
  new HttpConfigProvider(env.API_URL, env.API_SHARED_SECRET),
  { ttlMs: env.CONFIG_CACHE_TTL_MS },
);

/**
 * The publish port modules receive (slice 3.A).
 *
 * Bound once and handed to both runtimes, because both need it: `/warn` is a
 * command and a level-up is a listener, and each has to be able to emit the
 * event the other half of the system reacts to. The factory closes over the
 * registry so the `emits` allowlist is checked here rather than trusted.
 */
const publisherFor = createModulePublisher({ bus, registry, logger: console });

const runtime = new ModuleRuntime({
  bus,
  registry,
  executor,
  config,
  logger: console,
  publisherFor,
});
const listeners = new ModuleListenerRuntime({
  bus,
  registry,
  executor,
  config,
  logger: console,
  publisherFor,
});

/**
 * The rule engine, finally holding something (PLAN.md §4-P2).
 *
 * `RuleEngine` needs only an executor and a rate window, both of which already
 * exist above — the engine issues no REST call and holds no Discord client of its
 * own, so wiring it is genuinely this small. What it has never had is a caller.
 *
 * The rate window is the same instance anti-nuke and anti-raid use. That is
 * correct rather than convenient: the keys are `(guildId, moduleId:ruleId,
 * actorId)`, so a rule's counter cannot collide with a module's, and one Redis
 * connection is one fewer than two.
 */
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
  // BullMQ owns its own connection, on the logical DB reserved for jobs.
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

/**
 * The recurring work modules declare — handlers checked before anything starts.
 *
 * Deliberately above the subscriptions. The point of the totality check is to
 * refuse to boot a process that cannot honour what its manifests declare, and a
 * check that runs after consumer groups exist and events are already being
 * dispatched is not a boot check.
 */
const moduleJobHandlers = {
  'phishing:refresh-blocklist': () => refreshBlocklist({ store: blocklist, logger: console }),
  'logging:partition-maintenance': (payload: Record<string, unknown>) =>
    runMessageLogMaintenance(messageLogStore, { ...payload, now: new Date() }),
};
assertHandlersCoverJobs(registry, moduleJobHandlers, console);

const subscriptions = [
  stateConsumer.start(),
  layoutConsumer.start(),
  runtime.start(),
  ...listeners.start(),
  ...ruleDispatch.start(),
  rulePresets.start(),
];

/**
 * Register slash commands, but never at the cost of the listeners.
 *
 * This used to be a top-level `await` above the subscriptions. `fetch` rejects
 * rather than returning a status when the REST proxy is unreachable, so a
 * top-level rejection killed the process before a single subscription started —
 * meaning a proxy that was slow to come up took anti-nuke, anti-raid, phishing
 * and verification down with it. Commands are the one part of the worker that
 * genuinely needs the proxy at boot; everything else needs only Redis. So the
 * subscriptions start first and this is allowed to fail loudly on its own.
 */
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

const moduleJobs = startModuleJobs({
  connection: { url: env.REDIS_URL, db: env.REDIS_DB_JOBS, maxRetriesPerRequest: null },
  registry,
  handlers: moduleJobHandlers,
  logger: console,
});
// "declared", not "scheduled": `upsertJobScheduler` is fire-and-forget, so at
// this point the schedules have been asked for, not confirmed. A registration
// that fails logs its own error rather than being counted here as a success.
console.log(`declared ${moduleJobs.scheduled.length} module job(s)`);

console.log('worker consuming events');

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    void (async () => {
      /**
       * Every step is best-effort, and `finally` owns the exit.
       *
       * Without that, one rejecting `close()` skips `process.exit(0)` entirely
       * and the worker hangs until the orchestrator SIGKILLs it — turning a
       * clean rolling deploy into a 30-second stall per replica, over an error
       * nobody sees.
       */
      try {
        await Promise.allSettled([
          ...subscriptions.map((s) => s.close()),
          reversalJobs.close(),
          moduleJobs.close(),
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
