import { HttpImageFetcher, renderCard } from '@proton/cards';
import {
  ACHIEVEMENT_RETRY_MAILBOX_PREFIX,
  achievementRetryOutcomeSchema,
  BulkMemberContextLoader,
  commandCatalogue,
  createUserResolver,
  DatabaseReversalScheduler,
  DefaultActionExecutor,
  HttpRestProxyClient,
  ProviderRegistry,
  REPORT_ACTION_MAILBOX_PREFIX,
  RedisCorrelationStore,
  RedisDedupeStore,
  RedisGuildStateStore,
  RedisMailbox,
  RedisMessageContentCache,
  RedisRateWindow,
  RedisSimulationResults,
  RedisStreamsEventBus,
  RedisUserProfileCache,
  type ResolveContextHints,
  RestGuildMemberLister,
  RestMemberContextLoader,
  RuleEngine,
  reportActionOutcomeSchema,
  resolvePrecheckContext,
  ScheduledActionSweeper,
} from '@proton/core';
import { createPlaceholderEnvironment } from '@proton/core/placeholder-runtime';
import { createRedisClient } from '@proton/core/redis';
import {
  createDb,
  DrizzleBlockedMemberStore,
  DrizzleBrandingNameStyleStore,
  DrizzleCaseRecorder,
  DrizzleCommandRegistrationStore,
  DrizzleGuildRuleStore,
  DrizzleMemberXpStore,
  DrizzleScheduledActionStore,
} from '@proton/db';
import {
  DrizzleAchievementStore,
  purgeAchievements,
  RedisAchievementVoiceStore,
  RedisFencedLocks,
  RedisLimits,
} from '@proton/module-achievements';
import { DrizzleAfkStore } from '@proton/module-afk';
import { RedisMaintenanceStore } from '@proton/module-antinuke';
import { DrizzleAppealStore } from '@proton/module-appeals';
import { DrizzleApplicationStore, purgeApplications } from '@proton/module-applications';
import { DrizzleBackupStore } from '@proton/module-backup';
import { DrizzleBrandingAssetStore, DrizzleBrandingRoleStore } from '@proton/module-branding/store';
import { DrizzleCaseHistoryStore } from '@proton/module-cases/store';
import { DrizzleCounterChannelStore } from '@proton/module-counters';
import {
  DrizzleGiveawayStore,
  RedisDirtyCounts,
  RedisDraftStore,
  RedisEntryBucket,
} from '@proton/module-giveaways';
import {
  RedisDmChannelStore,
  RedisHoneypotLock,
  RedisHoneypotPendingStore,
  RedisHoneypotStatsStore,
  RedisNoticeStore,
} from '@proton/module-honeypot';
import { DrizzleStickyRoleStore, RedisPendingGrantStore } from '@proton/module-joinroles';
import { RedisJoinRolesRunStore } from '@proton/module-joinroles/sync-store';
import {
  CachedXpEventStore,
  levelForXp,
  MAX_PAID_SESSION_MS,
  MAX_XP,
  RedisVoiceSessionStore,
  VOICE_SESSION_PREFIX,
} from '@proton/module-leveling';
import { DrizzleActivityStore } from '@proton/module-leveling/activity-store';
import { DrizzleXpEventStore } from '@proton/module-leveling/xp-event-store';
import { PostgresMessageLogStore, runMessageLogMaintenance } from '@proton/module-logging';
import {
  DrizzleReportStore,
  RedisDmChannelStore as ModerationDmChannelStore,
  RedisDraftStore as ModerationDraftStore,
  purgeModerationEvidence,
  RedisMessageHistoryBuffer,
  RedisPromptStore,
  RedisReactionGate,
} from '@proton/module-moderation';
import {
  DrizzleCaseLedger,
  DrizzleCaseMessageStore,
  DrizzleTimeoutStore,
} from '@proton/module-moderation/punish-store';
import { RedisRoleRunStore } from '@proton/module-moderation/run-store';
import { RedisBlocklistStore, refreshBlocklist } from '@proton/module-phishing';
import { DrizzlePollStore } from '@proton/module-polls';
import { DrizzleReminderStore } from '@proton/module-reminders';
import {
  RedisScreeningStore,
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
import { DrizzleTicketStore, purgeCapturedMessages } from '@proton/module-tickets';
import {
  RedisCaptchaStore,
  RedisPanelStore,
  RedisQuarantineStore,
} from '@proton/module-verification';
import { createModuleRegistry } from '@proton/modules';
import {
  createAchievementBadges,
  createChannelKind,
  createLevelHolders,
  createMemberFacts,
  createMemberPages,
  effectivelyEnabled,
} from './achievement-ports.ts';
import { PublishingCaseRecorder, publishableCase } from './action-events.ts';
import { readNativeAutomodRules } from './automod-rules.ts';
import { createCommandGate } from './command-gate.ts';
import { CommandLabels } from './command-labels.ts';
import { CommandResolver } from './command-resolver.ts';
import {
  CommandRecordCache,
  CommandSettingsProvider,
  CommandSyncer,
  CommandSyncQueue,
  DRIFT_RECONCILE,
  HttpCommandWorkerViews,
  inRegistrationScope,
} from './command-sync.ts';
import { CommandSyncTriggers, startCommandSyncSweep } from './command-sync-triggers.ts';
import { CachingConfigProvider, HttpConfigProvider } from './config-provider.ts';
import { verifyApplicationEmojis } from './emoji-check.ts';
import { loadEnv } from './env.ts';
import { logHandlerError } from './error-log.ts';
import { GuildLayoutConsumer, RedisGuildLayoutStore } from './guild-layout.ts';
import { HttpGuildRegistrar } from './guild-registrar.ts';
import { GuildStateConsumer } from './guild-state-consumer.ts';
import { ModuleListenerRuntime } from './listener-runtime.ts';
import { createMemberLookup } from './member-lookup.ts';
import { createFetchMemberRoles, createMemberRolesLookup } from './member-roles.ts';
import { MessageCacheConsumer } from './message-cache.ts';
import { createMessageReader } from './message-read.ts';
import { ModerationMessagesConsumer } from './moderation-messages.ts';
import { moduleExecutor } from './module-actions.ts';
import {
  assertHandlersCoverJobs,
  createScheduledJobRunner,
  startModuleJobs,
} from './module-jobs.ts';
import { createModulePublisher } from './module-publish.ts';
import { createModuleScheduler } from './module-schedule.ts';
import { PSEUDO_ACTORS } from './pseudo-actors.ts';
import { RuleCronScheduler, RuleDispatchRuntime, RulePresetSeeder } from './rule-runtime.ts';
import { ModuleRuntime } from './runtime.ts';
import { startScheduledActionJobs } from './scheduled-jobs.ts';
import { type ServerlogFlushJobs, startServerlogFlush } from './serverlog-flush.ts';
import { SimulationConsumer } from './simulation-consumer.ts';
import { createStarboardSource } from './starboard-source.ts';

const env = loadEnv();

const redis = (db: number, label: string) =>
  createRedisClient(env.REDIS_URL, { db, label: `worker/${label}` });

const busRedis = redis(env.REDIS_DB_BUS, 'bus');
const dedupeRedis = redis(env.REDIS_DB_DEDUPE, 'dedupe');
const stateRedis = redis(env.REDIS_DB_STATE, 'guild-state');

const moduleRedis = redis(env.REDIS_DB_MODULES, 'modules');
const userRedis = redis(env.REDIS_DB_USERS, 'users');
const messageRedis = redis(env.REDIS_DB_MESSAGES, 'messages');
const handle = createDb(env.DATABASE_URL);

const rest = new HttpRestProxyClient(env.REST_PROXY_URL);

const bus = new RedisStreamsEventBus(busRedis, {
  onHandlerError: logHandlerError((message, meta) => console.error(message, meta)),
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
const blockedMembers = new DrizzleBlockedMemberStore(handle);
const reversals = new DatabaseReversalScheduler({ store: schedule, logger: console });

const memberRolesOptions = {
  onUnavailable: (guildId: string, userId: string, status: number) => {
    console.error(
      `could not read ${userId}'s roles in ${guildId}: ${status < 500 ? 'Discord' : 'the REST proxy'} ` +
        `answered ${status}. Any action needing their role list has been refused rather than guessed.`,
      { guildId, userId, status },
    );
  },
};

const fetchMemberRoles = createFetchMemberRoles(rest, memberRolesOptions);
const memberRolesLookup = createMemberRolesLookup(rest, memberRolesOptions);

const memberLister = new RestGuildMemberLister(rest);

const rateWindow = new RedisRateWindow(moduleRedis);
const blocklist = new RedisBlocklistStore(moduleRedis);
const messageLogStore = new PostgresMessageLogStore(handle);
const ticketStore = new DrizzleTicketStore(handle);
const tempVoice = new DrizzleTempVoiceRepository(handle);
const memberXp = new DrizzleMemberXpStore(handle, { levelForXp, maxXp: MAX_XP });
const achievementStore = new DrizzleAchievementStore(handle);
const applicationStore = new DrizzleApplicationStore(handle);
const messageCache = new RedisMessageContentCache(messageRedis);

const reportStore = new DrizzleReportStore(handle);
const caseMessages = new DrizzleCaseMessageStore(handle);
const moderationHistory = new RedisMessageHistoryBuffer(moduleRedis);

const correlation = new RedisCorrelationStore(moduleRedis);
const users = createUserResolver({
  cache: new RedisUserProfileCache(userRedis),
  rest,
  pseudoActors: PSEUDO_ACTORS,
  onUnavailable: (userId, status) => {
    console.warn(
      `could not read ${userId}'s profile: the REST proxy answered ${status}. The log that ` +
        'needed it names the executor as Unknown rather than being dropped.',
      { userId, status },
    );
  },
});

const placeholders = createPlaceholderEnvironment({
  applicationId: env.DISCORD_APPLICATION_ID,
  dashboardUrl: env.DASHBOARD_URL,
  users,
  guildState,
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
  screening: new RedisScreeningStore(moduleRedis),
  dashboardUrl: env.DASHBOARD_URL,

  botUserId: env.DISCORD_APPLICATION_ID,

  scheduleFlush: async (request) => {
    await flushJobs?.schedule(request);
  },
};

const dedupe = new RedisDedupeStore(dedupeRedis);

const executor = new DefaultActionExecutor({
  dedupe,
  rest,
  logger: console,
  recorder: new PublishingCaseRecorder({
    inner: new DrizzleCaseRecorder(handle),
    bus,
    logger: console,
    publishFor: publishableCase,
  }),

  scheduleReversal: (request, caseId) => reversals.schedule(request, caseId),

  resolveContext: async (request, hints) => {
    const result = await resolvePrecheckContext(
      {
        store: guildState,
        botUserId: env.DISCORD_APPLICATION_ID,
        fetchMemberRoles: memberRolesLookup,
      },
      request,
      (hints ?? {}) as ResolveContextHints,
    );

    return 'context' in result ? result.context : result;
  },
});

const configApi = new HttpConfigProvider(env.API_URL, env.API_SHARED_SECRET);

const config = new CachingConfigProvider(configApi, { ttlMs: env.CONFIG_CACHE_TTL_MS });

// Created before the modules so giveaways and the modules providing to it share one instance.
const providerRegistry = new ProviderRegistry();

const registry = createModuleRegistry(
  {
    help: { dashboardUrl: env.DASHBOARD_URL },
    cases: { history: new DrizzleCaseHistoryStore(handle) },
    moderation: {
      guildState,
      fetchMemberRoles,
      members: memberLister,
      roleRuns: new RedisRoleRunStore(moduleRedis),
      applicationId: env.DISCORD_APPLICATION_ID,

      lookupMember: createMemberLookup(rest),
      readMessage: createMessageReader(rest),
      commandGate: (guildId, commandName, roleIds) =>
        moderationCommandGate(guildId, commandName, roleIds),
      users,
      placeholders,
      drafts: new ModerationDraftStore(moduleRedis),
      reports: reportStore,
      reactionGate: new RedisReactionGate(moduleRedis),
      prompts: new RedisPromptStore(moduleRedis),
      // The api waits on this key in the bus database, not the modules one.
      mailbox: new RedisMailbox(busRedis, {
        prefix: REPORT_ACTION_MAILBOX_PREFIX,
        schema: reportActionOutcomeSchema,
      }),
      timeouts: new DrizzleTimeoutStore(handle),
      ledger: new DrizzleCaseLedger(handle),
      caseMessages,
      history: moderationHistory,
      dmChannels: new ModerationDmChannelStore(moduleRedis),
      reversals: schedule,

      botUserId: env.DISCORD_APPLICATION_ID,
      dashboardUrl: env.DASHBOARD_URL,
    },
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
      blocked: blockedMembers,
      quarantine: new RedisQuarantineStore(moduleRedis),
      captcha: new RedisCaptchaStore(moduleRedis),
      panel: new RedisPanelStore(moduleRedis),
      applicationId: env.DISCORD_APPLICATION_ID,
      verifyLinkBaseUrl: env.DASHBOARD_URL,
      ...(env.VERIFY_LINK_SECRET ? { verifyLinkSecret: env.VERIFY_LINK_SECRET } : {}),
    },
    appeals: {
      store: new DrizzleAppealStore(handle),
      applicationId: env.DISCORD_APPLICATION_ID,
      blocked: blockedMembers,
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
      notices: new RedisNoticeStore(moduleRedis),
      stats: new RedisHoneypotStatsStore(moduleRedis),
      guildState,
      placeholders,
      blocked: blockedMembers,
      pending: new RedisHoneypotPendingStore(moduleRedis),
      dms: new RedisDmChannelStore(moduleRedis),
      guildName: async (guildId) => (await guildState.get(guildId))?.name ?? 'this server',
      linkBaseUrl: env.DASHBOARD_URL,
      ...(env.VERIFY_LINK_SECRET ? { linkSecret: env.VERIFY_LINK_SECRET } : {}),

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
      xp: memberXp,
      activity: new DrizzleActivityStore(handle, { levelForXp }),
      sessions: new RedisVoiceSessionStore(moduleRedis, {
        keyPrefix: VOICE_SESSION_PREFIX,
        ttlMs: MAX_PAID_SESSION_MS,
      }),
      guildState,
      placeholders,
      xpEvents: new CachedXpEventStore(new DrizzleXpEventStore(handle)),
      applicationId: env.DISCORD_APPLICATION_ID,
      cards: cardImages,
      userProfile: async (userId) => {
        const profile = await users.resolve(userId);
        if (!profile) return null;
        return {
          displayName: profile.globalName ?? profile.username,
          avatarHash: profile.avatarHash,
        };
      },
      badges: createAchievementBadges({ store: achievementStore, config }),
    },
    achievements: {
      store: achievementStore,
      voice: new RedisAchievementVoiceStore(moduleRedis),
      locks: new RedisFencedLocks(moduleRedis),
      limits: new RedisLimits(moduleRedis),
      guildState,
      placeholders,
      applicationId: env.DISCORD_APPLICATION_ID,
      availability: {
        isEnabled: async (guildId, moduleId) =>
          effectivelyEnabled(await config.get(guildId, moduleId)),
      },
      memberFacts: createMemberFacts(rest),
      listMembers: createMemberPages(rest),
      levelOf: async (guildId, userId) => (await memberXp.get(guildId, userId))?.level ?? null,
      levelHolders: createLevelHolders(handle),
      channelKind: createChannelKind({ tickets: ticketStore, temporary: tempVoice }),
      blocked: blockedMembers,
      renderBadge: (card) => renderCard(card, cardImages),
      mailbox: new RedisMailbox(busRedis, {
        prefix: ACHIEVEMENT_RETRY_MAILBOX_PREFIX,
        schema: achievementRetryOutcomeSchema,
      }),

      botUserId: env.DISCORD_APPLICATION_ID,
    },
    joinroles: {
      store: new DrizzleStickyRoleStore(handle),
      pending: new RedisPendingGrantStore(moduleRedis),
      members: memberLister,
      runs: new RedisJoinRolesRunStore(moduleRedis),

      guildState,

      botUserId: env.DISCORD_APPLICATION_ID,
    },
    rolemenu: {
      applicationId: env.DISCORD_APPLICATION_ID,

      botUserId: env.DISCORD_APPLICATION_ID,
    },
    welcome: { guildState, cards: cardImages, placeholders },
    tags: { store: new DrizzleTagStore(handle) },
    tickets: {
      store: ticketStore,
      applicationId: env.DISCORD_APPLICATION_ID,

      guildState,
      placeholders,

      botUserId: env.DISCORD_APPLICATION_ID,
      displayName: async (userId) => {
        const profile = await users.resolve(userId);
        return profile ? (profile.globalName ?? profile.username) : null;
      },
    },
    applications: {
      store: applicationStore,
      applicationId: env.DISCORD_APPLICATION_ID,
      dashboardUrl: env.DASHBOARD_URL,
      providers: providerRegistry,
      availability: {
        isEnabled: async (guildId, moduleId) =>
          effectivelyEnabled(await config.get(guildId, moduleId)),
      },
      guildState,
      placeholders,
      memberRoles: async (guildId, userId) => {
        const roles = await memberRolesLookup(guildId, userId);
        return roles === 'not_member' ? 'absent' : roles;
      },
      lookupMember: createMemberLookup(rest),
    },
    tempvc: {
      repository: tempVoice,
      presence: new RedisPresenceStore(moduleRedis),
      cooldown: new RedisCooldownGate(moduleRedis),
      guildState,
      placeholders,
      botUserId: env.DISCORD_APPLICATION_ID,
    },
    reminders: { store: new DrizzleReminderStore(handle) },
    messages: { applicationId: env.DISCORD_APPLICATION_ID, placeholders, guildState },
    branding: {
      assets: new DrizzleBrandingAssetStore(handle),
      roles: new DrizzleBrandingRoleStore(handle),
      nameStyles: new DrizzleBrandingNameStyleStore(handle),
      rest,
      botUserId: env.DISCORD_APPLICATION_ID,
      applicationId: env.DISCORD_APPLICATION_ID,
    },
    counters: { guildState, channels: new DrizzleCounterChannelStore(handle), placeholders },
    afk: {
      store: new DrizzleAfkStore(handle),
      applicationId: env.DISCORD_APPLICATION_ID,
      guildState,
    },
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
      placeholders,
      availability: {
        // The cached config path, so the picker never offers a requirement whose module is off.
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
            `giveaways could not read the whole member list of ${guildId}, so entrants it did ` +
              'not reach were judged only on what Proton recorded when they entered, a ' +
              'requirement that record could not answer was not held against them, and none of ' +
              `them was disqualified for leaving: ${detail}`,
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

const commandRail = {
  applicationId: env.DISCORD_APPLICATION_ID,
  scope: env.COMMAND_REGISTRATION_SCOPE,
  testGuildId: env.DISCORD_TEST_GUILD_ID,
};
const catalogue = commandCatalogue(registry);
const commandRegistrations = new DrizzleCommandRegistrationStore(handle);
const commandRecords = new CommandRecordCache(commandRegistrations);
// Dispatch reads through a short timeout and a cache; a sync must never read a cached view.
const commandSettings = new CommandSettingsProvider(
  new HttpCommandWorkerViews(env.API_URL, env.API_SHARED_SECRET, { timeoutMs: 1_500 }),
  { ttlMs: env.CONFIG_CACHE_TTL_MS },
);
const commandSyncer = new CommandSyncer({
  rest,
  rail: commandRail,
  catalogue,
  views: new HttpCommandWorkerViews(env.API_URL, env.API_SHARED_SECRET),
  store: commandRegistrations,
  records: commandRecords,
  logger: console,
});
const commandQueue = new CommandSyncQueue({ syncer: commandSyncer, logger: console });
const commandResolver = new CommandResolver({
  catalogue,
  records: commandRecords,
  reconcile: (guildId) => commandQueue.enqueue(guildId, DRIFT_RECONCILE),
  logger: console,
});
const commandLabels = new CommandLabels({
  catalogue,
  records: commandRecords,
  settings: commandSettings,
  inScope: (guildId) => inRegistrationScope(commandRail, guildId),
  logger: console,
});

const moderationCommandGate = createCommandGate({
  registry,
  config,
  logger: console,
  displayName: (guildId, key) => commandResolver.displayName(guildId, key),
});

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
  resolver: commandResolver,
  commandSettings,
  labels: commandLabels,
  refused: dedupe,
});
const listeners = new ModuleListenerRuntime({
  bus,
  registry,
  executor,
  config,
  logger: console,
  publisherFor,
  schedulerFor,
  dashboardUrl: env.DASHBOARD_URL,
  resolver: commandResolver,
  labels: commandLabels,
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
  // Uncached: the seeder re-reads to catch a save made while it rebuilt the rules, and a cache hides it.
  config: configApi,
  cron: ruleCron,
  logger: console,
});

const guildRegistrar = new HttpGuildRegistrar(env.API_URL, env.API_SHARED_SECRET);

const commandTriggers = new CommandSyncTriggers({
  bus,
  rest,
  rail: commandRail,
  queue: commandQueue,
  syncer: commandSyncer,
  records: commandRecords,
  store: commandRegistrations,
  registrar: guildRegistrar,
  settings: commandSettings,
  logger: console,
});

const stateConsumer = new GuildStateConsumer({
  bus,
  store: guildState,
  registrar: guildRegistrar,
  botUserId: env.DISCORD_APPLICATION_ID,
  logger: console,
  removal: { cron: ruleCron, commands: commandTriggers },
  commands: commandTriggers,
});

const layoutConsumer = new GuildLayoutConsumer({ bus, store: layoutStore, logger: console });

// On the bus connection: the api blocks on the same key in the same database.
const simulationConsumer = new SimulationConsumer({
  bus,
  results: new RedisSimulationResults(busRedis),
  registry,
  executor,
  guildState,
  rest,
  placeholders,
  apiUrl: env.API_URL,
  apiSecret: env.API_SHARED_SECRET,
  logger: console,
  labels: commandLabels,
});

const messageCacheConsumer = new MessageCacheConsumer({
  bus,
  cache: messageCache,
  config,
  botUserId: env.DISCORD_APPLICATION_ID,
  logger: console,
});

const moderationMessagesConsumer = new ModerationMessagesConsumer({
  bus,
  config,
  history: moderationHistory,
  reports: reportStore,
  logger: console,
});

const moduleJobHandlers = {
  'phishing:refresh-blocklist': () => refreshBlocklist({ store: blocklist, logger: console }),
  'logging:partition-maintenance': (payload: Record<string, unknown>) =>
    runMessageLogMaintenance(messageLogStore, { ...payload, now: new Date() }),
  'tickets:purge-captured-messages': () => purgeCapturedMessages(ticketStore, new Date()),
  'moderation:purge-evidence': () =>
    purgeModerationEvidence({ reports: reportStore, caseMessages }, new Date()),
  'achievements:purge': () => purgeAchievements(achievementStore, Date.now()),
  'applications:purge': () => purgeApplications(applicationStore, new Date()),
};
assertHandlersCoverJobs(registry, moduleJobHandlers, console);

const subscriptions = [
  stateConsumer.start(),
  layoutConsumer.start(),
  simulationConsumer.start(),
  messageCacheConsumer.start(),
  moderationMessagesConsumer.start(),
  runtime.start(),
  ...listeners.start(),
  ...ruleDispatch.start(),
  rulePresets.start(),
  commandTriggers.start(),
];

void commandTriggers.bootFanOut().catch((error: unknown) => {
  console.error(
    'could not check the servers’ commands at boot — commands registered earlier keep working, ' +
      `but any command added or changed in this build may NOT appear in Discord: ${
        error instanceof Error ? error.message : String(error)
      }`,
  );
});

const commandSweep = startCommandSyncSweep({
  connection: { url: env.REDIS_URL, db: env.REDIS_DB_JOBS, maxRetriesPerRequest: null },
  sweep: () => commandTriggers.sweep(),
  logger: console,
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
      labels: commandLabels,
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
    const [snapshot, commandLabel] = await Promise.all([
      config.get(guildId, SERVERLOG_MODULE_ID),
      commandLabels.forGuild(guildId),
    ]);
    if (!snapshot.enabled) return null;

    const parsed = serverlogConfigSchema.safeParse(snapshot.config);
    if (!parsed.success) return null;

    return {
      guildId,
      config: parsed.data,
      executor: moduleExecutor(registry, SERVERLOG_MODULE_ID, executor),
      logger: console,
      commandLabel,
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

const trimStreams = (): void => {
  bus.trim().catch((error: unknown) => {
    console.error(
      `could not trim the event streams: ${error instanceof Error ? error.message : String(error)}`,
    );
  });
};

trimStreams();
const streamTrim = setInterval(trimStreams, 3_600_000);

console.log('worker consuming events');

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    void (async () => {
      clearInterval(streamTrim);
      try {
        await Promise.allSettled([
          ...subscriptions.map((s) => s.close()),
          scheduledJobs.close(),
          moduleJobs.close(),
          flushJobs?.close() ?? Promise.resolve(),
          ruleCron.close(),
          commandQueue.close(),
          commandSweep.close(),
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
