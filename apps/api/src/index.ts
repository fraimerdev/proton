import {
  ACHIEVEMENT_RETRY_MAILBOX_PREFIX,
  type AchievementRetryOutcome,
  ALL_PERMISSIONS,
  achievementRetryOutcomeSchema,
  HttpRestProxyClient,
  REPORT_ACTION_MAILBOX_PREFIX,
  RedisMailbox,
  RedisRateWindow,
  RedisSimulationResults,
  RedisStreamsEventBus,
  type ReportActionOutcome,
  reportActionOutcomeSchema,
} from '@proton/core';
import {
  createDb,
  DrizzleBrandingNameStyleStore,
  DrizzleCommandRegistrationStore,
  DrizzleCommandSettingsStore,
  DrizzleGuildRuleStore,
} from '@proton/db';
import { DrizzleAchievementStore } from '@proton/module-achievements';
import { DrizzleAppealStore } from '@proton/module-appeals';
import { DrizzleApplicationStore } from '@proton/module-applications';
import { dataUri } from '@proton/module-branding/image';
import { DrizzleBrandingAssetStore } from '@proton/module-branding/store';
import { DrizzleCaseHistoryStore } from '@proton/module-cases/store';
import { DrizzleGiveawayStore } from '@proton/module-giveaways';
import { levelForXp } from '@proton/module-leveling';
import { DrizzleActivityStore } from '@proton/module-leveling/activity-store';
import { DrizzleXpEventStore } from '@proton/module-leveling/xp-event-store';
import { createModuleRegistry } from '@proton/modules';
import { AchievementsService } from './achievements/service.ts';
import { createApiApp } from './app.ts';
import { AppealsService } from './appeals/service.ts';
import { ticketInterviews } from './applications/interviews.ts';
import { RestMemberAccess } from './applications/member-access.ts';
import { PortalService } from './applications/portal.ts';
import { ApplicationsService } from './applications/service.ts';
import { auditTrailLookup } from './applications/shared.ts';
import { BrandingAssetService } from './branding/service.ts';
import { CardPreviewService } from './cards/preview.ts';
import { CaseQueryService } from './cases/service.ts';
import { CommandSettingsService } from './commands/service.ts';
import { commandScopeOf, loadEnv } from './env.ts';
import { BotGuildDirectory } from './guilds/directory.ts';
import { GuildService } from './guilds/service.ts';
import { JoinRolesSyncService } from './joinroles/sync.ts';
import { LeaderboardService } from './leveling/service.ts';
import { auditTrailWriter, XpEventService } from './leveling/xp-events.ts';
import { BlockedMemberService } from './moderation/blocked-members.ts';
import { ReportsService } from './moderation/reports.ts';
import { ModuleConfigService } from './modules/service.ts';
import { createApiRedis, disconnectApiRedis } from './redis.ts';
import { SimulationService } from './simulations/service.ts';
import { TagSearchService } from './tags/service.ts';
import { TicketSearchService } from './tickets/service.ts';
import { VerificationService } from './verification/service.ts';

const env = loadEnv();

const handle = createDb(env.DATABASE_URL);

// Bound with the same provider stores the worker uses: the dashboard's requirement picker reads
// this registry, and an unbound module registers no providers at all.
const registry = createModuleRegistry({
  cases: { history: new DrizzleCaseHistoryStore(handle) },
  leveling: { activity: new DrizzleActivityStore(handle, { levelForXp }) },
  giveaways: { store: new DrizzleGiveawayStore(handle) },
});

const redis = createApiRedis(env);
const busRedis = redis?.bus ?? null;
const bus = busRedis ? new RedisStreamsEventBus(busRedis) : undefined;

if (!bus) {
  console.warn(
    'REDIS_URL is not set for the api, so module config changes will not be published and ' +
      'Server logs will show nothing under its Proton category. Everything else works.',
  );
}

const memberAccess = new RestMemberAccess(new HttpRestProxyClient(env.REST_PROXY_URL));

const modules = new ModuleConfigService(handle, registry, {
  rules: new DrizzleGuildRuleStore(handle),
  memberAccess,
  ...(bus ? { bus } : {}),
  logger: console,
  onRecompileFailed: (guildId, moduleId, detail) =>
    console.error(
      `${moduleId}'s config was saved for guild ${guildId} but its rules could not be ` +
        `recompiled, so the old ones are still in force: ${detail}`,
    ),
});

const commandScope = commandScopeOf(env);

if (commandScope.legacy) {
  console.warn(
    'COMMAND_REGISTRATION_SCOPE=global is read as every-guild: Proton now registers its commands ' +
      'in each server instead of globally. Set COMMAND_REGISTRATION_SCOPE=every-guild in .env to ' +
      'stop this warning.',
  );
}

const commands = new CommandSettingsService({
  registry,
  settings: new DrizzleCommandSettingsStore(handle),
  registrations: new DrizzleCommandRegistrationStore(handle),
  modules,
  scope: { scope: commandScope.scope, testGuildId: commandScope.testGuildId },
  ...(bus ? { bus } : {}),
  logger: console,
});

// The mailbox and the rate window share the bus connection and its database, because the worker
// answers on the same one. RedisSimulationResults duplicates it for the blocking read.
const simulations = new SimulationService({
  modules,
  registry,
  db: handle,
  ...(busRedis
    ? {
        results: new RedisSimulationResults(busRedis),
        rateWindow: new RedisRateWindow(busRedis),
      }
    : {}),
  ...(bus ? { bus } : {}),
  logger: console,
});

const maintenance = redis?.maintenance;

const joinrolesSync = new JoinRolesSyncService({
  modules,
  audit: auditTrailWriter(handle),
  ...(redis ? { runs: redis.joinrolesRuns } : {}),
  ...(bus ? { bus } : {}),
  logger: console,
});

const reports = new ReportsService({
  db: handle,
  modules,
  audit: auditTrailWriter(handle),
  ...(busRedis
    ? {
        mailbox: new RedisMailbox<ReportActionOutcome>(busRedis, {
          prefix: REPORT_ACTION_MAILBOX_PREFIX,
          schema: reportActionOutcomeSchema,
        }),
      }
    : {}),
  ...(bus ? { bus } : {}),
  logger: console,
});

const achievementStore = new DrizzleAchievementStore(handle);

const achievements = new AchievementsService({
  db: handle,
  store: achievementStore,
  modules,
  audit: auditTrailWriter(handle),
  ...(busRedis
    ? {
        mailbox: new RedisMailbox<AchievementRetryOutcome>(busRedis, {
          prefix: ACHIEVEMENT_RETRY_MAILBOX_PREFIX,
          schema: achievementRetryOutcomeSchema,
        }),
      }
    : {}),
  ...(bus ? { bus } : {}),
  logger: console,
});

const applicationStore = new DrizzleApplicationStore(handle);
const cases = new CaseQueryService(handle);

const applications = new ApplicationsService({
  store: applicationStore,
  modules,
  members: memberAccess,
  providers: registry.providers(),
  audit: auditTrailWriter(handle),
  audits: auditTrailLookup(handle),
  cases,
  interviews: ticketInterviews(handle),
  ...(bus ? { bus } : {}),
  logger: console,
});

const applicationPortal = new PortalService({
  store: applicationStore,
  modules,
  members: memberAccess,
  providers: registry.providers(),
  ...(bus ? { bus } : {}),
  logger: console,
});

const app = createApiApp({
  guilds: new GuildService(handle, new BotGuildDirectory(env.REST_PROXY_URL)),
  modules,
  commands,
  simulations,
  branding: new BrandingAssetService(new DrizzleBrandingAssetStore(handle), modules),
  brandingNameStyles: new DrizzleBrandingNameStyleStore(handle),
  verification: new VerificationService({ ...(bus ? { bus } : {}) }),
  blocked: new BlockedMemberService(handle),
  reports,
  appeals: new AppealsService({
    modules,
    store: new DrizzleAppealStore(handle),
    ...(bus ? { bus } : {}),
  }),
  achievements,
  applications,
  applicationPortal,
  cards: new CardPreviewService({
    badgeImage: async (guildId, assetId) => {
      const asset = await achievementStore.badge(guildId, assetId);
      return asset ? dataUri(asset.contentType, asset.base64) : null;
    },
  }),
  cases,
  leaderboard: new LeaderboardService(handle),
  xpEvents: new XpEventService({
    store: new DrizzleXpEventStore(handle),
    audit: auditTrailWriter(handle),
    logger: console,
  }),
  tags: new TagSearchService(handle),
  tickets: new TicketSearchService(handle),
  registry,
  ...(maintenance ? { maintenance } : {}),
  joinrolesSync,
  // Intents are reported truthfully; permissions are not. A module's Discord permissions are
  // per-guild and live in the worker's guild-state cache, which this process cannot reach, so
  // passing ALL_PERMISSIONS makes that half of the check a no-op rather than a claim we cannot
  // substantiate. Missing-intent reasons are exact; missing-permission ones still surface at the
  // executor's precheck, naming the permission and the channel.
  environment: () => ({ grantedIntents: env.GATEWAY_INTENTS, botPermissions: ALL_PERMISSIONS }),
  sharedSecret: env.API_SHARED_SECRET,
});

const server = Bun.serve({ port: env.PORT, hostname: env.HOST, fetch: app.fetch });
console.log(`api listening on ${server.hostname}:${server.port}`);

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    void (async () => {
      await server.stop(true);
      await handle.close();
      disconnectApiRedis(redis);
      process.exit(0);
    })();
  });
}
