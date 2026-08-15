import { createEnv } from '@proton/core/env';
import { z } from 'zod';

export const envSchema = z.object({
  DISCORD_BOT_TOKEN: z.string().min(1),
  PORT: z.coerce.number().int().min(1).max(65535).default(3001),

  DISCORD_API_URL: z.string().min(1).default('https://discord.com/api'),
});

export type RestProxyEnv = z.infer<typeof envSchema>;

export function loadEnv(source?: Record<string, string | undefined>): RestProxyEnv {
  return createEnv('@proton/rest-proxy', envSchema, source);
}
