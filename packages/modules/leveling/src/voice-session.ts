import { snowflakeSchema } from '@proton/core';
import { z } from 'zod';

export const VOICE_SESSION_PREFIX = 'proton:leveling:voice';

export const MAX_PAID_SESSION_MS = 24 * 60 * 60 * 1000;

export function voiceSessionKey(
  guildId: string,
  userId: string,
  prefix: string = VOICE_SESSION_PREFIX,
): string {
  return `${prefix}:${guildId}:${userId}`;
}

export const voiceSessionSchema = z.object({
  guildId: snowflakeSchema,
  userId: snowflakeSchema,
  channelId: snowflakeSchema,

  joinedAt: z.number().int().nonnegative(),
});

export type VoiceSession = z.infer<typeof voiceSessionSchema>;

export interface VoiceSessionStore {
  get(guildId: string, userId: string): Promise<VoiceSession | null>;

  open(session: VoiceSession): Promise<void>;

  close(guildId: string, userId: string): Promise<VoiceSession | null>;
}
