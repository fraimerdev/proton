#!/usr/bin/env bun

import { createEnv } from '@proton/core/env';
import { createDb } from '@proton/db';
import {
  operatorName,
  type PurgeRequest,
  PurgeUsageError,
  parsePurgeArgs,
  runUserPurge,
  userPurgeEnvSchema,
} from './purge.ts';

const USAGE =
  'usage: bun --env-file=.env apps/worker/src/purge-user.ts <discord user id> ' +
  '[--delete --confirm <discord user id>]';

let request: PurgeRequest;
try {
  request = parsePurgeArgs(process.argv.slice(2), { noun: 'user', allowForce: false });
} catch (error) {
  if (!(error instanceof PurgeUsageError)) throw error;

  console.error(`${error.message}\n${USAGE}`);
  process.exit(2);
}

const env = createEnv('purge-user', userPurgeEnvSchema);
const operator = operatorName(env.SUDO_USER);
const handle = createDb(env.DATABASE_URL);

try {
  process.exitCode = await runUserPurge(
    { handle, operator, print: (line) => console.log(line), now: () => new Date() },
    request,
  );
} finally {
  await handle.close();
}
