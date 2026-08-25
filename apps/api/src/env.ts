import { createEnv } from '@proton/core/env';
import { DEFAULT_INTENTS } from '@proton/gateway/env';
import { z } from 'zod';

export const envSchema = z.object({
  DATABASE_URL: z.url(),
  PORT: z.coerce.number().int().min(1).max(65535).default(3002),
  // Loopback by default: nothing outside this host may reach the api directly, since holding
  // API_SHARED_SECRET is the only thing standing between a caller and every guild's config.
  HOST: z.string().min(1).default('127.0.0.1'),

  API_SHARED_SECRET: z.string().min(16),

  // Optional: without it the API still boots and serves, it simply publishes no config-change
  // events, so Server Logs shows nothing under Proton. Degradation, not failure.
  REDIS_URL: z.string().min(1).optional(),
  REDIS_DB_BUS: z.coerce.number().int().min(0).max(15).default(0),
  // The same bitfield the gateway identifies with. Read here so the dashboard can say which
  // modules are off for want of an intent, which is a property of the deployment, not the guild.
  GATEWAY_INTENTS: z.coerce.number().int().min(0).default(DEFAULT_INTENTS),
});

export type ApiEnv = z.infer<typeof envSchema>;

export function loadEnv(source?: Record<string, string | undefined>): ApiEnv {
  return createEnv('@proton/api', envSchema, source);
}
