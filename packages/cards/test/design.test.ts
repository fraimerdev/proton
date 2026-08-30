import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CardDescriptorInput } from '../src/index.ts';
import { renderSvg } from '../src/render.tsx';

const DESIGN = join(import.meta.dir, '..', 'src', 'design');

function designSources(): Array<[string, string]> {
  return readdirSync(DESIGN)
    .filter((name) => /\.tsx?$/.test(name))
    .map((name) => [name, readFileSync(join(DESIGN, name), 'utf8')]);
}

const rank: CardDescriptorInput = {
  kind: 'rank',
  displayName: 'Fraimer',
  level: 12,
  rank: 1,
  totalXp: 48_210,
  xpIntoLevel: 1_240,
  xpForNextLevel: 2_000,
};

describe('the card design stays inside satori', () => {
  /**
   * `boxShadow` on an element that also has a `borderRadius`, inside a root that clips with
   * `overflow: hidden`, panics resvg 2.6.2 in geom.rs and takes the whole process down — not a
   * catchable exception, an abort. A worker that renders one /rank card dies. Glow with a
   * gradient layer instead.
   */
  test('nothing casts a box shadow', () => {
    for (const [name, source] of designSources()) {
      expect(`${name}: ${source.includes('boxShadow')}`).toBe(`${name}: false`);
    }
  });

  // satori laid the name row out 89px tall where Chrome made it 66, because the two implement
  // baseline alignment differently. Mixed type sizes bottom-align and lift by baselineLift().
  test('nothing aligns to a baseline', () => {
    for (const [name, source] of designSources()) {
      expect(`${name}: ${source.includes("alignItems: 'baseline'")}`).toBe(`${name}: false`);
    }
  });

  // Left at 'normal' the line box comes from font metrics, and satori and a browser round it
  // differently — a pixel per box, which is how the PNG and the live preview drift apart.
  test('every type size declares its line height', () => {
    for (const [name, source] of designSources()) {
      const sizes = source.match(/fontSize:/g)?.length ?? 0;
      const heights = source.match(/lineHeight:/g)?.length ?? 0;

      expect(`${name}: ${heights >= sizes}`).toBe(`${name}: true`);
    }
  });

  /**
   * text-overflow does not apply to the anonymous item a flex container wraps its text in, so a
   * flex box with overflow:hidden + whiteSpace:nowrap ellipsises in satori and hard-clips
   * mid-glyph in Chrome. Every truncation goes through one block-display helper.
   */
  test('truncation happens on a block, never on a flex box', () => {
    for (const [name, source] of designSources()) {
      const lines = source.split('\n');
      const offenders = lines
        .map((line, index) => ({ line, index }))
        .filter(({ line }) => line.includes('textOverflow'))
        .filter(
          ({ index }) =>
            !lines.slice(Math.max(0, index - 4), index).some((l) => l.includes("display: 'block'")),
        )
        .map(({ index }) => `${name}:${index + 1}`);

      expect(offenders).toEqual([]);
    }
  });

  test('the design half never reaches the rasterising half', () => {
    const forbidden = ['@napi-rs/canvas', 'satori', '@resvg/resvg-js', 'node:fs'];

    for (const [name, source] of designSources()) {
      const imports = [...source.matchAll(/from '([^']+)'/g)].map((match) => match[1]);
      expect(`${name}: ${imports.filter((s) => forbidden.includes(s ?? ''))}`).toBe(`${name}: `);
    }
  });
});

describe('a guild name the fonts cannot draw', () => {
  // "joined " survives sanitising on its own, so sanitising the whole sentence can never reach the
  // fallback — a Japanese server name used to leave the card saying nothing but "joined".
  test('falls back to a sentence rather than to half of one', async () => {
    const greeting = { kind: 'welcome', displayName: 'Fraimer', memberCount: 12 } as const;

    const [unrenderable, spelled] = await Promise.all([
      renderSvg({ ...greeting, guildName: '日本語のサーバー' }),
      renderSvg({ ...greeting, guildName: 'this server' }),
    ]);

    expect(unrenderable).toBe(spelled);
  });
});

describe('rank is a number, not a medal', () => {
  const MEDALS = ['#ffd700', '#c0c0c0', '#cd7f32'];

  test.each([1, 2, 3])('rank %i is drawn in the guild accent like any other', async (place) => {
    const svg = (await renderSvg({ ...rank, rank: place, accent: '#317ff5' })).toLowerCase();

    expect(MEDALS.filter((medal) => svg.includes(medal))).toEqual([]);
    expect(svg).toContain('#317ff5');
  });

  test('the podium and the pack are drawn identically apart from the number', async () => {
    const [first, four_hundredth] = await Promise.all([
      renderSvg({ ...rank, rank: 1 }),
      renderSvg({ ...rank, rank: 400 }),
    ]);

    const fills = (svg: string) => [...svg.matchAll(/fill="([^"]+)"/g)].map((match) => match[1]);

    expect(new Set(fills(first))).toEqual(new Set(fills(four_hundredth)));
  });
});
