import type { Redis } from 'ioredis';
import {
  MAX_PAID_SESSION_MS,
  VOICE_SESSION_PREFIX,
  type VoiceSession,
  type VoiceSessionStore,
  voiceSessionKey,
  voiceSessionSchema,
} from './voice-session.ts';

export const VOICE_SESSION_TTL_MS = MAX_PAID_SESSION_MS;

export interface RedisVoiceSessionStoreOptions {
  keyPrefix?: string;
  ttlMs?: number;
}

export class RedisVoiceSessionStore implements VoiceSessionStore {
  readonly #redis: Redis;
  readonly #prefix: string;
  readonly #ttlMs: number;

  constructor(redis: Redis, options: RedisVoiceSessionStoreOptions = {}) {
    this.#redis = redis;
    this.#prefix = options.keyPrefix ?? VOICE_SESSION_PREFIX;
    this.#ttlMs = options.ttlMs ?? VOICE_SESSION_TTL_MS;
  }

  async get(guildId: string, userId: string): Promise<VoiceSession | null> {
    return parse(await this.#redis.get(voiceSessionKey(guildId, userId, this.#prefix)));
  }

  async open(session: VoiceSession): Promise<void> {
    await this.#redis.set(
      voiceSessionKey(session.guildId, session.userId, this.#prefix),
      JSON.stringify(session),
      'PX',
      this.#ttlMs,
    );
  }

  async close(guildId: string, userId: string): Promise<VoiceSession | null> {
    return parse(await this.#redis.getdel(voiceSessionKey(guildId, userId, this.#prefix)));
  }
}

function parse(raw: string | null): VoiceSession | null {
  if (raw === null) return null;

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }

  const result = voiceSessionSchema.safeParse(value);
  return result.success ? result.data : null;
}
