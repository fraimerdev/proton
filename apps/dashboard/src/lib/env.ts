import { VERIFY_LINK_SECRET_MIN } from '@proton/core';
import { createEnv } from '@proton/core/env';
import { z } from 'zod';

export const envSchema = z.object({
  DATABASE_URL: z.url(),
  DISCORD_CLIENT_ID: z.string().min(1),
  DISCORD_CLIENT_SECRET: z.string().min(1),
  BETTER_AUTH_SECRET: z.string().min(16),
  BETTER_AUTH_URL: z.string().min(1).default('http://localhost:3000'),
  API_URL: z.string().min(1).default('http://localhost:3002'),
  API_SHARED_SECRET: z.string().min(16),
  REST_PROXY_URL: z.string().min(1).default('http://localhost:3001'),

  // Optional so a deployment that never verifies on the website still boots. The verify page says
  // the link is not valid rather than crashing, and names the variable in the server log.
  VERIFY_LINK_SECRET: z.string().min(VERIFY_LINK_SECRET_MIN).optional(),
});

export type DashboardEnv = z.infer<typeof envSchema>;

export function loadEnv(source?: Record<string, string | undefined>): DashboardEnv {
  return createEnv('@proton/dashboard', envSchema, source);
}
