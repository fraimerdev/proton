import { createEnv } from '@proton/core/env';
import { COMMAND_REGISTRATION_SCOPES } from '@proton/db';
import { DEFAULT_INTENTS } from '@proton/gateway/env';
import { z } from 'zod';
import type { CommandScope } from './commands/service.ts';

const LEGACY_GLOBAL_SCOPE = 'global';

export const envSchema = z.object({
  DATABASE_URL: z.url(),
  PORT: z.coerce.number().int().min(1).max(65535).default(3002),
  // Loopback by default: nothing outside this host may reach the api directly, since holding
  // API_SHARED_SECRET is the only thing standing between a caller and every guild's config.
  HOST: z.string().min(1).default('127.0.0.1'),

  API_SHARED_SECRET: z.string().min(16),

  REST_PROXY_URL: z.string().min(1).default('http://localhost:3001'),

  // Optional: without it the API still boots and serves, it simply publishes no config-change
  // events, so Server Logs shows nothing under Proton. Degradation, not failure.
  REDIS_URL: z.string().min(1).optional(),
  REDIS_DB_BUS: z.coerce.number().int().min(0).max(15).default(0),
  REDIS_DB_MODULES: z.coerce.number().int().min(0).max(15).default(4),
  // The same bitfield the gateway identifies with. Read here so the dashboard can say which
  // modules are off for want of an intent, which is a property of the deployment, not the guild.
  GATEWAY_INTENTS: z.coerce.number().int().min(0).default(DEFAULT_INTENTS),

  DISCORD_TEST_GUILD_ID: z.string().optional(),
  COMMAND_REGISTRATION_SCOPE: z
    .enum([...COMMAND_REGISTRATION_SCOPES, LEGACY_GLOBAL_SCOPE])
    .default('guild'),
});

export type ApiEnv = z.infer<typeof envSchema>;

export function loadEnv(source?: Record<string, string | undefined>): ApiEnv {
  return createEnv('@proton/api', envSchema, source);
}

export function commandScopeOf(
  env: Pick<ApiEnv, 'COMMAND_REGISTRATION_SCOPE' | 'DISCORD_TEST_GUILD_ID'>,
): CommandScope & { legacy: boolean } {
  const configured = env.COMMAND_REGISTRATION_SCOPE;

  return {
    scope: configured === LEGACY_GLOBAL_SCOPE ? 'every-guild' : configured,
    testGuildId: env.DISCORD_TEST_GUILD_ID || null,
    legacy: configured === LEGACY_GLOBAL_SCOPE,
  };
}
