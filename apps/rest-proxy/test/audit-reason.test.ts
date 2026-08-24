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

function startProxy(api: string): string {
  const rest = createRest({ token: 'test-token', api });
  const app = createProxyApp(rest);
  proxy = Bun.serve({ port: 0, fetch: app.fetch });
  return `http://localhost:${proxy.port}`;
}

function ban(proxyUrl: string, headers: Record<string, string>): Promise<Response> {
  return fetch(`${proxyUrl}/api/guilds/456/bans/789`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ delete_message_seconds: 604800 }),
  });
}

describe('audit-log reason', () => {
  test('reaches Discord instead of being dropped at the proxy', async () => {
    upstream = startMockUpstream();
    const proxyUrl = startProxy(upstream.url);

    const res = await ban(proxyUrl, { 'x-audit-log-reason': 'honeypot%20trip' });

    expect(res.status).toBe(200);
    expect(upstream.requests[0]?.headers['x-audit-log-reason']).toBe('honeypot%20trip');
  });

  test('is forwarded verbatim, never percent-encoded a second time', async () => {
    upstream = startMockUpstream();
    const proxyUrl = startProxy(upstream.url);

    const reason = 'raid cleanup — wave 2 (100% of it)';
    await ban(proxyUrl, { 'x-audit-log-reason': encodeURIComponent(reason) });

    const seen = upstream.requests[0]?.headers['x-audit-log-reason'] ?? '';
    expect(seen).toBe(encodeURIComponent(reason));
    expect(decodeURIComponent(seen)).toBe(reason);
  });

  test('rides along with a caller token override without displacing it', async () => {
    upstream = startMockUpstream();
    const proxyUrl = startProxy(upstream.url);

    await ban(proxyUrl, {
      'x-proton-authorization': 'Bearer dashboard-token',
      'x-audit-log-reason': 'dashboard%20action',
    });

    const headers = upstream.requests[0]?.headers;
    expect(headers?.authorization).toBe('Bearer dashboard-token');
    expect(headers?.['x-audit-log-reason']).toBe('dashboard%20action');
  });

  test('is absent upstream when the caller sends none', async () => {
    upstream = startMockUpstream();
    const proxyUrl = startProxy(upstream.url);

    await ban(proxyUrl, {});

    expect(upstream.requests[0]?.headers['x-audit-log-reason']).toBeUndefined();
    expect(upstream.requests[0]?.headers.authorization).toBe('Bot test-token');
  });
});
