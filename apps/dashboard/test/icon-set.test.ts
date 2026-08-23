import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { GENERATED_PATH, generate, renderableNames } from '../scripts/build-icons.ts';
import { ICONS } from '../src/components/shell/icon-set.gen.ts';

describe('the generated icon set', () => {
  // The whole point of a subset is that it can go stale. Regenerating and comparing is the only
  // check that cannot itself drift, because it runs the generator the committed file came from.
  test('is what the generator produces from the current source', () => {
    expect(generate()).toBe(readFileSync(GENERATED_PATH, 'utf8'));
  });

  test('covers every name the app can hand an Icon', () => {
    expect(renderableNames()).toEqual(Object.keys(ICONS).sort());
  });

  test('carries both weights for every icon, since either can be asked for at runtime', () => {
    for (const [name, weights] of Object.entries(ICONS)) {
      expect(`${name}: ${Object.keys(weights).sort().join(',')}`).toBe(`${name}: fill,regular`);
    }
  });

  test('holds path data, not markup, so Icon never sets innerHTML', () => {
    for (const [name, weights] of Object.entries(ICONS)) {
      for (const [weight, d] of Object.entries(weights)) {
        expect(`${name}/${weight}: ${d.includes('<')}`).toBe(`${name}/${weight}: false`);
        expect(d.length).toBeGreaterThan(10);
      }
    }
  });

  test('is worth having: the font it replaced carried far more than this', () => {
    expect(Object.keys(ICONS).length).toBeLessThan(200);
    expect(Buffer.byteLength(JSON.stringify(ICONS), 'utf8')).toBeLessThan(60_000);
  });
});

describe('nothing reaches for the icon font any more', () => {
  const root = readFileSync(new URL('../src/routes/__root.tsx', import.meta.url), 'utf8');
  const icon = readFileSync(new URL('../src/components/shell/icon.tsx', import.meta.url), 'utf8');

  test('the head loads no Phosphor stylesheet and preloads no Phosphor font', () => {
    expect(root).not.toContain('phosphor');
    expect(root).not.toContain('jsdelivr');
  });

  test('and Icon draws an svg rather than a font glyph', () => {
    expect(icon).toContain('<path d={ICONS[name][weight]} />');
    expect(icon).not.toContain('ph-');
  });
});
