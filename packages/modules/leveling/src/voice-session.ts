import { voiceSessionKey as coreVoiceSessionKey } from '@proton/core';

export { type VoiceSession, type VoiceSessionStore, voiceSessionSchema } from '@proton/core';

export const VOICE_SESSION_PREFIX = 'proton:leveling:voice';

export const MAX_PAID_SESSION_MS = 24 * 60 * 60 * 1000;

export function voiceSessionKey(
  guildId: string,
  userId: string,
  prefix: string = VOICE_SESSION_PREFIX,
): string {
  return coreVoiceSessionKey(guildId, userId, prefix);
}
