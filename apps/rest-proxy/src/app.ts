import {
  DiscordAPIError,
  type InternalRequest,
  RateLimitError,
  type RawFile,
  type REST,
  type RequestMethod,
  type RouteLike,
} from '@discordjs/rest';
import { Hono } from 'hono';

const BODYLESS_METHODS = new Set(['GET', 'HEAD', 'DELETE']);

const TOKEN_IN_URL_ROUTES = [/^\/webhooks\/\d+\/[^/]+/, /^\/interactions\/\d+\/[^/]+\/callback$/];

interface BlobLike {
  name?: string;
  type?: string;
  arrayBuffer(): Promise<ArrayBuffer>;
}

function isBlobLike(value: unknown): value is BlobLike {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as BlobLike).arrayBuffer === 'function'
  );
}

function discordAnswer(error: unknown): Response | undefined {
  if (error instanceof DiscordAPIError) {
    const raw: unknown = error.rawError;
    // @discordjs/rest keeps a non-JSON error body as bytes; JSON.stringify would turn it into "{}".
    if (raw instanceof ArrayBuffer) return new Response(raw, { status: error.status });
    return new Response(JSON.stringify(raw), {
      status: error.status,
      headers: { 'content-type': 'application/json' },
    });
  }

  if (error instanceof RateLimitError) {
    const seconds = error.retryAfter / 1000;
    return new Response(
      JSON.stringify({
        message: 'You are being rate limited.',
        retry_after: seconds,
        global: error.global,
      }),
      {
        status: 429,
        headers: { 'content-type': 'application/json', 'retry-after': String(Math.ceil(seconds)) },
      },
    );
  }

  return undefined;
}

export function createProxyApp(rest: REST): Hono {
  const app = new Hono();

  app.get('/healthz', (c) => c.json({ ok: true }));

  app.all('/api/*', async (c) => {
    const url = new URL(c.req.url);

    const route = url.pathname.slice('/api'.length).replace(/^\/v\d+(?=\/)/, '') as RouteLike;
    const method = c.req.method as RequestMethod;

    let body: unknown;
    let files: RawFile[] | undefined;

    if (!BODYLESS_METHODS.has(c.req.method)) {
      if (c.req.header('content-type')?.includes('multipart/form-data')) {
        const form = await c.req.formData().catch(() => null);
        if (!form) return c.json({ error: 'invalid multipart body' }, 400);

        const payload = form.get('payload_json');
        if (typeof payload === 'string' && payload) {
          try {
            body = JSON.parse(payload);
          } catch {
            return c.json({ error: 'invalid JSON in payload_json' }, 400);
          }
        }

        files = [];
        for (const [key, value] of form.entries()) {
          if (key === 'payload_json') continue;

          const part = value as unknown;
          if (!isBlobLike(part)) continue;

          files.push({
            name: part.name || key,
            data: Buffer.from(await part.arrayBuffer()),
            contentType: part.type || 'application/octet-stream',
          });
        }
      } else {
        const raw = await c.req.text();
        if (raw) {
          try {
            body = JSON.parse(raw);
          } catch {
            return c.json({ error: 'invalid JSON body' }, 400);
          }
        }
      }
    }

    try {
      const userAuth = c.req.header('x-proton-authorization');
      const tokenInUrl = TOKEN_IN_URL_ROUTES.some((pattern) => pattern.test(route));
      const auditReason = c.req.header('x-audit-log-reason');

      // Not InternalRequest.reason: @discordjs/rest encodes that, and the caller already did.
      const upstreamHeaders: Record<string, string> = {
        ...(userAuth ? { Authorization: userAuth } : {}),
        ...(auditReason ? { 'X-Audit-Log-Reason': auditReason } : {}),
      };

      const request: InternalRequest = {
        fullRoute: route,
        method,
        query: url.searchParams,
        ...(body !== undefined ? { body } : {}),
        ...(files && files.length > 0 ? { files } : {}),
        ...(userAuth || tokenInUrl ? { auth: false } : {}),
        ...(Object.keys(upstreamHeaders).length > 0 ? { headers: upstreamHeaders } : {}),
      };

      const response = await rest.queueRequest(request);

      const text = await response.text();
      const headers = new Headers();
      for (const key of ['content-type', 'x-ratelimit-bucket', 'x-ratelimit-remaining']) {
        const value = response.headers.get(key);
        if (value) headers.set(key, value);
      }

      return new Response(text, { status: response.status, headers });
    } catch (error) {
      const answer = discordAnswer(error);
      if (answer) return answer;

      return c.json(
        {
          error: 'rest_proxy_upstream_failure',
          message: error instanceof Error ? error.message : String(error),
        },
        502,
      );
    }
  });

  return app;
}
