import type { AchievementLimits, FencedLocks } from '../src/deps.ts';
import {
  type AchievementVoiceSession,
  type AchievementVoiceStore,
  achievementVoiceSessionSchema,
  type OpenVoiceSession,
  VOICE_TOMBSTONE_TTL_MS,
  type VoiceAdvance,
  voiceSessionExpiry,
} from '../src/voice-store.ts';

interface Expiring<T> {
  value: T;
  expiresAt: number;
}

function key(...parts: readonly string[]): string {
  return JSON.stringify(parts);
}

export class MemoryAchievementVoiceStore implements AchievementVoiceStore {
  readonly #sessions = new Map<string, Expiring<AchievementVoiceSession>>();
  readonly #open = new Map<string, Set<string>>();
  readonly #tombstones = new Map<string, Expiring<number>>();
  readonly #now: () => number;

  constructor(options: { now?: () => number } = {}) {
    this.#now = options.now ?? Date.now;
  }

  #session(guildId: string, userId: string): AchievementVoiceSession | null {
    const sessionKey = key(guildId, userId);
    const stored = this.#sessions.get(sessionKey);
    if (!stored) return null;
    if (stored.expiresAt <= this.#now()) {
      this.#sessions.delete(sessionKey);
      return null;
    }
    return stored.value;
  }

  #tombstone(guildId: string, userId: string): number | null {
    const tombstoneKey = key(guildId, userId);
    const stored = this.#tombstones.get(tombstoneKey);
    if (!stored) return null;
    if (stored.expiresAt <= this.#now()) {
      this.#tombstones.delete(tombstoneKey);
      return null;
    }
    return stored.value;
  }

  async get(guildId: string, userId: string): Promise<AchievementVoiceSession | null> {
    const session = this.#session(guildId, userId);
    return session ? { ...session } : null;
  }

  async list(guildId: string): Promise<OpenVoiceSession[]> {
    const members = this.#open.get(guildId) ?? new Set<string>();
    const open: OpenVoiceSession[] = [];

    for (const userId of [...members].sort()) {
      const session = this.#session(guildId, userId);
      if (session) open.push({ userId, session: { ...session } });
      else members.delete(userId);
    }

    return open;
  }

  async open(guildId: string, userId: string, session: AchievementVoiceSession): Promise<boolean> {
    const parsed = achievementVoiceSessionSchema.parse(session);
    if (this.#session(guildId, userId)) return false;

    const expiresAt = voiceSessionExpiry(parsed);
    if (expiresAt <= this.#now()) return false;

    const closed = this.#tombstone(guildId, userId);
    if (closed !== null && closed >= parsed.lastEventAt) return false;

    this.#sessions.set(key(guildId, userId), { value: { ...parsed }, expiresAt });
    const members = this.#open.get(guildId) ?? new Set<string>();
    members.add(userId);
    this.#open.set(guildId, members);
    return true;
  }

  async advance(
    guildId: string,
    userId: string,
    expectedJoinedAt: number,
    next: VoiceAdvance,
  ): Promise<boolean> {
    const session = this.#session(guildId, userId);
    if (!session || session.joinedAt !== expectedJoinedAt) return false;

    if (next.joinedAt !== undefined) session.joinedAt = next.joinedAt;
    if (next.lastEventAt !== undefined && next.lastEventAt > session.lastEventAt) {
      session.lastEventAt = next.lastEventAt;
    }
    return true;
  }

  async close(
    guildId: string,
    userId: string,
    expectedJoinedAt: number,
    closedAt: number,
  ): Promise<boolean> {
    const session = this.#session(guildId, userId);
    if (!session || session.joinedAt !== expectedJoinedAt) return false;

    this.#sessions.delete(key(guildId, userId));
    this.#open.get(guildId)?.delete(userId);

    const mark = Math.max(
      closedAt,
      session.lastEventAt,
      this.#tombstone(guildId, userId) ?? closedAt,
    );
    this.#tombstones.set(key(guildId, userId), {
      value: mark,
      expiresAt: this.#now() + VOICE_TOMBSTONE_TTL_MS,
    });
    return true;
  }

  async markLeft(guildId: string, userId: string, leftAt: number): Promise<boolean> {
    if (this.#session(guildId, userId)) return false;

    this.#tombstones.set(key(guildId, userId), {
      value: Math.max(leftAt, this.#tombstone(guildId, userId) ?? leftAt),
      expiresAt: this.#now() + VOICE_TOMBSTONE_TTL_MS,
    });
    return true;
  }
}

export class MemoryFencedLocks implements FencedLocks {
  readonly #held = new Map<string, Expiring<string>>();
  readonly #now: () => number;
  #issued = 0;

  constructor(options: { now?: () => number } = {}) {
    this.#now = options.now ?? Date.now;
  }

  async acquire(lockKey: string, ttlMs: number): Promise<string | null> {
    const held = this.#held.get(lockKey);
    if (held && held.expiresAt > this.#now()) return null;

    this.#issued += 1;
    const token = `token-${this.#issued}`;
    this.#held.set(lockKey, { value: token, expiresAt: this.#now() + Math.max(1, ttlMs) });
    return token;
  }

  async release(lockKey: string, token: string): Promise<boolean> {
    const held = this.#held.get(lockKey);
    if (!held || held.expiresAt <= this.#now() || held.value !== token) return false;
    this.#held.delete(lockKey);
    return true;
  }
}

export class MemoryLimits implements AchievementLimits {
  readonly #claims = new Map<string, Expiring<string>>();
  readonly #counts = new Map<string, Expiring<number>>();
  readonly #now: () => number;

  constructor(options: { now?: () => number } = {}) {
    this.#now = options.now ?? Date.now;
  }

  async claim(limitKey: string, value: string, ttlMs: number): Promise<boolean> {
    const held = this.#claims.get(limitKey);
    if (held && held.expiresAt > this.#now()) return held.value === value;

    this.#claims.set(limitKey, { value, expiresAt: this.#now() + Math.max(1, ttlMs) });
    return true;
  }

  async release(limitKey: string, value: string): Promise<boolean> {
    const held = this.#claims.get(limitKey);
    if (!held || held.expiresAt <= this.#now() || held.value !== value) return false;

    this.#claims.delete(limitKey);
    return true;
  }

  async count(limitKey: string, ttlMs: number): Promise<number> {
    const held = this.#counts.get(limitKey);
    if (held && held.expiresAt > this.#now()) {
      held.value += 1;
      return held.value;
    }

    this.#counts.set(limitKey, { value: 1, expiresAt: this.#now() + Math.max(1, ttlMs) });
    return 1;
  }
}
