import { describe, expect, test } from 'bun:test';
import { type BrandingConfig, brandingConfigSchema, liftStoredConfig } from '../src/config.ts';
import { acceptImage, dataUri, IMAGE_MAX_SIDE, imageDimensions } from '../src/image.ts';
import { AVATAR_MAX_BYTES, BANNER_MAX_BYTES, isAssetKind, maxBytesFor } from '../src/kinds.ts';

function png(size = 16): Uint8Array {
  const bytes = new Uint8Array(size);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return bytes;
}

function sizedPng(width: number, height: number): Uint8Array {
  const bytes = png(24);
  bytes.set([0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52], 8);

  const header = new DataView(bytes.buffer);
  header.setUint32(16, width);
  header.setUint32(20, height);

  return bytes;
}

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

describe('accepting an uploaded image', () => {
  test('takes a PNG and reports it as one, whatever the file was called', () => {
    const result = acceptImage(png(), 'avatar');

    expect(result).toHaveProperty('accepted');
    if (!('accepted' in result)) return;

    expect(result.accepted.contentType).toBe('image/png');
    expect(result.accepted.byteSize).toBe(16);
    expect(dataUri(result.accepted.contentType, result.accepted.base64)).toStartWith(
      'data:image/png;base64,',
    );
  });

  test('gives a different hash to different bytes, so a replacement repaints', () => {
    const first = acceptImage(png(16), 'avatar');
    const second = acceptImage(png(32), 'avatar');

    if (!('accepted' in first) || !('accepted' in second)) throw new Error('both should be taken');

    expect(first.accepted.hash).not.toBe(second.accepted.hash);
  });

  test('refuses a file that is not an image Discord accepts, and says which are', () => {
    const result = acceptImage(new Uint8Array([0x25, 0x50, 0x44, 0x46]), 'avatar');

    expect(result).toEqual({
      refused: 'that file isn’t a PNG, JPEG or GIF, the only formats Discord accepts.',
    });
  });

  test('refuses an empty file rather than sending Discord an empty data URI', () => {
    expect(acceptImage(new Uint8Array(0), 'avatar')).toEqual({ refused: 'that file is empty.' });
  });

  test('refuses an oversized image and names both sizes in the same units', () => {
    const result = acceptImage(png(AVATAR_MAX_BYTES + 1), 'avatar');

    expect(result).toHaveProperty('refused');
    if (!('refused' in result)) return;

    expect(result.refused).toContain('1.0 MB');
    expect(result.refused).toContain('at most 1 MB');
  });

  test('lets a banner be larger than an avatar', () => {
    expect(maxBytesFor('avatar')).toBe(AVATAR_MAX_BYTES);
    expect(maxBytesFor('banner')).toBe(BANNER_MAX_BYTES);
    expect(BANNER_MAX_BYTES).toBeGreaterThan(AVATAR_MAX_BYTES);

    expect(acceptImage(png(AVATAR_MAX_BYTES + 1), 'banner')).toHaveProperty('accepted');
  });

  test('knows only the two kinds Discord has a route for', () => {
    expect(isAssetKind('avatar')).toBe(true);
    expect(isAssetKind('banner')).toBe(true);
    expect(isAssetKind('icon')).toBe(false);
    expect(isAssetKind('__proto__')).toBe(false);
  });
});

describe('reading a declared image size', () => {
  test('reads it from the PNG, GIF and JPEG headers alike', () => {
    expect(imageDimensions(sizedPng(64, 32))).toEqual({ width: 64, height: 32 });
    expect(imageDimensions(sizedGif(64, 32))).toEqual({ width: 64, height: 32 });
    expect(imageDimensions(sizedJpeg(64, 32))).toEqual({ width: 64, height: 32 });
  });

  test('reads a size far larger than any bitmap the bytes could hold', () => {
    expect(imageDimensions(sizedPng(16_000, 16_000))).toEqual({ width: 16_000, height: 16_000 });
  });

  test('gives nothing for a header it cannot read, and never for a file it cannot sniff', () => {
    expect(imageDimensions(png())).toBeNull();
    expect(imageDimensions(sizedPng(64, 32).slice(0, 18))).toBeNull();
    expect(imageDimensions(new Uint8Array([0xff, 0xd8, 0xff]))).toBeNull();
    expect(imageDimensions(new Uint8Array([0x25, 0x50, 0x44, 0x46]))).toBeNull();
    expect(imageDimensions(new Uint8Array(0))).toBeNull();
  });
});

describe('capping an uploaded image’s dimensions', () => {
  test('refuses one larger than Discord would take and names both sizes', () => {
    const result = acceptImage(sizedPng(16_000, 16_000), 'avatar');

    expect(result).toEqual({
      refused: `that image is 16000×16000 pixels, and an avatar can be at most ${IMAGE_MAX_SIDE}×${IMAGE_MAX_SIDE}.`,
    });
  });

  test('takes one right on the cap, and an image whose size it cannot read', () => {
    expect(acceptImage(sizedPng(IMAGE_MAX_SIDE, IMAGE_MAX_SIDE), 'banner')).toHaveProperty(
      'accepted',
    );
    expect(acceptImage(png(), 'avatar')).toHaveProperty('accepted');
  });
});

describe('lifting a config stored before uploads existed', () => {
  test('drops the v1 CDN URLs and keeps everything the admin typed', () => {
    const stored = {
      enabled: true,
      nickname: 'Dreamliner',
      bio: 'The friendly one.',
      avatarUrl: 'https://cdn.discordapp.com/attachments/1/2/avatar.png',
      bannerUrl: 'https://cdn.discordapp.com/attachments/1/3/banner.png',
      restoreOnDisable: false,
    };

    const parsed = brandingConfigSchema.parse(liftStoredConfig(stored));

    expect(parsed).toEqual({
      enabled: true,
      nickname: 'Dreamliner',
      bio: 'The friendly one.',
      restoreOnDisable: false,
      displayNameStyle: null,
    });
  });

  test('leaves a config that never held a URL untouched', () => {
    const stored = { enabled: true, nickname: 'Kestrel', avatarHash: 'abc' };

    expect(brandingConfigSchema.parse(liftStoredConfig(stored))).toEqual({
      enabled: true,
      nickname: 'Kestrel',
      avatarHash: 'abc',
      restoreOnDisable: true,
      displayNameStyle: null,
    });
  });

  test('survives a stored value that is not an object at all', () => {
    expect(liftStoredConfig(null)).toBeNull();
    expect(liftStoredConfig('nonsense')).toBe('nonsense');
  });
});

describe('loading a config saved while look-alike letters existed', () => {
  const STORED: BrandingConfig = {
    enabled: true,
    nickname: 'Dreamliner',
    bio: 'The friendly one.',
    displayNameStyle: { font: 'mainframe', effect: 'neon', colours: [0xff0000] },
    restoreOnDisable: false,
    avatarHash: 'av1',
    bannerHash: 'bn1',
  };

  test('drops typeface whatever it held and keeps every other key, lifted or read raw', () => {
    for (const typeface of ['none', 'bold', 'wide', 'small-caps', '', 42, null, { face: 'bold' }]) {
      const row = { ...STORED, typeface };

      for (const loaded of [
        brandingConfigSchema.safeParse(row),
        brandingConfigSchema.safeParse(liftStoredConfig(row)),
      ]) {
        expect({ typeface, success: loaded.success }).toEqual({ typeface, success: true });
        expect(loaded.data).toEqual(STORED);
        expect(loaded.data).not.toHaveProperty('typeface');
        expect(brandingConfigSchema.parse(loaded.data)).toEqual(STORED);
      }
    }
  });

  test('the lift removes the key before Zod sees it', () => {
    expect(liftStoredConfig({ ...STORED, typeface: 'script' })).toEqual(STORED);
  });
});

describe('the settings form', () => {
  test('offers no field for either image hash, because the upload route writes them', async () => {
    const { brandingFormSchema } = await import('../src/config.ts');
    const keys = Object.keys(brandingFormSchema.shape);

    expect(keys).not.toContain('avatarHash');
    expect(keys).not.toContain('bannerHash');
    expect(keys).not.toContain('typeface');
    expect(keys).toContain('nickname');
    expect(keys).toContain('bio');
  });
});
