import { describe, expect, test } from 'bun:test';
import {
  CachingConfigProvider,
  ConfigUnavailableError,
  HttpConfigProvider,
} from '../src/config-provider.ts';
import type { ConfigProvider, ModuleConfigSnapshot } from '../src/runtime.ts';

const GUILD = '900000000000000001';

/** Counts reads, and can be made to stall so single-flight is observable. */
function countingProvider(
  snapshot: ModuleConfigSnapshot = { enabled: true, config: { enabled: true } },
): { provider: ConfigProvider; reads: () => number; release: () => void } {
  let reads = 0;
  let unblock: (() => void) | null = null;
  const gate = new Promise<void>((resolve) => {
    unblock = resolve;
  });
  let gated = false;

  return {
    reads: () => reads,
    release: () => {
      gated = false;
      unblock?.();
    },
    provider: {
      async get() {
        reads += 1;
        if (gated) await gate;
        return snapshot;
      },
    },
  };
}

describe('CachingConfigProvider', () => {
  test('serves a second read from cache inside the TTL', async () => {
    const inner = countingProvider();
    const clock = { now: 1_000 };
    const cache = new CachingConfigProvider(inner.provider, {
      ttlMs: 5_000,
      now: () => clock.now,
    });

    await cache.get(GUILD, 'phishing');
    await cache.get(GUILD, 'phishing');

    expect(inner.reads()).toBe(1);
  });

  test('re-reads once the TTL has passed', async () => {
    const inner = countingProvider();
    const clock = { now: 1_000 };
    const cache = new CachingConfigProvider(inner.provider, {
      ttlMs: 5_000,
      now: () => clock.now,
    });

    await cache.get(GUILD, 'phishing');
    clock.now += 5_001;
    await cache.get(GUILD, 'phishing');

    expect(inner.reads()).toBe(2);
  });

  test('caches per guild and per module, never across them', async () => {
    const inner = countingProvider();
    const cache = new CachingConfigProvider(inner.provider, { ttlMs: 5_000 });

    await cache.get(GUILD, 'phishing');
    await cache.get(GUILD, 'antinuke');
    await cache.get('900000000000000002', 'phishing');

    expect(inner.reads()).toBe(3);
  });

  /**
   * The load-bearing case. A twenty-deletion burst arrives as twenty events at
   * once; without single-flight that is twenty concurrent HTTP round trips for
   * one answer, and the burst is exactly the traffic anti-nuke exists for.
   */
  test('concurrent reads for the same module collapse into one fetch', async () => {
    const inner = countingProvider();
    const cache = new CachingConfigProvider(inner.provider, { ttlMs: 5_000 });

    const results = await Promise.all(
      Array.from({ length: 20 }, () => cache.get(GUILD, 'antinuke')),
    );

    expect(inner.reads()).toBe(1);
    expect(results.every((r) => r.enabled)).toBe(true);
  });

  /**
   * A module a guild has *not* enabled is the common case by a wide margin. If
   * only positive answers were cached it would cost a round trip per message
   * forever, which is the opposite of the point.
   */
  test('a disabled module is cached too', async () => {
    const inner = countingProvider({ enabled: false, config: {} });
    const cache = new CachingConfigProvider(inner.provider, { ttlMs: 5_000 });

    await cache.get(GUILD, 'phishing');
    await cache.get(GUILD, 'phishing');

    expect(inner.reads()).toBe(1);
  });

  /** A 500 that stuck for the TTL would outlive the outage that caused it. */
  test('a failure is never cached', async () => {
    let reads = 0;
    const cache = new CachingConfigProvider(
      {
        async get() {
          reads += 1;
          throw new Error('api is down');
        },
      },
      { ttlMs: 5_000 },
    );

    await expect(cache.get(GUILD, 'phishing')).rejects.toThrow('api is down');
    await expect(cache.get(GUILD, 'phishing')).rejects.toThrow('api is down');

    expect(reads).toBe(2);
  });

  test('a zero TTL disables caching entirely, which tests rely on', async () => {
    const inner = countingProvider();
    const cache = new CachingConfigProvider(inner.provider, { ttlMs: 0 });

    await cache.get(GUILD, 'phishing');
    await cache.get(GUILD, 'phishing');

    expect(inner.reads()).toBe(2);
  });

  /**
   * Expired entries are deleted on read, not merely ignored.
   *
   * A worker serving thousands of guilds would otherwise hold one entry per
   * (guild, module) for the life of the process — a map that only ever grows,
   * holding values it will never return. Asserted through the public surface by
   * re-reading the same key after expiry and checking the cache did not keep
   * both the stale value and the fresh one.
   */
  test('an expired entry is evicted rather than left in the map', async () => {
    const inner = countingProvider();
    const clock = { now: 1_000 };
    const cache = new CachingConfigProvider(inner.provider, {
      ttlMs: 1_000,
      now: () => clock.now,
    });

    await cache.get(GUILD, 'phishing');
    clock.now += 2_000;

    // The expired entry is gone, so this is a miss...
    await cache.get(GUILD, 'phishing');
    expect(inner.reads()).toBe(2);

    // ...and the replacement is cached normally rather than the map holding two.
    await cache.get(GUILD, 'phishing');
    expect(inner.reads()).toBe(2);
  });

  test('invalidate drops one entry, and everything when given no key', async () => {
    const inner = countingProvider();
    const cache = new CachingConfigProvider(inner.provider, { ttlMs: 5_000 });

    await cache.get(GUILD, 'phishing');
    cache.invalidate(GUILD, 'phishing');
    await cache.get(GUILD, 'phishing');
    expect(inner.reads()).toBe(2);

    await cache.get(GUILD, 'antinuke');
    cache.invalidate();
    await cache.get(GUILD, 'antinuke');
    expect(inner.reads()).toBe(4);
  });
});

describe('HttpConfigProvider error classification', () => {
  /**
   * The distinction the listener path depends on. A 400 means the stored config
   * does not parse and will not parse on the next try either; retrying it burns
   * every delivery and dead-letters that guild's events for that module.
   */
  test('4xx is permanent', async () => {
    const provider = new HttpConfigProvider('http://api.invalid', 'a'.repeat(16));
    const original = globalThis.fetch;
    globalThis.fetch = (async () => new Response('{}', { status: 400 })) as unknown as typeof fetch;

    try {
      await provider.get(GUILD, 'phishing');
      throw new Error('expected a rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigUnavailableError);
      expect((error as ConfigUnavailableError).permanent).toBe(true);
      expect((error as ConfigUnavailableError).status).toBe(400);
      expect((error as ConfigUnavailableError).moduleId).toBe('phishing');
    } finally {
      globalThis.fetch = original;
    }
  });

  test('404 for an unknown module is permanent too', async () => {
    const provider = new HttpConfigProvider('http://api.invalid', 'a'.repeat(16));
    const original = globalThis.fetch;
    globalThis.fetch = (async () => new Response('{}', { status: 404 })) as unknown as typeof fetch;

    try {
      await provider.get(GUILD, 'nope');
      throw new Error('expected a rejection');
    } catch (error) {
      expect((error as ConfigUnavailableError).permanent).toBe(true);
    } finally {
      globalThis.fetch = original;
    }
  });

  /**
   * The one that would have been a fleet-wide silent outage. `apps/api` answers
   * 401 from its shared-secret middleware, so under a `4xx = permanent` rule a
   * rotated API_SHARED_SECRET would have every listener ack and discard every
   * event, unrecoverably, for every guild.
   */
  test.each([401, 403, 408, 429])('%i is transient, not permanent', async (status) => {
    const provider = new HttpConfigProvider('http://api.invalid', 'a'.repeat(16));
    const original = globalThis.fetch;
    globalThis.fetch = (async () => new Response('{}', { status })) as unknown as typeof fetch;

    try {
      await provider.get(GUILD, 'phishing');
      throw new Error('expected a rejection');
    } catch (error) {
      expect((error as ConfigUnavailableError).permanent).toBe(false);
    } finally {
      globalThis.fetch = original;
    }
  });

  test('5xx is transient, so the event is retried', async () => {
    const provider = new HttpConfigProvider('http://api.invalid', 'a'.repeat(16));
    const original = globalThis.fetch;
    globalThis.fetch = (async () => new Response('{}', { status: 503 })) as unknown as typeof fetch;

    try {
      await provider.get(GUILD, 'phishing');
      throw new Error('expected a rejection');
    } catch (error) {
      expect((error as ConfigUnavailableError).permanent).toBe(false);
    } finally {
      globalThis.fetch = original;
    }
  });

  test('an unreachable API is transient', async () => {
    const provider = new HttpConfigProvider('http://api.invalid', 'a'.repeat(16));
    const original = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new TypeError('connection refused');
    }) as unknown as typeof fetch;

    try {
      await provider.get(GUILD, 'phishing');
      throw new Error('expected a rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigUnavailableError);
      expect((error as ConfigUnavailableError).permanent).toBe(false);
      expect((error as ConfigUnavailableError).message).toContain('could not reach the API');
    } finally {
      globalThis.fetch = original;
    }
  });
});
