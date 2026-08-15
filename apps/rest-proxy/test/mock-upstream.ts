export interface UpstreamRequest {
  path: string;
  method: string;
  receivedAt: number;
}

export interface MockUpstreamOptions {
  /** Bucket size advertised via X-RateLimit-Limit. */
  limit?: number;
  /** Seconds advertised via X-RateLimit-Reset-After. */
  resetAfter?: number;
  bucket?: string;
  /** Return 429 for the first N eligible requests, then succeed. */
  rateLimitFirst?: number;
  /** Serve this many requests normally before the 429 window opens. */
  rateLimitAfter?: number;
  /** Retry-After (seconds) sent with those 429s. */
  retryAfter?: number;
  /** Make the 429 a *global* limit rather than a per-bucket one. */
  global?: boolean;
  /**
   * Hold every request until this many are in flight at once, or until
   * `rendezvousMs` passes. Turns "did these two overlap?" from a race the
   * scheduler decides into a rendezvous: a caller that really is concurrent
   * always meets the other, and one that is serialised never can.
   */
  rendezvous?: number;
  /** How long a lone request waits at the rendezvous before giving up. */
  rendezvousMs?: number;
}

export interface MockUpstream {
  url: string;
  requests: UpstreamRequest[];
  /** Requests that were in flight simultaneously, sampled per request. */
  maxConcurrent: number;
  rateLimitedCount: number;
  /** Resolves with the moment the Nth 429 was sent. */
  awaitRateLimited(count: number): Promise<number>;
  /** Forget what has been observed, keeping the upstream's own request count. */
  reset(): void;
  stop(): Promise<void>;
}

/**
 * Stands in for discord.com so rate-limit behaviour can be asserted
 * deterministically. Tests never touch the real API (PLAN.md I11).
 */
export function startMockUpstream(options: MockUpstreamOptions = {}): MockUpstream {
  const limit = options.limit ?? 1;
  const resetAfter = options.resetAfter ?? 0.2;
  const bucket = options.bucket ?? 'mock-bucket';
  const rateLimitFirst = options.rateLimitFirst ?? 0;
  const rateLimitAfter = options.rateLimitAfter ?? 0;
  const retryAfter = options.retryAfter ?? 0.2;
  const rendezvousMs = options.rendezvousMs ?? 2_000;

  const requests: UpstreamRequest[] = [];
  let inFlight = 0;
  let maxConcurrent = 0;
  let served = 0;
  let rateLimitedAt: number[] = [];

  const rateLimitWaiters: Array<{ count: number; resolve: (at: number) => void }> = [];
  const met = Promise.withResolvers<void>();

  /** Wait for company, so concurrency is proven by meeting rather than by luck. */
  async function rendezvous(): Promise<void> {
    if (options.rendezvous === undefined) return;
    if (inFlight >= options.rendezvous) met.resolve();
    await Promise.race([met.promise, Bun.sleep(rendezvousMs)]);
  }

  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      inFlight += 1;
      maxConcurrent = Math.max(maxConcurrent, inFlight);

      const url = new URL(request.url);
      requests.push({ path: url.pathname, method: request.method, receivedAt: Date.now() });

      try {
        served += 1;

        if (served > rateLimitAfter && served <= rateLimitAfter + rateLimitFirst) {
          const at = Date.now();
          rateLimitedAt.push(at);
          for (const waiter of rateLimitWaiters.splice(0)) {
            if (rateLimitedAt.length >= waiter.count)
              waiter.resolve(rateLimitedAt[waiter.count - 1] ?? at);
            else rateLimitWaiters.push(waiter);
          }

          const headers: Record<string, string> = {
            'content-type': 'application/json',
            'retry-after': String(retryAfter),
            'x-ratelimit-limit': String(limit),
            'x-ratelimit-remaining': '0',
            'x-ratelimit-reset-after': String(retryAfter),
            'x-ratelimit-bucket': bucket,
            'x-ratelimit-global': options.global ? 'true' : 'false',
          };
          if (options.global) headers['x-ratelimit-scope'] = 'global';

          return new Response(
            JSON.stringify({ message: 'You are being rate limited.', retry_after: retryAfter }),
            { status: 429, headers },
          );
        }

        await rendezvous();
        // Hold the connection briefly so genuine concurrency is observable.
        await Bun.sleep(15);

        return new Response(JSON.stringify({ ok: true, seq: served }), {
          status: 200,
          headers: {
            'content-type': 'application/json',
            'x-ratelimit-limit': String(limit),
            'x-ratelimit-remaining': '0',
            'x-ratelimit-reset-after': String(resetAfter),
            'x-ratelimit-bucket': bucket,
          },
        });
      } finally {
        inFlight -= 1;
      }
    },
  });

  return {
    url: `http://localhost:${server.port}`,
    requests,
    get maxConcurrent() {
      return maxConcurrent;
    },
    get rateLimitedCount() {
      return rateLimitedAt.length;
    },
    awaitRateLimited(count: number): Promise<number> {
      const already = rateLimitedAt[count - 1];
      if (already !== undefined) return Promise.resolve(already);
      return new Promise<number>((resolve) => {
        rateLimitWaiters.push({ count, resolve });
      });
    },
    reset() {
      requests.length = 0;
      maxConcurrent = 0;
      rateLimitedAt = [];
    },
    stop: async () => {
      await server.stop(true);
    },
  };
}
