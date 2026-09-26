import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { MAX_VOICE_STAY_MS } from '@proton/core';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import Redis from 'ioredis';
import { LOCK_PREFIX, RedisFencedLocks, RedisLimits } from '../src/redis-helpers.ts';
import {
  achievementVoiceKey,
  achievementVoiceSetKey,
  achievementVoiceTombstoneKey,
  RedisAchievementVoiceStore,
  VOICE_SESSION_GRACE_MS,
  VOICE_TOMBSTONE_TTL_MS,
} from '../src/voice-store.ts';
import { CHANNEL, describeVoiceStore, GUILD, MINUTE, USER, USER_2 } from './contracts.ts';

let container: StartedRedisContainer;
let redis: Redis;

beforeAll(async () => {
  container = await new RedisContainer('redis:7-alpine').start();
  redis = new Redis(container.getConnectionUrl());
}, 240_000);

afterAll(async () => {
  redis?.disconnect();
  await container?.stop();
}, 240_000);

describeVoiceStore('redis voice store', async () => {
  await redis.flushall();
  return {
    voice: new RedisAchievementVoiceStore(redis),
    locks: new RedisFencedLocks(redis),
    limits: new RedisLimits(redis),
  };
});

describe('redis voice store: keys and expiry', () => {
  test('a session expires 24 hours and a minute after it started, and advancing keeps that', async () => {
    await redis.flushall();
    const voice = new RedisAchievementVoiceStore(redis);
    const now = Date.now();
    const startedAt = now - MAX_VOICE_STAY_MS + 10_000;
    const session = {
      channelId: CHANNEL,
      joinedAt: now,
      startedAt,
      lastEventAt: now,
      temporary: false,
    };

    expect(await voice.open(GUILD, USER, session)).toBe(true);

    const ttl = await redis.pttl(achievementVoiceKey(GUILD, USER));
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(10_000 + VOICE_SESSION_GRACE_MS);
    expect(await redis.pttl(achievementVoiceSetKey(GUILD))).toBeGreaterThan(0);

    expect(await voice.advance(GUILD, USER, now, { joinedAt: now + MINUTE })).toBe(true);
    const after = await redis.pttl(achievementVoiceKey(GUILD, USER));
    expect(after).toBeGreaterThan(0);
    expect(after).toBeLessThanOrEqual(ttl);
  });

  test('closing leaves a ten-minute tombstone at the latest time the session saw', async () => {
    await redis.flushall();
    const voice = new RedisAchievementVoiceStore(redis);
    const now = Date.now();

    await voice.open(GUILD, USER, {
      channelId: CHANNEL,
      joinedAt: now,
      startedAt: now,
      lastEventAt: now,
      temporary: true,
    });
    await voice.advance(GUILD, USER, now, { lastEventAt: now + 500 });
    expect(await voice.close(GUILD, USER, now, now + 100)).toBe(true);

    const tombstone = achievementVoiceTombstoneKey(GUILD, USER);
    expect(await redis.get(tombstone)).toBe(String(now + 500));
    expect(await redis.pttl(tombstone)).toBeGreaterThan(VOICE_TOMBSTONE_TTL_MS - 5_000);
    expect(await redis.sismember(achievementVoiceSetKey(GUILD), USER)).toBe(0);
  });

  test('listing forgets members whose session expired without a close', async () => {
    await redis.flushall();
    const voice = new RedisAchievementVoiceStore(redis);
    const now = Date.now();
    const session = {
      channelId: CHANNEL,
      joinedAt: now,
      startedAt: now,
      lastEventAt: now,
      temporary: false,
    };

    await voice.open(GUILD, USER, session);
    await voice.open(GUILD, USER_2, session);
    await redis.del(achievementVoiceKey(GUILD, USER));

    expect((await voice.list(GUILD)).map((entry) => entry.userId)).toEqual([USER_2]);
    expect(await redis.smembers(achievementVoiceSetKey(GUILD))).toEqual([USER_2]);
  });

  test('limits and locks expire on their own', async () => {
    await redis.flushall();
    const locks = new RedisFencedLocks(redis);
    const limits = new RedisLimits(redis);

    await locks.acquire(`voice:${GUILD}:${USER}`, 30_000);
    expect(await redis.pttl(`${LOCK_PREFIX}:voice:${GUILD}:${USER}`)).toBeGreaterThan(25_000);

    await limits.claim('proton:achievements:msgcd:test', 'message-1', 15_000);
    expect(await redis.pttl('proton:achievements:msgcd:test')).toBeGreaterThan(10_000);

    await limits.count('proton:achievements:given:test', 60_000);
    await limits.count('proton:achievements:given:test', 60_000);
    expect(await redis.pttl('proton:achievements:given:test')).toBeGreaterThan(55_000);
  });
});
