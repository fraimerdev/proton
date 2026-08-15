import { afterEach, describe, expect, test } from 'bun:test';
import { HttpRestProxyClient, type RestRequestOptions } from '../../src/actions/rest-client.ts';

const realFetch = globalThis.fetch;

interface Captured {
  url: string;
  init: RequestInit;
}

function captureFetch(): { captured: Captured[] } {
  const captured: Captured[] = [];

  globalThis.fetch = (async (url: string | URL | Request, init: RequestInit = {}) => {
    captured.push({ url: String(url), init });
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;

  return { captured };
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

const client = new HttpRestProxyClient('http://proxy.local');

function send(options: Partial<RestRequestOptions> = {}): Promise<unknown> {
  return client.request({ method: 'POST', path: '/channels/1/messages', ...options });
}

describe('HttpRestProxyClient', () => {
  test('sends JSON when there are no files', async () => {
    const { captured } = captureFetch();

    await send({ body: { content: 'hi' } });

    const headers = captured[0]?.init.headers as Record<string, string>;
    expect(headers['content-type']).toBe('application/json');
    expect(captured[0]?.init.body).toBe('{"content":"hi"}');
  });

  test('addresses the proxy, never discord.com (I2)', async () => {
    const { captured } = captureFetch();

    await send({ body: {} });

    expect(captured[0]?.url).toBe('http://proxy.local/api/channels/1/messages');
  });

  test('forwards headers verbatim, so the audit-log reason survives', async () => {
    const { captured } = captureFetch();

    await send({ body: {}, headers: { 'x-audit-log-reason': 'spamming' } });

    const headers = captured[0]?.init.headers as Record<string, string>;
    expect(headers['x-audit-log-reason']).toBe('spamming');
  });

  test('switches to multipart when files are present', async () => {
    const { captured } = captureFetch();

    await send({
      body: { content: 'card', attachments: [{ id: 0, filename: 'rank.png' }] },
      files: [
        {
          name: 'files[0]',
          filename: 'rank.png',
          contentType: 'image/png',
          data: new Uint8Array([137, 80, 78, 71]),
        },
      ],
    });

    const body = captured[0]?.init.body;
    expect(body).toBeInstanceOf(FormData);

    const form = body as FormData;
    expect(form.get('payload_json')).toBe(
      '{"content":"card","attachments":[{"id":0,"filename":"rank.png"}]}',
    );

    const part = form.get('files[0]');
    expect(part).toBeInstanceOf(Blob);
    expect((part as File).name).toBe('rank.png');
    expect((part as Blob).type).toBe('image/png');
  });

  test('does not set content-type on a multipart request', async () => {
    const { captured } = captureFetch();

    await send({
      body: {},
      files: [
        {
          name: 'files[0]',
          filename: 'a.png',
          contentType: 'image/png',
          data: new Uint8Array([1]),
        },
      ],
    });

    const headers = captured[0]?.init.headers as Record<string, string>;
    expect(headers['content-type']).toBeUndefined();
  });

  test('an empty file list stays JSON', async () => {
    const { captured } = captureFetch();

    await send({ body: { content: 'hi' }, files: [] });

    const headers = captured[0]?.init.headers as Record<string, string>;
    expect(headers['content-type']).toBe('application/json');
  });

  test('parses a JSON response body', async () => {
    captureFetch();

    expect(await send({ body: {} })).toEqual({ status: 200, body: { ok: true } });
  });
});
