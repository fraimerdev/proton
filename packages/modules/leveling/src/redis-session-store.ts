import { RedisVoiceSessionStore as CoreRedisVoiceSessionStore } from '@proton/core';
import type { Redis } from 'ioredis';
import { MAX_PAID_SESSION_MS, VOICE_SESSION_PREFIX } from './voice-session.ts';

export const VOICE_SESSION_TTL_MS = MAX_PAID_SESSION_MS;

export interface RedisVoiceSessionStoreOptions {
  keyPrefix?: string;
  ttlMs?: number;
}

export class RedisVoiceSessionStore extends CoreRedisVoiceSessionStore {
  constructor(redis: Redis, options: RedisVoiceSessionStoreOptions = {}) {
    super(redis, {
      keyPrefix: options.keyPrefix ?? VOICE_SESSION_PREFIX,
      ttlMs: options.ttlMs ?? VOICE_SESSION_TTL_MS,
    });
  }
}
