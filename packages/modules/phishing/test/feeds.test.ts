import { describe, expect, test } from 'bun:test';
import { DEFAULT_BLOCKLIST_FEEDS, fetchBlocklist, parseFeedBody } from '../src/feeds.ts';
import { recordingLogger, stubFetch } from './harness.ts';

const FEED_A = 'https://feed-a.test/list.json';
const FEED_B = 'https://feed-b.test/domains.txt';

describe('parseFeedBody', () => {
  test('reads a JSON array of domains — the shape both default feeds serve', () => {
    expect(parseFeedBody('["evil.com", "worse.net"]')).toEqual(['evil.com', 'worse.net']);
  });

  test('reads line-delimited text, ignoring comments and blank lines', () => {
    const body = ['# a comment', '', 'evil.com', '// another comment', 'worse.net'].join('\n');
    expect(parseFeedBody(body)).toEqual(['evil.com', 'worse.net']);
  });

  test('reads hosts-file format, ignoring the sinkhole address', () => {
    expect(parseFeedBody('0.0.0.0 evil.com\n127.0.0.1 worse.net')).toEqual([
      'evil.com',
      'worse.net',
    ]);
  });

  test('refuses a JSON body that is not an array, rather than caching nothing quietly', () => {
    expect(() => parseFeedBody('[{"domain": "evil.com"}]')).not.toThrow();
    expect(parseFeedBody('[{"domain": "evil.com"}]')).toEqual([]);
  });
});

describe('fetchBlocklist', () => {
  test('unions every feed that answered and reports what each contributed', async () => {
    const { logger } = recordingLogger();

    const result = await fetchBlocklist({
      logger,
      feeds: [FEED_A, FEED_B],
      fetch: stubFetch({
        [FEED_A]: '["evil.com", "shared.net"]',
        [FEED_B]: 'shared.net\nworse.org',
      }),
    });

    expect(result.domains.toSorted()).toEqual(['evil.com', 'shared.net', 'worse.org']);
    expect(result.failed).toEqual([]);
    expect(result.succeeded).toHaveLength(2);
  });

  test('normalises and deduplicates on the way in', async () => {
    const { logger } = recordingLogger();

    const result = await fetchBlocklist({
      logger,
      feeds: [FEED_A],
      fetch: stubFetch({ [FEED_A]: '["EVIL.COM", "*.evil.com", "http://evil.com/login"]' }),
    });

    expect(result.domains).toEqual(['evil.com']);
  });

  test('drops feed junk and counts it rather than caching unmatched entries', async () => {
    const { logger } = recordingLogger();

    const result = await fetchBlocklist({
      logger,
      feeds: [FEED_A],
      fetch: stubFetch({ [FEED_A]: '["evil.com", "localhost", "127.0.0.1", "com", ""]' }),
    });

    expect(result.domains).toEqual(['evil.com']);
    expect(result.succeeded[0]?.rejected).toBe(4);
  });

  /**
   * The isolation property. A module with several feeds that loses them all
   * because one went down would be worse than a module with one feed.
   */
  test('one feed failing leaves the others contributing, and says why in the log', async () => {
    const { logger, logs } = recordingLogger();

    const result = await fetchBlocklist({
      logger,
      feeds: [FEED_A, FEED_B],
      fetch: stubFetch({
        [FEED_A]: new Error('getaddrinfo ENOTFOUND feed-a.test'),
        [FEED_B]: '["worse.org"]',
      }),
    });

    expect(result.domains).toEqual(['worse.org']);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]?.url).toBe(FEED_A);
    expect(result.failed[0]?.reason).toContain('ENOTFOUND');

    const logged = logs.find((entry) => entry.level === 'error');
    expect(logged?.message).toContain(FEED_A);
    expect(logged?.message).toContain('ENOTFOUND');
  });

  test('treats a non-2xx as a failure and names the status', async () => {
    const { logger } = recordingLogger();

    const result = await fetchBlocklist({
      logger,
      feeds: [FEED_A],
      fetch: stubFetch({ [FEED_A]: { status: 503 } }),
    });

    expect(result.domains).toEqual([]);
    expect(result.failed[0]?.reason).toContain('503');
  });

  /**
   * A 200 carrying no usable domain is the nastiest feed failure, because every
   * naive client records it as a successful refresh of an empty list.
   */
  test('treats a 200 with no usable domains as a failure, not as an empty list', async () => {
    const { logger } = recordingLogger();

    const result = await fetchBlocklist({
      logger,
      feeds: [FEED_A],
      fetch: stubFetch({ [FEED_A]: { status: 200, body: '<html>rate limited</html>' } }),
    });

    expect(result.succeeded).toEqual([]);
    expect(result.failed[0]?.reason).toContain('no usable domains');
  });

  test('refuses an oversized body rather than reading it into the heap', async () => {
    const { logger } = recordingLogger();

    const result = await fetchBlocklist({
      logger,
      feeds: [FEED_A],
      maxBytes: 32,
      fetch: stubFetch({ [FEED_A]: JSON.stringify(['a'.repeat(200)]) }),
    });

    expect(result.failed[0]?.reason).toContain('over the 32-byte limit');
  });

  test('never rejects, whatever the network does', async () => {
    const { logger } = recordingLogger();

    const result = await fetchBlocklist({
      logger,
      feeds: [FEED_A, FEED_B],
      fetch: stubFetch({
        [FEED_A]: new Error('socket hang up'),
        [FEED_B]: new Error('certificate has expired'),
      }),
    });

    expect(result.domains).toEqual([]);
    expect(result.failed).toHaveLength(2);
  });
});

describe('default feeds', () => {
  test('ships more than one, so a single list going dark is not a total outage', () => {
    expect(DEFAULT_BLOCKLIST_FEEDS.length).toBeGreaterThan(1);
  });

  test('are all https — a plaintext blocklist is an injectable blocklist', () => {
    for (const feed of DEFAULT_BLOCKLIST_FEEDS) {
      expect(feed.startsWith('https://')).toBe(true);
    }
  });
});
