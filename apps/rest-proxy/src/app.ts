import type { InternalRequest, REST, RequestMethod, RouteLike } from '@discordjs/rest';
import { Hono } from 'hono';

const BODYLESS_METHODS = new Set(['GET', 'HEAD', 'DELETE']);

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
    const route = url.pathname.slice('/api'.length) as RouteLike;
    const method = c.req.method as RequestMethod;

    let body: unknown;
    if (!BODYLESS_METHODS.has(c.req.method)) {
      const raw = await c.req.text();
      if (raw) {
        try {
          body = JSON.parse(raw);
        } catch {
          return c.json({ error: 'invalid JSON body' }, 400);
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
