import { moveRateWindows } from '@proton/core';
import { createEnv } from '@proton/core/env';
import { createRedisClient } from '@proton/core/redis';
import { envSchema } from './env.ts';

const env = createEnv(
  '@proton/worker',
  envSchema.pick({ REDIS_URL: true, REDIS_DB_MODULES: true }),
);

const redis = createRedisClient(env.REDIS_URL, {
  db: env.REDIS_DB_MODULES,
  label: 'worker/escalation-windows',
});

try {
  const moved = await moveRateWindows(redis, {
    from: 'cases:escalate-at-',
    to: 'moderation:escalate-at-',
  });

  console.log(`moved ${moved} warn escalation rate window key(s) from cases to moderation`);
} finally {
  await redis.quit();
}
