import { RedisStreamsEventBus } from '@proton/core';
import Redis from 'ioredis';
import { loadEnv } from './env.ts';
import { createGatewayManager } from './manager.ts';
import { RedisSessionStore } from './session-store.ts';

const env = loadEnv();

const sessionRedis = new Redis(env.REDIS_URL, { db: env.REDIS_DB_SESSIONS });
const busRedis = new Redis(env.REDIS_URL, { db: env.REDIS_DB_BUS });

const store = new RedisSessionStore(sessionRedis);
const bus = new RedisStreamsEventBus(busRedis);

const manager = createGatewayManager({
  token: env.DISCORD_BOT_TOKEN,
  intents: env.GATEWAY_INTENTS,
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
