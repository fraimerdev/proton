import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import Redis from 'ioredis';
import { RedisSessionStore, type SessionInfo } from '../src/session-store.ts';

let container: StartedRedisContainer;
let redis: Redis;
let store: RedisSessionStore;

const info: SessionInfo = {
  sessionId: 'fixture-session-0001',
  sequence: 42,
  shardId: 0,
  shardCount: 1,
  resumeURL: 'wss://gateway-us-east1-b.discord.gg',
};

beforeAll(async () => {
  container = await new RedisContainer('redis:7-alpine').start();
  redis = new Redis(container.getConnectionUrl());
  store = new RedisSessionStore(redis);
}, 240_000);

afterAll(async () => {
  redis?.disconnect();
  await container?.stop();
}, 240_000);

beforeEach(async () => {
  await redis.flushall();
});

describe('RedisSessionStore', () => {
  test('round-trips session info for a shard', async () => {
    await store.updateSessionInfo(0, info);

    expect(await store.retrieveSessionInfo(0)).toEqual(info);
  });

  test('returns null for a shard it has never seen', async () => {
    expect(await store.retrieveSessionInfo(7)).toBeNull();
  });

  test('keeps shards independent', async () => {
    await store.updateSessionInfo(0, info);
    await store.updateSessionInfo(1, { ...info, shardId: 1, sessionId: 'other' });

    expect((await store.retrieveSessionInfo(0))?.sessionId).toBe('fixture-session-0001');
    expect((await store.retrieveSessionInfo(1))?.sessionId).toBe('other');
  });

  /**
   * The point of I13. A fresh process must be able to recover the session and
   * RESUME rather than IDENTIFY — session starts are capped at 1000/day and a
   * crash loop that identifies each time would exhaust that budget.
   */
  test('session info survives a new store instance against the same Redis', async () => {
    await store.updateSessionInfo(0, info);

    const afterRestart = new RedisSessionStore(redis);

    expect(await afterRestart.retrieveSessionInfo(0)).toEqual(info);
  });

  test('a null update clears the session so the next connect identifies cleanly', async () => {
    await store.updateSessionInfo(0, info);
    await store.updateSessionInfo(0, null);

    expect(await store.retrieveSessionInfo(0)).toBeNull();
  });

  /**
   * Corrupt state must not produce a RESUME attempt Discord will reject —
   * returning null forces a clean IDENTIFY instead.
   */
  test('corrupt stored state degrades to null rather than throwing', async () => {
    await redis.set('proton:gateway:session:0', 'not json at all');

    expect(await store.retrieveSessionInfo(0)).toBeNull();
  });

  test('updates overwrite the sequence as the shard advances', async () => {
    await store.updateSessionInfo(0, info);
    await store.updateSessionInfo(0, { ...info, sequence: 1337 });

    expect((await store.retrieveSessionInfo(0))?.sequence).toBe(1337);
  });
});
