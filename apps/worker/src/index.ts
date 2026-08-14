import {
  DefaultActionExecutor,
  HttpRestProxyClient,
  Permissions,
  RedisDedupeStore,
  RedisStreamsEventBus,
} from '@proton/core';
import { createDb, DrizzleCaseRecorder } from '@proton/db';
import { createModuleRegistry } from '@proton/modules';
import Redis from 'ioredis';
import { HttpConfigProvider } from './config-provider.ts';
import { loadEnv } from './env.ts';
import { registerCommands } from './registrar.ts';
import { ModuleRuntime } from './runtime.ts';

const env = loadEnv();

const busRedis = new Redis(env.REDIS_URL, { db: env.REDIS_DB_BUS });
const dedupeRedis = new Redis(env.REDIS_URL, { db: env.REDIS_DB_DEDUPE });
const handle = createDb(env.DATABASE_URL);

const registry = createModuleRegistry();

const rest = new HttpRestProxyClient(env.REST_PROXY_URL);
const bus = new RedisStreamsEventBus(busRedis);

const executor = new DefaultActionExecutor({
  dedupe: new RedisDedupeStore(dedupeRedis),
  rest,
  recorder: new DrizzleCaseRecorder(handle),
  // Gate 0 resolves prechecks from the interaction's own `app_permissions`,
  // which Discord now resolves for us (§10.5) — no extra REST round trip.
  resolveContext: async (request) => {
    const payload = request.payload as { appPermissions?: string } | undefined;
    return {
      guildId: request.guildId,
      guildOwnerId: '',
      botUserId: env.DISCORD_APPLICATION_ID,
      botHighestRolePosition: Number.MAX_SAFE_INTEGER,
      botChannelPermissions: payload?.appPermissions
        ? BigInt(payload.appPermissions)
        : Permissions.ViewChannel | Permissions.SendMessages,
      requiredPermissions: Permissions.SendMessages,
    };
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

const subscription = runtime.start();
console.log('worker consuming events');

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    void (async () => {
      await subscription.close();
      busRedis.disconnect();
      dedupeRedis.disconnect();
      await handle.close();
      process.exit(0);
    })();
  });
}
