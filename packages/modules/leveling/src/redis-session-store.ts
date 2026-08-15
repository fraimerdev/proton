import type { Redis } from 'ioredis';
import {
  MAX_PAID_SESSION_MS,
  VOICE_SESSION_PREFIX,
  type VoiceSession,
  type VoiceSessionStore,
  voiceSessionKey,
  voiceSessionSchema,
} from './voice-session.ts';

/**
 * How long an open session survives without being closed.
 *
 * Unlike `RedisQuarantineStore`, which deliberately has no TTL, this key must
 * expire. A quarantine ends when a moderator lifts it; a voice session ends when
 * Discord says the member left — and if that dispatch is the one Proton misses,
 * the session would otherwise sit in Redis forever.
 *
 * Taken from `MAX_PAID_SESSION_MS` rather than chosen separately: the payout is
 * clamped to that bound, so a key that outlived it could only ever produce a
 * payout the domain rule was going to cut down anyway, and two numbers would
 * eventually be edited one at a time.
 */
export const VOICE_SESSION_TTL_MS = MAX_PAID_SESSION_MS;

export interface RedisVoiceSessionStoreOptions {
  keyPrefix?: string;
  ttlMs?: number;
}

/**
 * Open voice sessions in Redis, one key per `(guild, member)`.
 *
 * Every worker replica sees the same session, so a member who joins while one
 * replica is handling the guild and leaves while another is does not lose their
 * time — which an in-process map would guarantee, silently, on every deploy.
 */
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

  /**
   * `GETDEL` — one command, so the read and the delete cannot be interleaved.
   *
   * This is where "pay exactly once" is enforced. Two workers handling the same
   * redelivered disconnect both issue it; Redis hands the value to one of them
   * and the other gets null.
   */
  async close(guildId: string, userId: string): Promise<VoiceSession | null> {
    return parse(await this.#redis.getdel(voiceSessionKey(guildId, userId, this.#prefix)));
  }
}

/**
 * An unreadable session is treated as no session.
 *
 * Deliberately not an error: the alternative to "this member earns nothing for
 * this session" is a throwing listener, which leaves the bus entry unacked and
 * redelivers the same poison event forever. Losing one payout is the cheaper
 * failure by a wide margin.
 */
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
