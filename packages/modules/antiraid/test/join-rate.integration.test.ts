import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { RATE_WINDOW_GUILD_SCOPE, RedisRateWindow, rateWindowKey } from '@proton/core';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import Redis from 'ioredis';
import type { AntiraidConfig } from '../src/config.ts';
import { JOIN_RATE_RULE_ID } from '../src/listener.ts';
import { ALERT_CHANNEL, accountId, GUILD, harness, QUARANTINE_ROLE } from './harness.ts';

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

    expect(h.memberCalls()).toHaveLength(JOINS - THRESHOLD + 1);

    expect(h.calls().filter((call) => call.path.endsWith('/messages'))).toHaveLength(1);
    expect(h.alertContent()).toContain('Raid mode');
  });

  test('the window is one counter for the whole guild, not one per joiner', async () => {
    const h = harness({ rateWindow });

    await Promise.all(
      Array.from({ length: JOINS }, (_, i) => h.join(raider(i), { config: CONFIG })),
    );

    const key = rateWindowKey(GUILD, JOIN_RATE_RULE_ID, RATE_WINDOW_GUILD_SCOPE);
    expect(await redis.zcard(key)).toBe(JOINS);
  });

  test('a redelivered join does not inflate the count (I4)', async () => {
    const h = harness({ rateWindow });

    for (let i = 0; i < 5; i++) {
      await h.join(raider(i), { config: CONFIG });
      await h.join(raider(i), { config: CONFIG });
    }

    const key = rateWindowKey(GUILD, JOIN_RATE_RULE_ID, RATE_WINDOW_GUILD_SCOPE);
    expect(await redis.zcard(key)).toBe(5);
    expect(h.memberCalls()).toHaveLength(0);
  });
});
