import { VERIFY_LINK_SECRET_MIN } from '@proton/core';
import { createEnv, EnvValidationError } from '@proton/core/env';
import { COMMAND_REGISTRATION_SCOPES } from '@proton/db';
import { z } from 'zod';

export const LEGACY_GLOBAL_SCOPE = 'global';

export const LEGACY_SCOPE_WARNING =
  'COMMAND_REGISTRATION_SCOPE=global is read as every-guild: Proton now registers its commands in ' +
  'each server instead of globally. Set COMMAND_REGISTRATION_SCOPE=every-guild in .env to stop ' +
  'this warning.';

export const envSchema = z.object({
  DISCORD_BOT_TOKEN: z.string().min(1),
  DISCORD_APPLICATION_ID: z.string().min(1),

  DISCORD_TEST_GUILD_ID: z.preprocess(
    (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
    z.string().trim().min(1).optional(),
  ),
  COMMAND_REGISTRATION_SCOPE: z
    .enum([...COMMAND_REGISTRATION_SCOPES, LEGACY_GLOBAL_SCOPE])
    .default('guild')
    .transform((scope) => (scope === LEGACY_GLOBAL_SCOPE ? 'every-guild' : scope)),
  REDIS_URL: z.string().min(1),
  REDIS_DB_BUS: z.coerce.number().int().min(0).max(15).default(0),
  REDIS_DB_DEDUPE: z.coerce.number().int().min(0).max(15).default(1),

  REDIS_DB_JOBS: z.coerce.number().int().min(0).max(15).default(3),

  REDIS_DB_STATE: z.coerce.number().int().min(0).max(15).default(5),

  REDIS_DB_MODULES: z.coerce.number().int().min(0).max(15).default(4),

  REDIS_DB_USERS: z.coerce.number().int().min(0).max(15).default(6),

  // The one dataset where allkeys-lru eviction is acceptable, unlike the rate windows and voice
  // sessions sharing REDIS_DB_MODULES.
  REDIS_DB_MESSAGES: z.coerce.number().int().min(0).max(15).default(7),

  // Application emoji, not guild emoji: a guild emoji id renders as broken text in every other
  // server. Left unset, logs fall back to plain box-drawing characters.
  PROTON_EMOJI_STEM: z
    .string()
    .regex(/^\d{17,20}$/)
    .optional(),
  PROTON_EMOJI_REPLY: z
    .string()
    .regex(/^\d{17,20}$/)
    .optional(),

  CONFIG_CACHE_TTL_MS: z.coerce.number().int().min(0).default(5_000),

  REVERSAL_SWEEP_INTERVAL_MS: z.coerce.number().int().min(1000).default(15_000),
  DATABASE_URL: z.url(),
  REST_PROXY_URL: z.string().min(1).default('http://localhost:3001'),
  API_URL: z.string().min(1).default('http://localhost:3002'),
  API_SHARED_SECRET: z.string().min(16),
  // Never called, only linked: a refusal that names the settings page is the difference
  // between "the bot did nothing" and a fix the admin can perform.
  DASHBOARD_URL: z.string().min(1).default('http://localhost:3000'),

  // Optional so a deployment that never verifies on the website still boots. Verification names
  // it as the missing port if an admin switches that mode on without it.
  VERIFY_LINK_SECRET: z.string().min(VERIFY_LINK_SECRET_MIN).optional(),
});

export type WorkerEnv = z.infer<typeof envSchema>;

export function registrationRefusal(
  env: Pick<WorkerEnv, 'COMMAND_REGISTRATION_SCOPE' | 'DISCORD_TEST_GUILD_ID'>,
): string | null {
  if (env.COMMAND_REGISTRATION_SCOPE === 'guild' && !env.DISCORD_TEST_GUILD_ID) {
    return (
      'COMMAND_REGISTRATION_SCOPE: guild requires DISCORD_TEST_GUILD_ID. Refusing to fall back to ' +
      'registering commands in every server, which would publish them to every guild the bot is in.'
    );
  }

  if (env.COMMAND_REGISTRATION_SCOPE === 'every-guild' && env.DISCORD_TEST_GUILD_ID) {
    return (
      'COMMAND_REGISTRATION_SCOPE: every-guild registers commands in every server Proton is in, but ' +
      'DISCORD_TEST_GUILD_ID is set, which marks a development environment. Unset ' +
      'DISCORD_TEST_GUILD_ID in production, or set COMMAND_REGISTRATION_SCOPE=guild to register ' +
      'only in the test guild.'
    );
  }

  return null;
}

export function loadEnv(
  source: Record<string, string | undefined> = process.env,
  warn: (message: string) => void = console.warn,
): WorkerEnv {
  const env = createEnv('@proton/worker', envSchema, source);

  const refusal = registrationRefusal(env);
  if (refusal) throw new EnvValidationError('@proton/worker', [refusal]);

  if (source.COMMAND_REGISTRATION_SCOPE === LEGACY_GLOBAL_SCOPE) warn(LEGACY_SCOPE_WARNING);

  return env;
}
