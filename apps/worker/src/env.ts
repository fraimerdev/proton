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
  /** BullMQ, which drives the reversal sweep on an interval. */
  REDIS_DB_JOBS: z.coerce.number().int().min(0).max(15).default(3),
  /** Guild role/channel snapshots backing the I8 prechecks. */
  REDIS_DB_STATE: z.coerce.number().int().min(0).max(15).default(5),
  /**
   * Module-owned data: the sliding-window counters `proton:rate:*` that anti-nuke
   * and anti-raid share, anti-nuke's maintenance flag, the phishing blocklist
   * cache, verification's quarantine records and the guild layout backing
   * backups. Their key prefixes are disjoint, so one logical DB is safe.
   *
   * Deliberately not DEDUPE: losing a dedupe key replays an action (I4), so that
   * DB must never be shared with caches anything might reasonably flush. Not BUS
   * either — the streams are the one thing whose loss is unrecoverable.
   */
  REDIS_DB_MODULES: z.coerce.number().int().min(0).max(15).default(4),
  /**
   * How long the worker may reuse a module's config before re-reading it.
   *
   * A listener reads config once per *event*, so this is what stops phishing
   * turning every Discord message into an API round trip. The cost of the cache
   * is staleness: a toggle saved in the dashboard takes up to this long to reach
   * the worker, which at a few seconds nobody notices. Set 0 to disable.
   */
  CONFIG_CACHE_TTL_MS: z.coerce.number().int().min(0).default(5_000),
  /**
   * How often to look for temporary actions that are due to be reversed.
   *
   * This is the worst-case lateness of an unban, so it trades REST chatter
   * against how long past its expiry a temp ban can linger.
   */
  REVERSAL_SWEEP_INTERVAL_MS: z.coerce.number().int().min(1000).default(15_000),
  DATABASE_URL: z.url(),
  REST_PROXY_URL: z.string().min(1).default('http://localhost:3001'),
  API_URL: z.string().min(1).default('http://localhost:3002'),
  API_SHARED_SECRET: z.string().min(16),
});

export type WorkerEnv = z.infer<typeof envSchema>;

export function loadEnv(source?: Record<string, string | undefined>): WorkerEnv {
  return createEnv('@proton/worker', envSchema, source);
}
