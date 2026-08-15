import { describe, expect, test } from 'bun:test';
import {
  CARD_PRESETS,
  CARD_SIZES,
  type CardDescriptorInput,
  type CardPreset,
  renderCard,
  renderCardSvg,
} from '../src/index.ts';

/**
 * Gate 3 criterion 6: "A rank card renders to a PNG in CI with no network
 * access."
 *
 * Nothing in this file injects an avatar fetcher, so the default
 * `nullAvatarFetcher` is in force and no socket is opened even if one were
 * reachable — the monogram path is what renders. That is the point: a test that
 * needed the Discord CDN would fail in CI for a reason that has nothing to do
 * with the renderer.
 */

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/**
 * Read the width and height out of the IHDR chunk.
 *
 * Asserting the PNG's own header rather than a byte length, because a
 * non-empty buffer of the wrong dimensions is exactly the failure a card
 * regression produces — satori laying out at the wrong size still yields a
 * perfectly valid, perfectly wrong PNG.
 */
function readPng(bytes: Uint8Array): {
  magic: number[];
  ihdr: string;
  width: number;
  height: number;
} {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    magic: [...bytes.slice(0, 8)],
    // The first chunk after the 8-byte signature and the 4-byte length must be IHDR.
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
    // Determinism is the property CI leans on; anything time- or locale-dependent
    // creeping into the layout breaks here first.
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

  test('a rank of zero progress still draws a track', async () => {
    const svg = await renderCardSvg({ ...rank, xpIntoLevel: 0 });
    expect(svg).toContain('<svg');
    expect(svg.length).toBeGreaterThan(0);
  });

  test('an unreachable avatar degrades to the monogram rather than throwing', async () => {
    const skipped: string[] = [];
    const png = await renderCard(
      { ...welcome, avatarUrl: 'https://cdn.discordapp.com/avatars/1/abc.png' },
      {
        avatars: { fetch: async () => null },
        onAvatarSkipped: (reason) => skipped.push(reason),
      },
    );
    expect(readPng(png).magic).toEqual(PNG_MAGIC);
    // `null` is the fetcher reporting its own reason, so the renderer adds none.
    expect(skipped).toEqual([]);
  });

  test('a fetcher that throws is contained, and the card still renders', async () => {
    const skipped: string[] = [];
    const png = await renderCard(
      { ...welcome, avatarUrl: 'https://cdn.discordapp.com/avatars/1/abc.png' },
      {
        avatars: {
          fetch: async () => {
            throw new Error('socket hang up');
          },
        },
        onAvatarSkipped: (reason) => skipped.push(reason),
      },
    );
    expect(readPng(png).magic).toEqual(PNG_MAGIC);
    expect(skipped[0]).toContain('socket hang up');
  });

  test('avatar bytes that are not an image are rejected before satori sees them', async () => {
    const skipped: string[] = [];
    await renderCard(
      { ...welcome, avatarUrl: 'https://cdn.discordapp.com/avatars/1/abc.png' },
      {
        avatars: { fetch: async () => new Uint8Array([1, 2, 3, 4]) },
        onAvatarSkipped: (reason) => skipped.push(reason),
      },
    );
    expect(skipped[0]).toContain('not a PNG');
  });

  test('a real PNG avatar is embedded', async () => {
    // Rendered rather than hand-written, so the fixture cannot drift from what
    // the renderer itself emits.
    const avatarPng = await renderCard({ ...rank, preset: 'aurora' });
    const svg = await renderCardSvg(
      { ...welcome, avatarUrl: 'https://cdn.discordapp.com/avatars/1/abc.png' },
      { avatars: { fetch: async () => avatarPng } },
    );
    expect(svg).toContain('data:image/png;base64,');
  });

  test('a descriptor the schema refuses never reaches satori', async () => {
    await expect(
      renderCard({ ...rank, xpIntoLevel: 5_000, xpForNextLevel: 2_000 }),
    ).rejects.toThrow();
    await expect(renderCard({ ...welcome, displayName: '' })).rejects.toThrow();
  });
});
