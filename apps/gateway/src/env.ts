import { createEnv } from '@proton/core/env';
import { GatewayIntentBits } from 'discord-api-types/v10';
import { z } from 'zod';

/**
 * Intents the owner enabled: Server Members + Message Content (§14 Q6).
 * Presence is deliberately absent — nothing in Phases 0-4 consumes it and it is
 * expensive in both memory and review scrutiny.
 *
 * GuildModeration is the sole carrier of GUILD_AUDIT_LOG_ENTRY_CREATE, which is
 * the only dispatch that names who deleted a channel or banned a member. Without
 * it every Phase 2 security module receives an empty stream and reports nothing
 * wrong. It is not privileged, so it costs an OR here and no portal toggle.
 */
export const DEFAULT_INTENTS =
  GatewayIntentBits.Guilds |
  GatewayIntentBits.GuildMessages |
  GatewayIntentBits.GuildMembers |
  GatewayIntentBits.GuildModeration |
  GatewayIntentBits.MessageContent |
  /**
   * Phase 3 (§8 engagement). Both verified non-privileged against
   * docs.discord.com/developers/events/gateway — they cost a portal toggle of
   * nothing and no review scrutiny, unlike the two above them.
   *
   * GuildMessageReactions (1<<10) carries MESSAGE_REACTION_ADD/REMOVE, without
   * which reaction roles and starboard receive an empty stream. GuildVoiceStates
   * (1<<7) carries VOICE_STATE_UPDATE, without which voice XP counts zero
   * seconds for every member forever.
   */
  GatewayIntentBits.GuildMessageReactions |
  GatewayIntentBits.GuildVoiceStates;

export const envSchema = z.object({
  DISCORD_BOT_TOKEN: z.string().min(1),
  REDIS_URL: z.string().min(1),
  REDIS_DB_SESSIONS: z.coerce.number().int().min(0).max(15).default(2),
  REDIS_DB_BUS: z.coerce.number().int().min(0).max(15).default(0),
  /** Even the gateway's own GET /gateway/bot goes through the proxy (I2). */
  REST_PROXY_URL: z.string().min(1).default('http://localhost:3001'),
  GATEWAY_INTENTS: z.coerce.number().int().min(0).default(DEFAULT_INTENTS),
  /**
   * Dev-only opt-in to channel obfuscation ahead of its 16 Nov 2026 mandate.
   * Discord documents this bit as temporary and says the mechanism will change
   * before GA, so it stays behind a flag rather than being hard-coded.
   */
  GATEWAY_CAPABILITIES: z.coerce.number().int().min(0).default(0),
});

export type GatewayEnv = z.infer<typeof envSchema>;

export function loadEnv(source?: Record<string, string | undefined>): GatewayEnv {
  return createEnv('@proton/gateway', envSchema, source);
}
