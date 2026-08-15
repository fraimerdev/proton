import type { InternalRequest, RawFile, REST, RequestMethod, RouteLike } from '@discordjs/rest';
import { Hono } from 'hono';

const BODYLESS_METHODS = new Set(['GET', 'HEAD', 'DELETE']);

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

      const request: InternalRequest = {
        fullRoute: route,
        method,
        query: url.searchParams,
        ...(body !== undefined ? { body } : {}),
        ...(files && files.length > 0 ? { files } : {}),
        ...(userAuth ? { auth: false, headers: { Authorization: userAuth } } : {}),
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
