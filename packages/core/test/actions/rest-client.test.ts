import { afterEach, describe, expect, test } from 'bun:test';
import {
  HttpRestProxyClient,
  type RestRequestOptions,
  RestTimeoutError,
} from '../../src/actions/rest-client.ts';

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

  test('sends no abort signal unless the caller sets a timeout', async () => {
    const { captured } = captureFetch();

    await send({ body: {} });

    expect(captured[0]?.init.signal).toBeUndefined();
  });

  test('a request that answers in time is untouched by its timeout', async () => {
    const { captured } = captureFetch();

    expect(await send({ body: {}, timeoutMs: 5_000 })).toEqual({ status: 200, body: { ok: true } });
    expect(captured[0]?.init.signal).toBeInstanceOf(AbortSignal);
  });

  test('a finished request cancels its timer instead of aborting after the fact', async () => {
    const { captured } = captureFetch();

    await send({ body: {}, timeoutMs: 20 });
    await Bun.sleep(60);

    expect(captured[0]?.init.signal?.aborted).toBe(false);
  });

  test('a request that outlives its timeout rejects with a typed error naming the route', async () => {
    globalThis.fetch = ((_url: string | URL | Request, init: RequestInit = {}) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(init.signal?.reason));
      })) as typeof fetch;

    const outcome = client.request({
      method: 'PUT',
      path: '/applications/1/guilds/2/commands',
      body: [],
      timeoutMs: 20,
    });

    await expect(outcome).rejects.toBeInstanceOf(RestTimeoutError);
    await expect(outcome).rejects.toMatchObject({
      name: 'RestTimeoutError',
      method: 'PUT',
      path: '/applications/1/guilds/2/commands',
      timeoutMs: 20,
    });
    await expect(outcome).rejects.toThrow(
      'The rest-proxy did not answer PUT /applications/1/guilds/2/commands within 20 ms. ' +
        'Discord may still have applied the request.',
    );
  });

  test('any other failure is passed through as it was', async () => {
    const offline = new TypeError('fetch failed');
    globalThis.fetch = (async () => {
      throw offline;
    }) as unknown as typeof fetch;

    await expect(send({ body: {}, timeoutMs: 5_000 })).rejects.toBe(offline);
  });
});
