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
  /** Return 429 for the first N requests, then succeed. */
  rateLimitFirst?: number;
  /** Retry-After (seconds) sent with those 429s. */
  retryAfter?: number;
  /** Make the 429 a *global* limit rather than a per-bucket one. */
  global?: boolean;
}

export interface MockUpstream {
  url: string;
  requests: UpstreamRequest[];
  /** Requests that were in flight simultaneously, sampled per request. */
  maxConcurrent: number;
  rateLimitedCount: number;
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
  const retryAfter = options.retryAfter ?? 0.2;

  const requests: UpstreamRequest[] = [];
  let inFlight = 0;
  let maxConcurrent = 0;
  let served = 0;
  let rateLimitedCount = 0;

  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      inFlight += 1;
      maxConcurrent = Math.max(maxConcurrent, inFlight);

      const url = new URL(request.url);
      requests.push({ path: url.pathname, method: request.method, receivedAt: Date.now() });

      try {
        served += 1;

        if (served <= rateLimitFirst) {
          rateLimitedCount += 1;
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
      return rateLimitedCount;
    },
    stop: async () => {
      await server.stop(true);
    },
  };
}
