import { createEnv } from '@proton/core/env';
import { z } from 'zod';

export const envSchema = z.object({
  DISCORD_BOT_TOKEN: z.string().min(1),
  DISCORD_APPLICATION_ID: z.string().min(1),
  /** Safety rail: the only guild the bot may act on in development. */
  DISCORD_TEST_GUILD_ID: z.string().optional(),
  COMMAND_REGISTRATION_SCOPE: z.enum(['guild', 'global']).default('guild'),
  REDIS_URL: z.string().min(1),
  REDIS_DB_BUS: z.coerce.number().int().min(0).max(15).default(0),
  REDIS_DB_DEDUPE: z.coerce.number().int().min(0).max(15).default(1),
  /** Guild role/channel snapshots backing the I8 prechecks. */
  REDIS_DB_STATE: z.coerce.number().int().min(0).max(15).default(5),
  DATABASE_URL: z.url(),
  REST_PROXY_URL: z.string().min(1).default('http://localhost:3001'),
  API_URL: z.string().min(1).default('http://localhost:3002'),
  API_SHARED_SECRET: z.string().min(16),
});

export type WorkerEnv = z.infer<typeof envSchema>;

export function loadEnv(source?: Record<string, string | undefined>): WorkerEnv {
  return createEnv('@proton/worker', envSchema, source);
}
