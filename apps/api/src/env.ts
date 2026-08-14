import { createEnv } from '@proton/core/env';
import { z } from 'zod';

export const envSchema = z.object({
  DATABASE_URL: z.url(),
  PORT: z.coerce.number().int().min(1).max(65535).default(3002),
  /**
   * Shared secret for service-to-service calls. The dashboard is the only
   * caller; the browser never reaches this service directly (I6).
   */
  API_SHARED_SECRET: z.string().min(16),
});

export type ApiEnv = z.infer<typeof envSchema>;

export function loadEnv(source?: Record<string, string | undefined>): ApiEnv {
  return createEnv('@proton/api', envSchema, source);
}
