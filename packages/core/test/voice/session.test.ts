import { describe, expect, test } from 'bun:test';
import type { Redis } from 'ioredis';
import { RedisVoiceSessionStore } from '../../src/voice/redis-session-store.ts';
import {
  MAX_VOICE_STAY_MS,
  type VoiceSession,
  voiceSessionKey,
  voiceSessionSchema,
} from '../../src/voice/session.ts';

const GUILD = '900000000000000001';
const USER = '100000000000000010';
const VOICE = '500000000000000009';
const ROLE = '700000000000000001';
const PREFIX = 'proton:leveling:voice';

class FakeRedis {
  readonly values = new Map<string, string>();
  readonly ttls = new Map<string, number>();

  async get(key: string): Promise<string | null> {
    return this.values.get(key) ?? null;
  }

  async set(key: string, value: string, mode: string, ttl: number): Promise<'OK'> {
    this.values.set(key, value);
    if (mode === 'PX') this.ttls.set(key, ttl);
    return 'OK';
  }

  async getdel(key: string): Promise<string | null> {
    const value = this.values.get(key) ?? null;
    this.values.delete(key);
    return value;
  }
}

function build() {
  const redis = new FakeRedis();
  const store = new RedisVoiceSessionStore(redis as unknown as Redis, {
    keyPrefix: PREFIX,
    ttlMs: MAX_VOICE_STAY_MS,
  });
  return { redis, store };
}

const session: VoiceSession = {
  guildId: GUILD,
  userId: USER,
  channelId: VOICE,
  joinedAt: 1_800_000_000_000,
  roleIds: [ROLE],
};

describe('the voice session contract', () => {
  test('one stay is capped at a day', () => {
    expect(MAX_VOICE_STAY_MS).toBe(24 * 60 * 60 * 1000);
  });

  test('keys are the prefix, guild and member, so leveling’s existing keys still resolve', () => {
    expect(voiceSessionKey(GUILD, USER, PREFIX)).toBe(`proton:leveling:voice:${GUILD}:${USER}`);
  });

  test('a session stored before startedAt or roles existed still parses', () => {
    expect(
      voiceSessionSchema.safeParse({ guildId: GUILD, userId: USER, channelId: VOICE, joinedAt: 1 })
        .success,
    ).toBe(true);
  });

  test('a session with a start time parses, and a negative one does not', () => {
    expect(voiceSessionSchema.safeParse({ ...session, startedAt: 1 }).success).toBe(true);
    expect(voiceSessionSchema.safeParse({ ...session, startedAt: -1 }).success).toBe(false);
  });
});

describe('RedisVoiceSessionStore', () => {
  test('opens a session under the prefix it was given, expiring after the ttl', async () => {
    const { redis, store } = build();

    await store.open(session);

    const key = voiceSessionKey(GUILD, USER, PREFIX);
    expect(redis.values.has(key)).toBe(true);
    expect(redis.ttls.get(key)).toBe(MAX_VOICE_STAY_MS);
    expect(await store.get(GUILD, USER)).toEqual(session);
  });

  test('closing hands back the session once and forgets it', async () => {
    const { store } = build();
    await store.open(session);

    expect(await store.close(GUILD, USER)).toEqual(session);
    expect(await store.close(GUILD, USER)).toBeNull();
    expect(await store.get(GUILD, USER)).toBeNull();
  });

  test('a stored value that is not JSON, or not a session, reads as none', async () => {
    const { redis, store } = build();
    const key = voiceSessionKey(GUILD, USER, PREFIX);

    redis.values.set(key, '{not json');
    expect(await store.get(GUILD, USER)).toBeNull();

    redis.values.set(key, JSON.stringify({ ...session, channelId: 'lounge' }));
    expect(await store.get(GUILD, USER)).toBeNull();
  });

  test('two prefixes never see each other’s sessions', async () => {
    const redis = new FakeRedis();
    const leveling = new RedisVoiceSessionStore(redis as unknown as Redis, {
      keyPrefix: PREFIX,
      ttlMs: MAX_VOICE_STAY_MS,
    });
    const other = new RedisVoiceSessionStore(redis as unknown as Redis, {
      keyPrefix: 'proton:other:voice',
      ttlMs: MAX_VOICE_STAY_MS,
    });

    await leveling.open(session);

    expect(await other.get(GUILD, USER)).toBeNull();
  });
});
