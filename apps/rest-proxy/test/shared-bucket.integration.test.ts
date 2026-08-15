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

/**
 * Give the client one round-trip on a route before measuring it.
 *
 * A cold `@discordjs/rest` has no bucket hash for a route, so it queues on a
 * provisional handler and creates a *second* one the moment the first response
 * names the bucket — briefly two queues for one bucket, and requests already
 * waiting on the provisional one keep their own rate-limit timing. Verified by
 * probe: after six cold requests to one route the client holds both
 * `Global(POST:/channels/:id/messages)` and `mock-bucket`. That transient is
 * hash learning inside the library, not the shared accounting these tests are
 * about, and racing it is what made them flaky under load.
 */
async function warmBucket(proxyUrl: string, upstream: MockUpstream): Promise<void> {
  await worker(proxyUrl, 1);
  upstream.reset();
}

describe('shared bucket', () => {
  test('two independent callers are serialised through one bucket', async () => {
    upstream = startMockUpstream({ limit: 1, resetAfter: 0.05 });
    const proxyUrl = startProxy(upstream.url);
    await warmBucket(proxyUrl, upstream);

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
   *
   * The upstream holds the first arrival until a second joins it, so the two
   * clients have to *meet* rather than happen to overlap: under load the 15ms
   * hold alone was short enough that they sometimes did not, and the
   * counterfactual failed while proving nothing about the code.
   */
  test('two separate REST clients would NOT share a bucket', async () => {
    upstream = startMockUpstream({ limit: 1, resetAfter: 0.05, rendezvous: 2 });

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
    // The warm-up request must not be the rate-limited one, so the 429 window
    // opens after it.
    upstream = startMockUpstream({
      rateLimitAfter: 1,
      rateLimitFirst: 1,
      retryAfter: 0.2,
      limit: 1,
    });
    const proxyUrl = startProxy(upstream.url);
    await warmBucket(proxyUrl, upstream);

    const [a, b] = await Promise.all([worker(proxyUrl, 1), worker(proxyUrl, 1)]);

    expect(a[0]).toBe(200);
    expect(b[0]).toBe(200);
    expect(upstream.rateLimitedCount).toBe(1);
    // The second caller waited out the first's Retry-After instead of issuing
    // its own doomed request in parallel.
    expect(upstream.maxConcurrent).toBe(1);
  }, 60_000);

  test('a global 429 pauses every route, not just the offending bucket', async () => {
    upstream = startMockUpstream({ rateLimitFirst: 1, retryAfter: 0.4, global: true, limit: 1 });
    const proxyUrl = startProxy(upstream.url);

    const messages = fetch(`${proxyUrl}/api/channels/123/messages`, { method: 'GET' });

    // The second route is issued only once the global 429 has actually been
    // sent. Firing both at once races the client's own bookkeeping: if the
    // second request leaves before the 429 lands, its timing says nothing about
    // whether the pause is global.
    const rateLimitedAt = await upstream.awaitRateLimited(1);
    await Bun.sleep(50);

    const roles = await fetch(`${proxyUrl}/api/guilds/456/roles`, { method: 'GET' });

    expect((await messages).status).toBe(200);
    expect(roles.status).toBe(200);

    // `/guilds/456/roles` shares no bucket with `/channels/123/messages`, so the
    // only thing that can have held it back for most of the 400ms Retry-After is
    // the global pause. (Nothing is asserted about the two travelling together
    // afterwards — Discord's global limit is a rate, not a lock.)
    const rolesArrival = upstream.requests.find((r) => r.path.endsWith('/roles'))?.receivedAt ?? 0;
    expect(rolesArrival - rateLimitedAt).toBeGreaterThanOrEqual(300);
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
