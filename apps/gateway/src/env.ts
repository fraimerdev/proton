import { createEnv } from '@proton/core/env';
import {
  ActivityType,
  GatewayIntentBits,
  type GatewayPresenceUpdateData,
  PresenceUpdateStatus,
} from 'discord-api-types/v10';
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

export const STATUS_TEXT = 'prtn.xyz';

export const DEFAULT_PRESENCE: GatewayPresenceUpdateData = {
  since: null,
  afk: false,
  status: PresenceUpdateStatus.Online,
  // A Custom activity renders `state` and never renders `name`; moving the text into `name` shows
  // an empty status.
  activities: [{ name: 'Custom Status', type: ActivityType.Custom, state: STATUS_TEXT }],
};

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
