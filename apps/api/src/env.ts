import { createEnv } from '@proton/core/env';
import { DEFAULT_INTENTS } from '@proton/gateway/env';
import { z } from 'zod';

export const envSchema = z.object({
  DATABASE_URL: z.url(),
  PORT: z.coerce.number().int().min(1).max(65535).default(3002),

  API_SHARED_SECRET: z.string().min(16),
  // The same bitfield the gateway identifies with. Read here so the dashboard can say which
  // modules are off for want of an intent, which is a property of the deployment, not the guild.
  GATEWAY_INTENTS: z.coerce.number().int().min(0).default(DEFAULT_INTENTS),
});

export type ApiEnv = z.infer<typeof envSchema>;

export function loadEnv(source?: Record<string, string | undefined>): ApiEnv {
  return createEnv('@proton/api', envSchema, source);
}
