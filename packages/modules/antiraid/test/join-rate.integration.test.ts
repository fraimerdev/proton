import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { RATE_WINDOW_GUILD_SCOPE, RedisRateWindow, rateWindowKey } from '@proton/core';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import Redis from 'ioredis';
import type { AntiraidConfig } from '../src/config.ts';
import { JOIN_RATE_RULE_ID } from '../src/listener.ts';
import { ALERT_CHANNEL, accountId, GUILD, harness, QUARANTINE_ROLE } from './harness.ts';

/**
 * The join-rate window against real Redis.
 *
 * `MemoryRateWindow` mirrors the Lua and is what the behavioural tests use, but
 * the property that matters here cannot be shown in a single process pretending
 * to be several: workers consume the same bus, so a raid arrives as concurrent
 * joins, and a read-then-increment counter would let each worker see a count
 * below the threshold and wave the whole burst through. That is the failure
 * §4-P2 makes the script atomic to prevent, and this is anti-raid's stake in it.
 */

const DAY = 24 * 60 * 60 * 1000;
const RAID_START = Date.parse('2026-08-14T09:00:00.000Z');
const JOINS = 25;
const THRESHOLD = 10;

let container: StartedRedisContainer;
let redis: Redis;
let rateWindow: RedisRateWindow;

const CONFIG: Partial<AntiraidConfig> = {
  enabled: true,
  response: 'quarantine',
  quarantineRoleId: QUARANTINE_ROLE,
  alertChannelId: ALERT_CHANNEL,
  joinThreshold: THRESHOLD,
};

beforeAll(async () => {
  container = await new RedisContainer('redis:7-alpine').start();
  redis = new Redis(container.getConnectionUrl());
  rateWindow = new RedisRateWindow(redis);
}, 240_000);

afterAll(async () => {
  redis?.disconnect();
  await container?.stop();
}, 240_000);

beforeEach(async () => {
  await redis.flushall();
});

/** New, avatarless accounts: two signals, one short of acting on their own. */
function raider(index: number) {
  return {
    userId: accountId(RAID_START - 3 * DAY + index),
    joinedAt: RAID_START + index,
    avatar: null,
  };
}

describe('the join-rate window on real Redis', () => {
  test('a concurrent burst acts on exactly the joins past the threshold', async () => {
    const h = harness({ rateWindow });

    await Promise.all(
      Array.from({ length: JOINS }, (_, i) => h.join(raider(i), { config: CONFIG })),
    );

    // Every join saw a distinct count, so the counts are 1..25 whatever order
    // they interleaved in: 9 below the threshold and 16 at or above it. Under a
    // non-atomic counter this number sags towards zero and the raid walks in.
    expect(h.memberCalls()).toHaveLength(JOINS - THRESHOLD + 1);

    // `tripped` is true on exactly the hit that crossed, even when 25 of them
    // race, so the guild is told once rather than sixteen times.
    expect(h.calls().filter((call) => call.path.endsWith('/messages'))).toHaveLength(1);
    expect(h.alertContent()).toContain('Raid mode');
  });

  test('the window is one counter for the whole guild, not one per joiner', async () => {
    const h = harness({ rateWindow });

    await Promise.all(
      Array.from({ length: JOINS }, (_, i) => h.join(raider(i), { config: CONFIG })),
    );

    // A raid is many accounts joining once each, so a per-actor window would
    // count to one, twenty-five times, and never trip.
    const key = rateWindowKey(GUILD, JOIN_RATE_RULE_ID, RATE_WINDOW_GUILD_SCOPE);
    expect(await redis.zcard(key)).toBe(JOINS);
  });

  test('a redelivered join does not inflate the count (I4)', async () => {
    const h = harness({ rateWindow });

    for (let i = 0; i < 5; i++) {
      await h.join(raider(i), { config: CONFIG });
      await h.join(raider(i), { config: CONFIG });
    }

    // Ten deliveries, five joins. A window that counted redeliveries would put a
    // quiet server into raid mode every time the gateway resumed.
    const key = rateWindowKey(GUILD, JOIN_RATE_RULE_ID, RATE_WINDOW_GUILD_SCOPE);
    expect(await redis.zcard(key)).toBe(5);
    expect(h.memberCalls()).toHaveLength(0);
  });
});
