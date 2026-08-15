import { describe, expect, test } from 'bun:test';
import { refreshBlocklist } from '../src/refresh.ts';
import { MemoryBlocklistStore, recordingLogger, stubFetch } from './harness.ts';

const FEED_A = 'https://feed-a.test/list.json';
const FEED_B = 'https://feed-b.test/list.json';

describe('refreshBlocklist', () => {
  test('installs the union and records which feeds it came from', async () => {
    const store = new MemoryBlocklistStore();
    const { logger } = recordingLogger();

    const outcome = await refreshBlocklist({
      store,
      logger,
      feeds: [FEED_A, FEED_B],
      fetch: stubFetch({ [FEED_A]: '["evil.com"]', [FEED_B]: '["worse.net"]' }),
      now: () => new Date('2026-08-15T10:00:00.000Z'),
    });

    expect(outcome.installed).toBe(true);
    expect(outcome.size).toBe(2);
    expect(store.installs[0]?.feeds).toEqual([FEED_A, FEED_B]);
    expect(store.installs[0]?.refreshedAt).toEqual(new Date('2026-08-15T10:00:00.000Z'));
  });

  test('a partial failure still installs, and warns that coverage narrowed', async () => {
    const store = new MemoryBlocklistStore();
    const { logger, logs } = recordingLogger();

    const outcome = await refreshBlocklist({
      store,
      logger,
      feeds: [FEED_A, FEED_B],
      fetch: stubFetch({
        [FEED_A]: '["evil.com"]',
        [FEED_B]: new Error('connect ETIMEDOUT'),
      }),
    });

    expect(outcome.installed).toBe(true);
    expect(outcome.size).toBe(1);
    expect(outcome.feedsFailed).toBe(1);

    expect(store.installs[0]?.failures[0]?.url).toBe(FEED_B);

    const warned = logs.find((entry) => entry.level === 'warn');
    expect(warned?.message).toContain('coverage is reduced');
  });

  test('every feed failing keeps the previous list instead of wiping it', async () => {
    const store = new MemoryBlocklistStore(['already-cached.ru']);
    const { logger, logs } = recordingLogger();

    const outcome = await refreshBlocklist({
      store,
      logger,
      feeds: [FEED_A, FEED_B],
      fetch: stubFetch({
        [FEED_A]: new Error('socket hang up'),
        [FEED_B]: { status: 500 },
      }),
    });

    expect(outcome.installed).toBe(false);
    expect(store.installs).toEqual([]);

    expect(await store.lookup(['already-cached.ru'])).toBe('already-cached.ru');

    const errored = logs.find(
      (entry) => entry.level === 'error' && entry.message.includes('installed nothing'),
    );
    expect(errored).toBeDefined();
    expect(errored?.message).toContain(FEED_A);
    expect(errored?.message).toContain('socket hang up');
    expect(errored?.message).toContain(FEED_B);
    expect(errored?.message).toContain('500');
  });

  test('never throws when the cache itself is unwritable, and says so', async () => {
    const store = new MemoryBlocklistStore();
    store.replace = async () => {
      throw new Error('READONLY You can not write against a read only replica');
    };
    const { logger, logs } = recordingLogger();

    const outcome = await refreshBlocklist({
      store,
      logger,
      feeds: [FEED_A],
      fetch: stubFetch({ [FEED_A]: '["evil.com"]' }),
    });

    expect(outcome.installed).toBe(false);
    expect(outcome.reason).toContain('READONLY');

    const errored = logs.find((entry) => entry.level === 'error');
    expect(errored?.message).toContain('could not be cached');
  });

  test('a refresh with no feeds configured at all is reported, not silently empty', async () => {
    const store = new MemoryBlocklistStore();
    const { logger, logs } = recordingLogger();

    const outcome = await refreshBlocklist({ store, logger, feeds: [], fetch: stubFetch({}) });

    expect(outcome.installed).toBe(false);
    expect(logs.some((entry) => entry.level === 'error')).toBe(true);
  });
});
