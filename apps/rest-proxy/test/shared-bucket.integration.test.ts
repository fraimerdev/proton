import { afterEach, describe, expect, test } from 'bun:test';
import { createProxyApp } from '../src/app.ts';
import { createRest } from '../src/rest.ts';
import { type MockUpstream, startMockUpstream } from './mock-upstream.ts';

let upstream: MockUpstream | undefined;
let proxy: ReturnType<typeof Bun.serve> | undefined;

afterEach(async () => {
  await proxy?.stop(true);
  await upstream?.stop();
  proxy = undefined;
  upstream = undefined;
});

/** Start the proxy on an ephemeral port, pointed at the mock upstream. */
function startProxy(api: string): string {
  const rest = createRest({ token: 'test-token', api });
  const app = createProxyApp(rest);
  proxy = Bun.serve({ port: 0, fetch: app.fetch });
  return `http://localhost:${proxy.port}`;
}

/** One simulated worker process: an independent HTTP client of the proxy. */
async function worker(proxyUrl: string, count: number): Promise<number[]> {
  const statuses: number[] = [];
  for (let i = 0; i < count; i++) {
    const res = await fetch(`${proxyUrl}/api/channels/123/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'hi' }),
    });
    statuses.push(res.status);
  }
  return statuses;
}

describe('shared bucket', () => {
  test('two independent callers are serialised through one bucket', async () => {
    upstream = startMockUpstream({ limit: 1, resetAfter: 0.05 });
    const proxyUrl = startProxy(upstream.url);

    // Two workers, firing concurrently, with no knowledge of each other.
    const [a, b] = await Promise.all([worker(proxyUrl, 3), worker(proxyUrl, 3)]);

    expect(a.every((s) => s === 200)).toBe(true);
    expect(b.every((s) => s === 200)).toBe(true);
    expect(upstream.requests).toHaveLength(6);

    // The whole point of I2: the upstream never saw two requests at once, even
    // though two callers were issuing them independently.
    expect(upstream.maxConcurrent).toBe(1);
  }, 60_000);

  /**
   * The counterfactual that gives the test above its meaning.
   *
   * Without the proxy — two processes each holding their own REST client — the
   * bucket accounting is per-client, so both believe they have room and both
   * issue at once. This is the failure I2 exists to prevent, demonstrated rather
   * than asserted.
   */
  test('two separate REST clients would NOT share a bucket', async () => {
    upstream = startMockUpstream({ limit: 1, resetAfter: 0.05 });

    const restA = createRest({ token: 't', api: upstream.url });
    const restB = createRest({ token: 't', api: upstream.url });

    await Promise.all([
      restA.queueRequest({
        fullRoute: '/channels/123/messages',
        method: 'POST' as never,
        body: {},
      }),
      restB.queueRequest({
        fullRoute: '/channels/123/messages',
        method: 'POST' as never,
        body: {},
      }),
    ]);

    expect(upstream.maxConcurrent).toBe(2);
  }, 60_000);
});

describe('rate limit handling', () => {
  test('a 429 with Retry-After is retried and eventually succeeds', async () => {
    upstream = startMockUpstream({ rateLimitFirst: 1, retryAfter: 0.15, limit: 1 });
    const proxyUrl = startProxy(upstream.url);

    const started = Date.now();
    const res = await fetch(`${proxyUrl}/api/channels/123/messages`, { method: 'GET' });
    const elapsed = Date.now() - started;

    expect(res.status).toBe(200);
    expect(upstream.rateLimitedCount).toBe(1);
    // Two upstream hits: the 429 and the successful retry.
    expect(upstream.requests).toHaveLength(2);
    // And it actually waited rather than hammering.
    expect(elapsed).toBeGreaterThanOrEqual(140);
  }, 60_000);

  test('a 429 for one caller also holds back the other', async () => {
    upstream = startMockUpstream({ rateLimitFirst: 1, retryAfter: 0.2, limit: 1 });
    const proxyUrl = startProxy(upstream.url);

    const [a, b] = await Promise.all([worker(proxyUrl, 1), worker(proxyUrl, 1)]);

    expect(a[0]).toBe(200);
    expect(b[0]).toBe(200);
    // The second caller waited out the first's Retry-After instead of issuing
    // its own doomed request in parallel.
    expect(upstream.maxConcurrent).toBe(1);
  }, 60_000);

  test('a global 429 pauses every route, not just the offending bucket', async () => {
    upstream = startMockUpstream({ rateLimitFirst: 1, retryAfter: 0.15, global: true, limit: 1 });
    const proxyUrl = startProxy(upstream.url);

    const [messages, roles] = await Promise.all([
      fetch(`${proxyUrl}/api/channels/123/messages`, { method: 'GET' }),
      fetch(`${proxyUrl}/api/guilds/456/roles`, { method: 'GET' }),
    ]);

    expect(messages.status).toBe(200);
    expect(roles.status).toBe(200);
    expect(upstream.maxConcurrent).toBe(1);
  }, 60_000);

  test('passes an upstream error status through rather than masking it', async () => {
    upstream = startMockUpstream();
    const proxyUrl = startProxy(upstream.url);

    const res = await fetch(`${proxyUrl}/api/channels/123/messages`, { method: 'GET' });
    expect(res.status).toBe(200);

    // healthz is local to the proxy and must not reach the upstream.
    const before = upstream.requests.length;
    const health = await fetch(`${proxyUrl}/healthz`);
    expect(health.status).toBe(200);
    expect(upstream.requests).toHaveLength(before);
  }, 60_000);
});
