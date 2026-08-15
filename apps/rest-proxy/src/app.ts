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

/**
 * Discord REST egress for every Proton process (PLAN.md I2).
 *
 * Callers speak plain HTTP to `/api/...` and this forwards through the one
 * shared REST client, which owns all bucket and global-limit accounting. No
 * worker ever holds a client against discord.com itself.
 */
export function createProxyApp(rest: REST): Hono {
  const app = new Hono();

  app.get('/healthz', (c) => c.json({ ok: true }));

  app.all('/api/*', async (c) => {
    const url = new URL(c.req.url);

    /**
     * Callers may address the proxy either as `/api/gateway/bot` or, if they
     * front it with their own `@discordjs/rest` (the gateway does, so that its
     * `GET /gateway/bot` also egresses through here per I2), as
     * `/api/v10/gateway/bot`. This client adds the version itself, so an
     * unstripped one produced `https://discord.com/api/v10/v10/gateway/bot`
     * upstream — a 404 that surfaced as a bare 502 with no hint of the cause.
     */
    const route = url.pathname.slice('/api'.length).replace(/^\/v\d+(?=\/)/, '') as RouteLike;
    const method = c.req.method as RequestMethod;

    let body: unknown;
    let files: RawFile[] | undefined;

    if (!BODYLESS_METHODS.has(c.req.method)) {
      /**
       * Two encodings, because Discord accepts two.
       *
       * Anything with an attachment — a rank card, a welcome card — arrives as
       * `multipart/form-data` with the JSON in a `payload_json` field and the
       * bytes in `files[n]` parts. Reading that as text and running `JSON.parse`
       * over it, which is what this did before Phase 3, produces a 400 naming
       * the multipart boundary as invalid JSON: a confusing error for a request
       * that was perfectly well-formed.
       *
       * `@discordjs/rest` re-encodes the multipart body itself from `body` plus
       * `files`, so the boundary this proxy received is not the one Discord
       * sees. That is fine and in fact necessary — the parts have to be rebuilt
       * anyway once the route and headers are attached.
       */
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
          // Duck-typed rather than `instanceof File`: Hono types a form entry as
          // a string, so a class check narrows to `never` and the branch is
          // dropped. The runtime value is a Blob whenever a part carried bytes.
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
      // `queueRequest` rather than `request`: both run the full bucket and 429
      // machinery, but `request` parses the body and throws on non-2xx. This is
      // a proxy, so a Discord 403 is data to hand back verbatim, not an
      // exception to reshape into something the caller can't inspect.
      // A caller may supply a *user* OAuth token (the dashboard resolving which
      // guilds someone administers). Those calls egress here too rather than
      // going direct, so I2 holds for every credential, not just the bot's.
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
      // The client exhausted its retries, or the upstream is unreachable. Say so
      // in a shape callers can surface to an admin rather than a bare 500.
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
