import { afterEach, describe, expect, test } from 'bun:test';
import { REST } from '@discordjs/rest';
import { createProxyApp } from '../src/app.ts';
import { createRest } from '../src/rest.ts';

interface Seen {
  method: string;
  path: string;
  authorization: string | null;
}

interface ScriptedUpstream {
  url: string;
  seen: Seen[];
  stop(): Promise<void>;
}

let upstream: ScriptedUpstream | undefined;
let proxy: ReturnType<typeof Bun.serve> | undefined;

afterEach(async () => {
  await proxy?.stop(true);
  await upstream?.stop();
  proxy = undefined;
  upstream = undefined;
});

function startUpstream(answer: (path: string) => Response | Promise<Response>): ScriptedUpstream {
  const seen: Seen[] = [];
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname.replace(/^\/v10/, '');
      seen.push({
        method: request.method,
        path,
        authorization: request.headers.get('authorization'),
      });
      return answer(path);
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    seen,
    stop: () => server.stop(true),
  };
}

function startProxy(rest: REST): string {
  proxy = Bun.serve({ port: 0, fetch: createProxyApp(rest).fetch });
  return `http://127.0.0.1:${proxy.port}`;
}

function discordJson(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

const MISSING_PERMISSIONS = { code: 50013, message: 'Missing Permissions' };
const UNKNOWN_GUILD = { code: 10004, message: 'Unknown Guild' };
const INVALID_FORM_BODY = {
  code: 50035,
  message: 'Invalid Form Body',
  errors: {
    content: {
      _errors: [{ code: 'BASE_TYPE_MAX_LENGTH', message: 'Must be 2000 or fewer in length.' }],
    },
  },
};
const UNAUTHORIZED = { code: 0, message: '401: Unauthorized' };
const INVALID_WEBHOOK_TOKEN = { code: 50027, message: 'Invalid Webhook Token' };

const refusals = [
  { status: 403, method: 'PUT', path: '/guilds/456/bans/789', body: MISSING_PERMISSIONS },
  { status: 404, method: 'GET', path: '/guilds/999', body: UNKNOWN_GUILD },
  { status: 400, method: 'POST', path: '/channels/111/messages', body: INVALID_FORM_BODY },
];

describe('a Discord refusal', () => {
  for (const refusal of refusals) {
    test(`${refusal.status} reaches the caller with Discord's status and exact body`, async () => {
      upstream = startUpstream(() => discordJson(refusal.status, refusal.body));
      const proxyUrl = startProxy(createRest({ token: 'test-token', api: upstream.url }));

      const res = await fetch(`${proxyUrl}/api${refusal.path}`, {
        method: refusal.method,
        headers: { 'content-type': 'application/json' },
        ...(refusal.method === 'GET' ? {} : { body: JSON.stringify({ content: 'x' }) }),
      });

      expect(res.status).toBe(refusal.status);
      expect(res.headers.get('content-type')).toContain('application/json');
      expect(await res.text()).toBe(JSON.stringify(refusal.body));
      expect(upstream.seen).toEqual([
        { method: refusal.method, path: refusal.path, authorization: 'Bot test-token' },
      ]);
    });
  }

  test('401 on a user-token request passes through and leaves the bot token in place', async () => {
    upstream = startUpstream((path) =>
      path === '/users/@me/guilds'
        ? discordJson(401, UNAUTHORIZED)
        : discordJson(200, { id: '456' }),
    );
    const proxyUrl = startProxy(createRest({ token: 'test-token', api: upstream.url }));

    const refused = await fetch(`${proxyUrl}/api/users/@me/guilds`, {
      headers: { 'x-proton-authorization': 'Bearer expired-user-token' },
    });
    expect(refused.status).toBe(401);
    expect(await refused.text()).toBe(JSON.stringify(UNAUTHORIZED));

    const asBot = await fetch(`${proxyUrl}/api/guilds/456`);
    expect(asBot.status).toBe(200);
    expect(await asBot.json()).toEqual({ id: '456' });

    expect(upstream.seen.map((request) => request.authorization)).toEqual([
      'Bearer expired-user-token',
      'Bot test-token',
    ]);
  });

  const tokenRoutes = [
    { method: 'POST', path: '/webhooks/1/tok' },
    { method: 'PATCH', path: '/webhooks/1/tok/messages/@original' },
    { method: 'POST', path: '/interactions/1/tok/callback' },
  ];

  for (const tokenRoute of tokenRoutes) {
    test(`401 on ${tokenRoute.method} ${tokenRoute.path} goes unsigned and leaves the bot token in place`, async () => {
      upstream = startUpstream((path) =>
        path === tokenRoute.path
          ? discordJson(401, INVALID_WEBHOOK_TOKEN)
          : discordJson(200, { id: '456' }),
      );
      const proxyUrl = startProxy(createRest({ token: 'test-token', api: upstream.url }));

      const refused = await fetch(`${proxyUrl}/api${tokenRoute.path}`, {
        method: tokenRoute.method,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: 'x' }),
      });
      expect(refused.status).toBe(401);
      expect(await refused.text()).toBe(JSON.stringify(INVALID_WEBHOOK_TOKEN));

      const asBot = await fetch(`${proxyUrl}/api/guilds/456`);
      expect(asBot.status).toBe(200);
      expect(await asBot.json()).toEqual({ id: '456' });

      expect(upstream.seen).toEqual([
        { method: tokenRoute.method, path: tokenRoute.path, authorization: null },
        { method: 'GET', path: '/guilds/456', authorization: 'Bot test-token' },
      ]);
    });
  }

  test('a non-JSON error body is passed through as bytes, not as "{}"', async () => {
    const html = '<html><body>413 Request Entity Too Large</body></html>';
    upstream = startUpstream(
      () => new Response(html, { status: 413, headers: { 'content-type': 'text/html' } }),
    );
    const proxyUrl = startProxy(createRest({ token: 'test-token', api: upstream.url }));

    const res = await fetch(`${proxyUrl}/api/channels/111/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'x' }),
    });

    expect(res.status).toBe(413);
    expect(await res.text()).toBe(html);
  });
});

describe('signing', () => {
  test('a webhook route without a token in its path is still signed as the bot', async () => {
    upstream = startUpstream(() => discordJson(200, { id: '1' }));
    const proxyUrl = startProxy(createRest({ token: 'test-token', api: upstream.url }));

    const res = await fetch(`${proxyUrl}/api/webhooks/1`);

    expect(res.status).toBe(200);
    expect(upstream.seen).toEqual([
      { method: 'GET', path: '/webhooks/1', authorization: 'Bot test-token' },
    ]);
  });
});

describe('an upstream failure', () => {
  test('a 5xx that outlasts the retries is still 502 rest_proxy_upstream_failure', async () => {
    upstream = startUpstream(
      () =>
        new Response('upstream connect error', { status: 503, statusText: 'Service Unavailable' }),
    );
    const proxyUrl = startProxy(createRest({ token: 'test-token', api: upstream.url }));

    const res = await fetch(`${proxyUrl}/api/guilds/456`);

    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({
      error: 'rest_proxy_upstream_failure',
      message: 'Service Unavailable',
    });
    expect(upstream.seen).toHaveLength(4);
  });

  test('an unreachable upstream is 502 rest_proxy_upstream_failure', async () => {
    const closed = Bun.serve({ port: 0, fetch: () => new Response() });
    const api = `http://127.0.0.1:${closed.port}`;
    await closed.stop(true);
    const proxyUrl = startProxy(createRest({ token: 'test-token', api }));

    const res = await fetch(`${proxyUrl}/api/guilds/456`);

    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: string }).error).toBe('rest_proxy_upstream_failure');
  }, 15_000);

  test('an upstream timeout is 502 rest_proxy_upstream_failure', async () => {
    upstream = startUpstream(async () => {
      await Bun.sleep(1_000);
      return discordJson(200, { id: '456' });
    });
    const rest = new REST({ version: '10', api: upstream.url, timeout: 50, retries: 0 });
    const proxyUrl = startProxy(rest.setToken('test-token'));

    const res = await fetch(`${proxyUrl}/api/guilds/456`);

    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: string }).error).toBe('rest_proxy_upstream_failure');
  });
});

describe('a rate limit the REST client is told to reject', () => {
  test("answers 429 in Discord's shape with a Retry-After header", async () => {
    upstream = startUpstream(() =>
      discordJson(
        429,
        { message: 'You are being rate limited.', retry_after: 1.5, global: false },
        { 'retry-after': '1.5' },
      ),
    );
    const rest = new REST({ version: '10', api: upstream.url, rejectOnRateLimit: ['/'] });
    const proxyUrl = startProxy(rest.setToken('test-token'));

    const res = await fetch(`${proxyUrl}/api/guilds/456`);

    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('2');
    const body = (await res.json()) as { message: string; retry_after: number; global: boolean };
    expect(body.message).toBe('You are being rate limited.');
    expect(body.global).toBe(false);
    expect(body.retry_after).toBeGreaterThanOrEqual(1.5);
    expect(body.retry_after).toBeLessThan(2);
    expect(upstream.seen).toHaveLength(1);
  });
});
