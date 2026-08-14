#!/usr/bin/env bun
// Entry point for `bun run db:migrate`.

import { createEnv } from '@proton/core/env';
import { z } from 'zod';
import { createDb } from './client.ts';
import { runMigrations } from './migrator.ts';

const env = createEnv(
  '@proton/db',
  z.object({
    DATABASE_URL: z.url(),
  }),
);

const handle = createDb(env.DATABASE_URL);

try {
  await runMigrations(handle);
  console.log('migrations applied');
} finally {
  await handle.close();
}
