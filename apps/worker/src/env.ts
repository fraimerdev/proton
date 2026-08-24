import { VERIFY_LINK_SECRET_MIN } from '@proton/core';
import { createEnv } from '@proton/core/env';
import { z } from 'zod';

export const envSchema = z.object({
  DISCORD_BOT_TOKEN: z.string().min(1),
  DISCORD_APPLICATION_ID: z.string().min(1),

  DISCORD_TEST_GUILD_ID: z.string().optional(),
  COMMAND_REGISTRATION_SCOPE: z.enum(['guild', 'global']).default('guild'),
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

export function loadEnv(source?: Record<string, string | undefined>): WorkerEnv {
  return createEnv('@proton/worker', envSchema, source);
}
