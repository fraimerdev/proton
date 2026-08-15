import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import Redis from 'ioredis';
import { RedisDedupeStore } from '../../src/actions/dedupe.ts';

let container: StartedRedisContainer;
let redis: Redis;
let store: RedisDedupeStore;

beforeAll(async () => {
  container = await new RedisContainer('redis:7-alpine').start();
  redis = new Redis(container.getConnectionUrl());
  store = new RedisDedupeStore(redis);
}, 240_000);

afterAll(async () => {
  redis?.disconnect();
  await container?.stop();
}, 240_000);

beforeEach(async () => {
  await redis.flushall();
});

describe('RedisDedupeStore', () => {
  test('the first claim wins and the second is refused', async () => {
    expect(await store.claim('event-1', 60_000)).toBe(true);
    expect(await store.claim('event-1', 60_000)).toBe(false);
  });

  test('claims are independent across keys', async () => {
    expect(await store.claim('event-1', 60_000)).toBe(true);
    expect(await store.claim('event-2', 60_000)).toBe(true);
  });

  test('only one of many concurrent claimants wins', async () => {
    // Two workers consuming the same redelivered event must not both act.
    const results = await Promise.all(
      Array.from({ length: 20 }, () => store.claim('contested', 60_000)),
    );

    expect(results.filter(Boolean)).toHaveLength(1);
  });

  test('a claim expires after its TTL', async () => {
    expect(await store.claim('short', 100)).toBe(true);
    expect(await store.claim('short', 100)).toBe(false);

    await Bun.sleep(200);

    expect(await store.claim('short', 100)).toBe(true);
  });

  /**
   * Without release, a transient failure would burn the idempotency key and the
   * retry would be silently swallowed as a duplicate — the operation would never
   * happen and nothing would report it.
   */
  test('release returns the key so failed work can be retried', async () => {
    expect(await store.claim('retryable', 60_000)).toBe(true);
    expect(await store.has('retryable')).toBe(true);

    await store.release('retryable');

    expect(await store.has('retryable')).toBe(false);
    expect(await store.claim('retryable', 60_000)).toBe(true);
  });
});
