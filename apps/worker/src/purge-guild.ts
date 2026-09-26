#!/usr/bin/env bun

import { createEnv } from '@proton/core/env';
import { createRedisClient } from '@proton/core/redis';
import { createDb } from '@proton/db';
import { Queue } from 'bullmq';
import {
  guildPurgeEnvSchema,
  operatorName,
  type PurgeRequest,
  PurgeUsageError,
  parsePurgeArgs,
  runGuildPurge,
} from './purge.ts';
import { RULE_CRON_QUEUE } from './rule-runtime.ts';

const USAGE =
  'usage: bun --env-file=.env apps/worker/src/purge-guild.ts <server id> ' +
  '[--delete --confirm <server id>] [--force]';

let request: PurgeRequest;
try {
  request = parsePurgeArgs(process.argv.slice(2), { noun: 'server', allowForce: true });
} catch (error) {
  if (!(error instanceof PurgeUsageError)) throw error;

  console.error(`${error.message}\n${USAGE}`);
  process.exit(2);
}

const env = createEnv('purge-guild', guildPurgeEnvSchema);
const operator = operatorName(env.SUDO_USER);

const handle = createDb(env.DATABASE_URL);
const redis = {
  modules: createRedisClient(env.REDIS_URL, { db: env.REDIS_DB_MODULES, label: 'purge/modules' }),
  state: createRedisClient(env.REDIS_URL, { db: env.REDIS_DB_STATE, label: 'purge/state' }),
  messages: createRedisClient(env.REDIS_URL, {
    db: env.REDIS_DB_MESSAGES,
    label: 'purge/messages',
  }),
};
const cron = new Queue(RULE_CRON_QUEUE, {
  connection: { url: env.REDIS_URL, db: env.REDIS_DB_JOBS, maxRetriesPerRequest: null },
  skipMetasUpdate: true,
});

try {
  process.exitCode = await runGuildPurge(
    { handle, redis, cron, operator, print: (line) => console.log(line), now: () => new Date() },
    request,
  );
} finally {
  await cron.close();
  for (const client of Object.values(redis)) client.disconnect();
  await handle.close();
}
