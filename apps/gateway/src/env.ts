import { createEnv } from '@proton/core/env';
import { GatewayIntentBits } from 'discord-api-types/v10';
import { z } from 'zod';

export const DEFAULT_INTENTS =
  GatewayIntentBits.Guilds |
  GatewayIntentBits.GuildMessages |
  GatewayIntentBits.GuildMembers |
  GatewayIntentBits.GuildModeration |
  GatewayIntentBits.MessageContent |
  GatewayIntentBits.GuildMessageReactions |
  GatewayIntentBits.GuildMessagePolls |
  GatewayIntentBits.GuildVoiceStates |
  // Both non-privileged, and both only ever deliver to a bot already holding Manage Server.
  GatewayIntentBits.AutoModerationConfiguration |
  GatewayIntentBits.AutoModerationExecution;

export const envSchema = z.object({
  DISCORD_BOT_TOKEN: z.string().min(1),
  REDIS_URL: z.string().min(1),
  REDIS_DB_SESSIONS: z.coerce.number().int().min(0).max(15).default(2),
  REDIS_DB_BUS: z.coerce.number().int().min(0).max(15).default(0),

  REST_PROXY_URL: z.string().min(1).default('http://localhost:3001'),
  GATEWAY_INTENTS: z.coerce.number().int().min(0).default(DEFAULT_INTENTS),

  GATEWAY_CAPABILITIES: z.coerce.number().int().min(0).default(0),
});

export type GatewayEnv = z.infer<typeof envSchema>;

export function loadEnv(source?: Record<string, string | undefined>): GatewayEnv {
  return createEnv('@proton/gateway', envSchema, source);
}
