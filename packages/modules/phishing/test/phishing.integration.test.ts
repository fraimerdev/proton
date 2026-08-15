import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import Redis from 'ioredis';
import { createPhishingListener } from '../src/listener.ts';
import { BLOCKLIST_PREFIX, RedisBlocklistStore } from '../src/redis-store.ts';
import { refreshBlocklist } from '../src/refresh.ts';
import {
  ALERT_CHANNEL,
  AUTHOR,
  BAD_DOMAIN,
  BOT,
  context,
  LOOKALIKE_DOMAIN,
  messageEvent,
  payloadOf,
  recordingLogger,
  stubFetch,
} from './harness.ts';

let container: StartedRedisContainer;
let redis: Redis;
let store: RedisBlocklistStore;

const FEED_A = 'https://feed-a.test/list.json';
const FEED_B = 'https://feed-b.test/list.json';

beforeAll(async () => {
  container = await new RedisContainer('redis:7-alpine').start();
  redis = new Redis(container.getConnectionUrl());
  store = new RedisBlocklistStore(redis);
}, 240_000);

afterAll(async () => {
  redis?.disconnect();
  await container?.stop();
}, 240_000);

beforeEach(async () => {
  await redis.flushall();
});

function install(domains: string[]): Promise<number> {
  return store.replace({
    domains,
    refreshedAt: new Date('2026-08-15T10:00:00.000Z'),
    feeds: [FEED_A],
    failures: [],
  });
}

describe('RedisBlocklistStore', () => {
  test('stores a list and answers every candidate in one lookup', async () => {
    expect(await install([BAD_DOMAIN, 'discord-nitro.gift'])).toBe(2);

    expect(await store.lookup(['login.evil.example', BAD_DOMAIN])).toBe(BAD_DOMAIN);
    expect(await store.lookup([LOOKALIKE_DOMAIN])).toBeNull();
    expect(await store.lookup([])).toBeNull();
  });

  test('replaces the previous list rather than merging into it', async () => {
    await install(['old.example']);
    await install(['new.example']);

    expect(await store.lookup(['old.example'])).toBeNull();
    expect(await store.lookup(['new.example'])).toBe('new.example');
  });

  /**
   * The swap has to be atomic. Clear-then-repopulate leaves a window in which
   * the list is empty, and every message handled in that window silently goes
   * unchecked — a nightly self-inflicted outage nobody would ever observe.
   */
  test('the old list stays queryable and complete right up to the swap', async () => {
    await install(['old.example']);

    const replacing = store.replace({
      domains: Array.from({ length: 9_000 }, (_, index) => `bulk-${index}.example`),
      refreshedAt: new Date(),
      feeds: [FEED_A],
      failures: [],
    });

    // Interleaved with the write, deliberately: the staging key is a different
    // key, so nothing here can observe a half-built set.
    const during = await Promise.all(
      Array.from({ length: 25 }, () => store.lookup(['old.example'])),
    );
    expect(during.every((hit) => hit === 'old.example')).toBe(true);

    await replacing;
    expect(await store.lookup(['bulk-8999.example'])).toBe('bulk-8999.example');
    expect(await store.lookup(['old.example'])).toBeNull();
  });

  test('leaves no staging keys behind', async () => {
    await install(Array.from({ length: 9_000 }, (_, index) => `bulk-${index}.example`));

    const keys = await redis.keys(`${BLOCKLIST_PREFIX}:domains:staging:*`);
    expect(keys).toEqual([]);
  });

  test('refuses to install an empty list, which would disarm every server', async () => {
    await install([BAD_DOMAIN]);

    await expect(
      store.replace({ domains: [], refreshedAt: new Date(), feeds: [], failures: [] }),
    ).rejects.toThrow('would disarm');

    expect(await store.lookup([BAD_DOMAIN])).toBe(BAD_DOMAIN);
  });

  test('carries refresh metadata for /phishing to report', async () => {
    await store.replace({
      domains: [BAD_DOMAIN],
      refreshedAt: new Date('2026-08-15T10:00:00.000Z'),
      feeds: [FEED_A],
      failures: [{ url: FEED_B, reason: 'HTTP 503' }],
    });

    const stats = await store.stats();
    expect(stats.size).toBe(1);
    expect(stats.refreshedAt).toEqual(new Date('2026-08-15T10:00:00.000Z'));
    expect(stats.feeds).toEqual([FEED_A]);
    expect(stats.failures).toEqual([{ url: FEED_B, reason: 'HTTP 503' }]);
  });

  test('reports an empty cache honestly rather than throwing', async () => {
    const stats = await store.stats();
    expect(stats).toEqual({ size: 0, refreshedAt: null, feeds: [], failures: [] });
  });

  /**
   * The staleness ceiling. If the refresher dies, the list must eventually stop
   * being enforced rather than being served from an arbitrarily distant past
   * while everything reports healthy.
   */
  test('the cached list carries a TTL so a dead refresher becomes visible', async () => {
    await install([BAD_DOMAIN]);

    const ttl = await redis.pttl(`${BLOCKLIST_PREFIX}:domains`);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(24 * 60 * 60 * 1000);
  });
});

describe('refresh → cache → detect, against real Redis', () => {
  test('a fetched feed becomes enforcement, and a lookalike survives it', async () => {
    const { logger } = recordingLogger();

    const outcome = await refreshBlocklist({
      store,
      logger,
      feeds: [FEED_A, FEED_B],
      fetch: stubFetch({
        [FEED_A]: JSON.stringify([BAD_DOMAIN, 'discord-nitro.gift']),
        [FEED_B]: 'free-robux.click\n# a comment\n',
      }),
    });

    expect(outcome.installed).toBe(true);
    expect(outcome.size).toBe(3);

    const listener = createPhishingListener({ blocklist: store, botUserId: BOT });

    const caught = context({ alertChannel: ALERT_CHANNEL });
    await listener.handler(
      messageEvent({ content: `free skins https://login.${BAD_DOMAIN}/gift` }),
      caught.ctx,
    );
    expect(caught.executor.of('timeout')?.targetId).toBe(AUTHOR);
    expect(String(payloadOf(caught.executor.of('send')).content)).toContain(BAD_DOMAIN);

    const clean = context({ alertChannel: ALERT_CHANNEL });
    await listener.handler(
      messageEvent({ content: `the real one is https://${LOOKALIKE_DOMAIN}/market` }),
      clean.ctx,
    );
    expect(clean.executor.requests).toEqual([]);
  });

  /**
   * The Gate 2 requirement for this module, end to end: the feed is down, the
   * cache is cold, and the bot keeps handling messages.
   */
  test('every feed down leaves the module functional with an empty list, and logs why', async () => {
    const { logger, logs } = recordingLogger();

    const outcome = await refreshBlocklist({
      store,
      logger,
      feeds: [FEED_A, FEED_B],
      fetch: stubFetch({
        [FEED_A]: new Error('getaddrinfo ENOTFOUND feed-a.test'),
        [FEED_B]: { status: 502 },
      }),
    });

    expect(outcome.installed).toBe(false);
    expect((await store.stats()).size).toBe(0);

    const explained = logs.find((entry) => entry.message.includes('installed nothing'));
    expect(explained?.level).toBe('error');
    expect(explained?.message).toContain('ENOTFOUND');
    expect(explained?.message).toContain('502');

    // And the module still handles messages, doing nothing, without throwing.
    const listener = createPhishingListener({ blocklist: store, botUserId: BOT });
    const harness = context({ alertChannel: ALERT_CHANNEL });

    await expect(
      listener.handler(messageEvent({ content: `https://${BAD_DOMAIN}/gift` }), harness.ctx),
    ).resolves.toBeUndefined();
    expect(harness.executor.requests).toEqual([]);
  });

  test('a failed refresh keeps yesterday’s list enforced', async () => {
    const { logger } = recordingLogger();

    await install([BAD_DOMAIN]);

    await refreshBlocklist({
      store,
      logger,
      feeds: [FEED_A],
      fetch: stubFetch({ [FEED_A]: new Error('socket hang up') }),
    });

    const listener = createPhishingListener({ blocklist: store, botUserId: BOT });
    const harness = context();
    await listener.handler(messageEvent({ content: `https://${BAD_DOMAIN}/x` }), harness.ctx);

    // Stale coverage beats no coverage.
    expect(harness.executor.of('timeout')).toBeDefined();
  });
});
