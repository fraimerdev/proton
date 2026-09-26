import { describe, expect, test } from 'bun:test';
import {
  discordAvatarUrl,
  type FetchLike,
  HttpImageFetcher,
  IMAGE_MAX_BYTES,
  IMAGE_MAX_SIDE,
  imageDimensions,
  isRenderableImage,
  oversizedImage,
} from '../src/index.ts';
import { sizedPng } from './png.ts';

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
): { fetch: HttpImageFetcher; skips: string[] } {
  const skips: string[] = [];
  return {
    fetch: new HttpImageFetcher({
      fetchImpl: impl,
      onSkip: (reason) => skips.push(reason),
      ...(options.maxBytes === undefined ? {} : { maxBytes: options.maxBytes }),
    }),
    skips,
  };
}

describe('HttpImageFetcher', () => {
  test('fetches a PNG from the Discord CDN', async () => {
    const { fetch, skips } = fetcher(async () => response(PNG_BYTES));
    const bytes = await fetch.fetch(discordAvatarUrl('1', 'abc'));
    expect(bytes).toEqual(PNG_BYTES);
    expect(skips).toEqual([]);
  });

  test.each([
    ['an arbitrary host', 'https://evil.example.com/avatars/1/abc.png'],
    ['plain http', 'http://cdn.discordapp.com/avatars/1/abc.png'],

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
    expect(skips[0]).toContain('refused to fetch a card image');
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

    expect(skips[0]).toContain('.png extension');
  });

  test('refuses a declared length over the cap before reading the body', async () => {
    const { fetch, skips } = fetcher(async () =>
      response(PNG_BYTES, { contentLength: String(IMAGE_MAX_BYTES + 1) }),
    );
    expect(await fetch.fetch(discordAvatarUrl('1', 'abc'))).toBeNull();
    expect(skips[0]).toContain('over the cap');
  });

  test('enforces the cap while streaming, against a lying content-length', async () => {
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
  test('asks the CDN for a PNG, at a size the 216px avatar circle can use', () => {
    expect(discordAvatarUrl('123', 'deadbeef')).toBe(
      'https://cdn.discordapp.com/avatars/123/deadbeef.png?size=256',
    );
  });
});

describe('isRenderableImage', () => {
  test.each([
    ['png', [0x89, 0x50, 0x4e, 0x47]],
    ['jpeg', [0xff, 0xd8, 0xff]],
    ['gif', [0x47, 0x49, 0x46, 0x38]],
  ])('sniffs %s from its magic bytes', (_label, magic) => {
    expect(isRenderableImage(new Uint8Array(magic))).toBe(true);
  });

  test('rejects bytes that are not an image the renderer can draw', () => {
    expect(isRenderableImage(new Uint8Array([0x52, 0x49, 0x46, 0x46]))).toBe(false);
  });
});

function sizedGif(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(10);
  bytes.set([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);

  const header = new DataView(bytes.buffer);
  header.setUint16(6, width, true);
  header.setUint16(8, height, true);

  return bytes;
}

function sizedJpeg(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(20);
  bytes.set([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08]);

  const header = new DataView(bytes.buffer);
  header.setUint16(13, height);
  header.setUint16(15, width);

  return bytes;
}

describe('imageDimensions', () => {
  test('reads the size a PNG, GIF or JPEG header declares', () => {
    expect(imageDimensions(sizedPng(640, 480))).toEqual({ width: 640, height: 480 });
    expect(imageDimensions(sizedGif(640, 480))).toEqual({ width: 640, height: 480 });
    expect(imageDimensions(sizedJpeg(640, 480))).toEqual({ width: 640, height: 480 });
    expect(imageDimensions(sizedPng(16_000, 16_000))).toEqual({ width: 16_000, height: 16_000 });
  });

  test('is null when nothing declares one, and is never a decode', () => {
    expect(imageDimensions(PNG_BYTES)).toBeNull();
    expect(imageDimensions(sizedPng(64, 64).slice(0, 18))).toBeNull();
    expect(imageDimensions(new Uint8Array([0x52, 0x49, 0x46, 0x46]))).toBeNull();
    expect(imageDimensions(new Uint8Array(0))).toBeNull();
  });
});

describe('oversizedImage', () => {
  test('names the size of an image past the cap, and passes one at it', () => {
    expect(oversizedImage(sizedPng(IMAGE_MAX_SIDE + 1, 8))).toEqual({
      width: IMAGE_MAX_SIDE + 1,
      height: 8,
    });
    expect(oversizedImage(sizedPng(IMAGE_MAX_SIDE, IMAGE_MAX_SIDE))).toBeNull();
    expect(oversizedImage(sizedPng(2_048, 2_048), 1_024)).toEqual({ width: 2_048, height: 2_048 });
  });

  // Refusing these would break every fixture that carries only a magic number, and they are no
  // bomb: resvg sizes its buffer from the same field and cannot draw them either.
  test('lets a header it cannot read through', () => {
    expect(oversizedImage(PNG_BYTES)).toBeNull();
    expect(oversizedImage(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBeNull();
  });
});
