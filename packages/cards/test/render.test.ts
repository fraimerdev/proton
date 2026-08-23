import { describe, expect, test } from 'bun:test';
import {
  CARD_PRESETS,
  CARD_SIZES,
  type CardDescriptorInput,
  type CardPreset,
  renderCard,
} from '../src/index.ts';

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function readPng(bytes: Uint8Array): {
  magic: number[];
  ihdr: string;
  width: number;
  height: number;
} {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    magic: [...bytes.slice(0, 8)],

    ihdr: String.fromCharCode(...bytes.slice(12, 16)),
    width: view.getUint32(16),
    height: view.getUint32(20),
  };
}

const rank: CardDescriptorInput = {
  kind: 'rank',
  displayName: 'Fraimer',
  level: 12,
  rank: 3,
  totalXp: 48_210,
  xpIntoLevel: 1_240,
  xpForNextLevel: 2_000,
};

const welcome: CardDescriptorInput = {
  kind: 'welcome',
  displayName: 'Fraimer',
  guildName: 'Proton Test Guild',
  memberCount: 1_204,
};

const goodbye: CardDescriptorInput = { ...welcome, kind: 'goodbye' };

const CDN_IMAGE = 'https://cdn.discordapp.com/avatars/1/abc.png';

describe('renderCard', () => {
  test.each([
    ['rank', rank],
    ['welcome', welcome],
    ['goodbye', goodbye],
  ] as const)('%s renders a PNG at the declared size', async (kind, descriptor) => {
    const png = await renderCard(descriptor);
    const header = readPng(png);

    expect(png.byteLength).toBeGreaterThan(0);
    expect(header.magic).toEqual(PNG_MAGIC);
    expect(header.ihdr).toBe('IHDR');
    expect({ width: header.width, height: header.height }).toEqual(CARD_SIZES[kind]);
  });

  test('every preset renders, so none can rot behind the default', async () => {
    for (const preset of CARD_PRESETS) {
      const png = await renderCard({ ...rank, preset });
      expect(readPng(png).magic).toEqual(PNG_MAGIC);
    }
  });

  test('the same descriptor renders byte-identically twice', async () => {
    const [a, b] = await Promise.all([renderCard(rank), renderCard(rank)]);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
  });

  test('presets differ from one another', async () => {
    const rendered = await Promise.all(
      CARD_PRESETS.map(async (preset: CardPreset) =>
        Buffer.from(await renderCard({ ...rank, preset })).toString('base64'),
      ),
    );
    expect(new Set(rendered).size).toBe(CARD_PRESETS.length);
  });

  test('a guild accent changes the picture, so the setting is not decorative', async () => {
    const [plain, tinted] = await Promise.all([
      renderCard({ ...welcome, preset: 'midnight' }),
      renderCard({ ...welcome, preset: 'midnight', accent: '#ff5c8a' }),
    ]);

    expect(Buffer.from(plain).equals(Buffer.from(tinted))).toBe(false);
  });

  test.each([
    ['showRank', { ...rank, showRank: false }],
    ['showPercent', { ...rank, showPercent: false }],
    ['showTotalXp', { ...rank, showTotalXp: false }],
    ['showMemberCount', { ...welcome, showMemberCount: false }],
  ] as const)('switching %s off changes the picture', async (_label, descriptor) => {
    const base = descriptor.kind === 'rank' ? rank : welcome;
    const [shown, hidden] = await Promise.all([renderCard(base), renderCard(descriptor)]);

    expect(Buffer.from(shown).equals(Buffer.from(hidden))).toBe(false);
  });

  test('zero progress still draws the track rather than a naked card', async () => {
    const [empty, some] = await Promise.all([
      renderCard({ ...rank, xpIntoLevel: 0 }),
      renderCard(rank),
    ]);

    expect(readPng(empty).magic).toEqual(PNG_MAGIC);
    expect(Buffer.from(empty).equals(Buffer.from(some))).toBe(false);
  });

  test('an unreachable avatar degrades to the monogram rather than throwing', async () => {
    const skipped: string[] = [];
    const png = await renderCard(
      { ...welcome, avatarUrl: CDN_IMAGE },
      { images: { fetch: async () => null }, onImageSkipped: (reason) => skipped.push(reason) },
    );
    expect(readPng(png).magic).toEqual(PNG_MAGIC);

    expect(skipped).toEqual([]);
  });

  test('a fetcher that throws is contained, and the card still renders', async () => {
    const skipped: string[] = [];
    const png = await renderCard(
      { ...welcome, avatarUrl: CDN_IMAGE },
      {
        images: {
          fetch: async () => {
            throw new Error('socket hang up');
          },
        },
        onImageSkipped: (reason) => skipped.push(reason),
      },
    );
    expect(readPng(png).magic).toEqual(PNG_MAGIC);
    expect(skipped[0]).toContain('socket hang up');
  });

  test('bytes that are not an image are rejected before the decoder sees them', async () => {
    const skipped: string[] = [];
    await renderCard(
      { ...welcome, avatarUrl: CDN_IMAGE },
      {
        images: { fetch: async () => new Uint8Array([1, 2, 3, 4]) },
        onImageSkipped: (reason) => skipped.push(reason),
      },
    );
    expect(skipped[0]).toContain('not a PNG');
  });

  test('a real PNG avatar is drawn, not silently dropped', async () => {
    const avatar = await renderCard({ ...rank, preset: 'aurora' });
    const skipped: string[] = [];

    const [plain, withAvatar] = await Promise.all([
      renderCard(welcome),
      renderCard(
        { ...welcome, avatarUrl: CDN_IMAGE },
        { images: { fetch: async () => avatar }, onImageSkipped: (r) => skipped.push(r) },
      ),
    ]);

    expect(skipped).toEqual([]);
    expect(Buffer.from(plain).equals(Buffer.from(withAvatar))).toBe(false);
  });

  test('a background image is drawn behind the card', async () => {
    const backdrop = await renderCard({ ...rank, preset: 'parchment' });

    const [plain, withBackground] = await Promise.all([
      renderCard(welcome),
      renderCard(
        { ...welcome, backgroundUrl: CDN_IMAGE },
        { images: { fetch: async () => backdrop } },
      ),
    ]);

    expect(Buffer.from(plain).equals(Buffer.from(withBackground))).toBe(false);
  });

  test('a descriptor the schema refuses never reaches the canvas', async () => {
    await expect(
      renderCard({ ...rank, xpIntoLevel: 5_000, xpForNextLevel: 2_000 }),
    ).rejects.toThrow();
    await expect(renderCard({ ...welcome, displayName: '' })).rejects.toThrow();
    await expect(renderCard({ ...welcome, accent: 'rebeccapurple' })).rejects.toThrow();
  });
});
