import { describe, expect, test } from 'bun:test';
import {
  AVATAR_MAX_BYTES,
  discordAvatarUrl,
  type FetchLike,
  HttpAvatarFetcher,
  toDataUri,
} from '../src/index.ts';

/**
 * The guards around the one place `@proton/cards` touches the network.
 *
 * `fetchImpl` is injected everywhere below, so nothing here opens a socket (I11).
 * The point is not that fetch works — it is that the four containments the I2
 * decision rests on (host allowlist, byte cap, timeout, content-type) actually
 * fire, because that decision is only defensible if they do.
 */

function response(
  body: Uint8Array,
  init: { status?: number; contentType?: string; contentLength?: string } = {},
): Response {
  const headers = new Headers();
  headers.set('content-type', init.contentType ?? 'image/png');
  if (init.contentLength !== undefined) headers.set('content-length', init.contentLength);
  return new Response(body, { status: init.status ?? 200, headers });
}

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);

function fetcher(
  impl: FetchLike,
  options: { maxBytes?: number } = {},
): { fetch: HttpAvatarFetcher; skips: string[] } {
  const skips: string[] = [];
  return {
    fetch: new HttpAvatarFetcher({
      fetchImpl: impl,
      onSkip: (reason) => skips.push(reason),
      ...(options.maxBytes === undefined ? {} : { maxBytes: options.maxBytes }),
    }),
    skips,
  };
}

describe('HttpAvatarFetcher', () => {
  test('fetches a PNG from the Discord CDN', async () => {
    const { fetch, skips } = fetcher(async () => response(PNG_BYTES));
    const bytes = await fetch.fetch(discordAvatarUrl('1', 'abc'));
    expect(bytes).toEqual(PNG_BYTES);
    expect(skips).toEqual([]);
  });

  test.each([
    ['an arbitrary host', 'https://evil.example.com/avatars/1/abc.png'],
    ['plain http', 'http://cdn.discordapp.com/avatars/1/abc.png'],
    // The SSRF shape that matters: the avatar hash is user-influenced upstream.
    ['a subdomain-lookalike', 'https://cdn.discordapp.com.evil.example/a.png'],
    ['the loopback interface', 'https://127.0.0.1/a.png'],
  ])('refuses %s without calling fetch', async (_label, url) => {
    let called = false;
    const { fetch, skips } = fetcher(async () => {
      called = true;
      return response(PNG_BYTES);
    });

    expect(await fetch.fetch(url)).toBeNull();
    expect(called).toBe(false);
    expect(skips[0]).toContain('refused to fetch an avatar');
  });

  test('refuses a URL that is not a URL', async () => {
    const { fetch, skips } = fetcher(async () => response(PNG_BYTES));
    expect(await fetch.fetch('not a url')).toBeNull();
    expect(skips[0]).toContain('not a URL');
  });

  test('refuses WebP, naming the fix', async () => {
    const { fetch, skips } = fetcher(async () =>
      response(PNG_BYTES, { contentType: 'image/webp' }),
    );
    expect(await fetch.fetch(discordAvatarUrl('1', 'abc'))).toBeNull();
    // §1: an error names what is wrong and where. WebP is the CDN default, so
    // this is the failure a caller building the URL by hand will actually hit.
    expect(skips[0]).toContain('.png extension');
  });

  test('refuses a declared length over the cap before reading the body', async () => {
    const { fetch, skips } = fetcher(async () =>
      response(PNG_BYTES, { contentLength: String(AVATAR_MAX_BYTES + 1) }),
    );
    expect(await fetch.fetch(discordAvatarUrl('1', 'abc'))).toBeNull();
    expect(skips[0]).toContain('over the cap');
  });

  test('enforces the cap while streaming, against a lying content-length', async () => {
    // The case a header check alone misses: the origin claims 9 bytes and sends
    // far more. Without the streaming guard this is an unbounded allocation.
    const { fetch, skips } = fetcher(
      async () => response(new Uint8Array(4_096), { contentLength: '9' }),
      { maxBytes: 512 },
    );
    expect(await fetch.fetch(discordAvatarUrl('1', 'abc'))).toBeNull();
    expect(skips[0]).toContain('exceeded the 512-byte cap');
  });

  test('a non-200 degrades rather than throwing', async () => {
    const { fetch, skips } = fetcher(async () => response(PNG_BYTES, { status: 404 }));
    expect(await fetch.fetch(discordAvatarUrl('1', 'abc'))).toBeNull();
    expect(skips[0]).toContain('404');
  });

  test('a transport failure degrades rather than throwing', async () => {
    const { fetch, skips } = fetcher(async () => {
      throw new Error('ETIMEDOUT');
    });
    expect(await fetch.fetch(discordAvatarUrl('1', 'abc'))).toBeNull();
    expect(skips[0]).toContain('ETIMEDOUT');
  });
});

describe('discordAvatarUrl', () => {
  test('asks the CDN for a PNG, because satori cannot decode WebP', () => {
    expect(discordAvatarUrl('123', 'deadbeef')).toBe(
      'https://cdn.discordapp.com/avatars/123/deadbeef.png?size=256',
    );
  });
});

describe('toDataUri', () => {
  test.each([
    ['png', [0x89, 0x50, 0x4e, 0x47], 'data:image/png;base64,'],
    ['jpeg', [0xff, 0xd8, 0xff], 'data:image/jpeg;base64,'],
    ['gif', [0x47, 0x49, 0x46, 0x38], 'data:image/gif;base64,'],
  ])('sniffs %s from its magic bytes', (_label, magic, prefix) => {
    expect(toDataUri(new Uint8Array(magic))).toStartWith(prefix);
  });

  test('rejects bytes that are not an image the renderer can embed', () => {
    expect(toDataUri(new Uint8Array([0x52, 0x49, 0x46, 0x46]))).toBeNull();
  });
});
