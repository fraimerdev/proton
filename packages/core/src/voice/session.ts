import { z } from 'zod';
import { snowflakeSchema } from '../actions/payloads.ts';

export const MAX_VOICE_STAY_MS = 24 * 60 * 60 * 1000;

export function voiceSessionKey(guildId: string, userId: string, prefix: string): string {
  return `${prefix}:${guildId}:${userId}`;
}

export const voiceSessionSchema = z.object({
  guildId: snowflakeSchema,
  userId: snowflakeSchema,
  channelId: snowflakeSchema,

  joinedAt: z.number().int().nonnegative(),
  startedAt: z.number().int().nonnegative().optional(),

  roleIds: z.array(snowflakeSchema).optional(),
});

export type VoiceSession = z.infer<typeof voiceSessionSchema>;

export interface VoiceSessionStore {
  get(guildId: string, userId: string): Promise<VoiceSession | null>;

  open(session: VoiceSession): Promise<void>;

  close(guildId: string, userId: string): Promise<VoiceSession | null>;
}
