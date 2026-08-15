import { describe, expect, test } from 'bun:test';
import {
  CachingConfigProvider,
  ConfigUnavailableError,
  HttpConfigProvider,
} from '../src/config-provider.ts';
import type { ConfigProvider, ModuleConfigSnapshot } from '../src/runtime.ts';

const GUILD = '900000000000000001';

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

  test('concurrent reads for the same module collapse into one fetch', async () => {
    const inner = countingProvider();
    const cache = new CachingConfigProvider(inner.provider, { ttlMs: 5_000 });

    const results = await Promise.all(
      Array.from({ length: 20 }, () => cache.get(GUILD, 'antinuke')),
    );

    expect(inner.reads()).toBe(1);
    expect(results.every((r) => r.enabled)).toBe(true);
  });

  test('a disabled module is cached too', async () => {
    const inner = countingProvider({ enabled: false, config: {} });
    const cache = new CachingConfigProvider(inner.provider, { ttlMs: 5_000 });

    await cache.get(GUILD, 'phishing');
    await cache.get(GUILD, 'phishing');

    expect(inner.reads()).toBe(1);
  });

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

  test('an expired entry is evicted rather than left in the map', async () => {
    const inner = countingProvider();
    const clock = { now: 1_000 };
    const cache = new CachingConfigProvider(inner.provider, {
      ttlMs: 1_000,
      now: () => clock.now,
    });

    await cache.get(GUILD, 'phishing');
    clock.now += 2_000;

    await cache.get(GUILD, 'phishing');
    expect(inner.reads()).toBe(2);

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
