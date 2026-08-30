import { describe, expect, test } from 'bun:test';
import { brandingConfigSchema, liftStoredConfig } from '../src/config.ts';
import { acceptImage, dataUri } from '../src/image.ts';
import { AVATAR_MAX_BYTES, BANNER_MAX_BYTES, isAssetKind, maxBytesFor } from '../src/kinds.ts';

function png(size = 16): Uint8Array {
  const bytes = new Uint8Array(size);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
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
      refused: 'that file is not a PNG, JPEG or GIF. Discord accepts no other format.',
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
      typeface: 'none',
      nameEffect: 'none',
      primaryColor: 0x0ab9fe,
      secondaryColor: 0x5944ec,
    });
  });

  test('leaves a config that never held a URL untouched', () => {
    const stored = { enabled: true, nickname: 'Kestrel', avatarHash: 'abc' };

    expect(brandingConfigSchema.parse(liftStoredConfig(stored))).toEqual({
      enabled: true,
      nickname: 'Kestrel',
      avatarHash: 'abc',
      restoreOnDisable: true,
      typeface: 'none',
      nameEffect: 'none',
      primaryColor: 0x0ab9fe,
      secondaryColor: 0x5944ec,
    });
  });

  test('survives a stored value that is not an object at all', () => {
    expect(liftStoredConfig(null)).toBeNull();
    expect(liftStoredConfig('nonsense')).toBe('nonsense');
  });
});

describe('the settings form', () => {
  test('offers no field for either image hash, because the upload route writes them', async () => {
    const { brandingFormSchema } = await import('../src/config.ts');
    const keys = Object.keys(brandingFormSchema.shape);

    expect(keys).not.toContain('avatarHash');
    expect(keys).not.toContain('bannerHash');
    expect(keys).toContain('nickname');
    expect(keys).toContain('bio');
  });
});
