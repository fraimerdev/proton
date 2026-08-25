import { ALL_PERMISSIONS, RedisStreamsEventBus } from '@proton/core';
import { createDb, DrizzleGuildRuleStore } from '@proton/db';
import { DrizzleCaseHistoryStore } from '@proton/module-cases/store';
import { DrizzleGiveawayStore } from '@proton/module-giveaways';
import { levelForXp } from '@proton/module-leveling';
import { DrizzleActivityStore } from '@proton/module-leveling/activity-store';
import { createModuleRegistry } from '@proton/modules';
import Redis from 'ioredis';
import { createApiApp } from './app.ts';
import { CardPreviewService } from './cards/preview.ts';
import { CaseQueryService } from './cases/service.ts';
import { loadEnv } from './env.ts';
import { GuildService } from './guilds/service.ts';
import { LeaderboardService } from './leveling/service.ts';
import { ModuleConfigService } from './modules/service.ts';
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

const busRedis = env.REDIS_URL ? new Redis(env.REDIS_URL, { db: env.REDIS_DB_BUS }) : null;
const bus = busRedis ? new RedisStreamsEventBus(busRedis) : undefined;

if (!bus) {
  console.warn(
    'REDIS_URL is not set for the api, so module config changes will not be published and ' +
      'Server Logs will show nothing under its Proton category. Everything else works.',
  );
}

const app = createApiApp({
  guilds: new GuildService(handle),
  modules: new ModuleConfigService(handle, registry, {
    rules: new DrizzleGuildRuleStore(handle),
    ...(bus ? { bus } : {}),
    logger: console,
    onRecompileFailed: (guildId, moduleId, detail) =>
      console.error(
        `${moduleId}'s config was saved for guild ${guildId} but its rules could not be ` +
          `recompiled, so the old ones are still in force: ${detail}`,
      ),
  }),
  verification: new VerificationService({ ...(bus ? { bus } : {}) }),
  cards: new CardPreviewService(),
  cases: new CaseQueryService(handle),
  leaderboard: new LeaderboardService(handle),
  tags: new TagSearchService(handle),
  tickets: new TicketSearchService(handle),
  registry,
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
      busRedis?.disconnect();
      process.exit(0);
    })();
  });
}
