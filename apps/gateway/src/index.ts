import { createRedisClient, RedisStreamsEventBus } from '@proton/core';
import { DEFAULT_PRESENCE, loadEnv } from './env.ts';
import { createGatewayManager } from './manager.ts';
import { RedisSessionStore } from './session-store.ts';

const env = loadEnv();

const sessionRedis = createRedisClient(env.REDIS_URL, {
  db: env.REDIS_DB_SESSIONS,
  label: 'gateway/sessions',
});
const busRedis = createRedisClient(env.REDIS_URL, { db: env.REDIS_DB_BUS, label: 'gateway/bus' });

const store = new RedisSessionStore(sessionRedis);
const bus = new RedisStreamsEventBus(busRedis);

const manager = createGatewayManager({
  token: env.DISCORD_BOT_TOKEN,
  intents: env.GATEWAY_INTENTS,
  presence: DEFAULT_PRESENCE,
  restProxyUrl: env.REST_PROXY_URL,
  store,
  bus,
});

await manager.connect();
console.log('gateway connected');

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    void (async () => {
      await manager.destroy({ reason: `received ${signal}` });
      sessionRedis.disconnect();
      busRedis.disconnect();
      process.exit(0);
    })();
  });
}
