import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FONT_STACK } from '@proton/cards/design';
import { callbackFor, DEFAULT_CALLBACK } from '../src/lib/callback-url.ts';

const SRC = join(import.meta.dir, '..', 'src');

const root = readFileSync(join(SRC, 'routes', '__root.tsx'), 'utf8');
const routeTree = readFileSync(join(SRC, 'routeTree.gen.ts'), 'utf8');
const signIn = readFileSync(join(SRC, 'routes', 'api', 'auth', 'signin', 'discord.ts'), 'utf8');

function headOrigins(): string[] {
  return [...root.matchAll(/https:\/\/([a-z0-9.-]+)/g)].map((match) => match[1] ?? '');
}

describe('third-party origins in the critical path', () => {
  // Two render-blocking Phosphor stylesheets and 315 kB of icon webfont used to sit here for the
  // 76 glyphs this app draws. They are now paths in the bundle; only the text fonts remain.
  test('the only origin left is the one serving the text fonts', () => {
    expect([...new Set(headOrigins())].sort()).toEqual([
      'fonts.googleapis.com',
      'fonts.gstatic.com',
    ]);
  });

  test('every origin the head reaches for is preconnected first', () => {
    const preconnected = [...root.matchAll(/rel: 'preconnect', href: 'https:\/\/([a-z0-9.-]+)'/g)]
      .map((match) => match[1] ?? '')
      .sort();

    expect([...new Set(headOrigins())].sort()).toEqual(preconnected);
  });

  test('the preconnects come before anything that uses them', () => {
    const lastPreconnect = root.lastIndexOf("rel: 'preconnect'");
    const firstFetch = Math.min(
      ...["rel: 'preload'", "rel: 'stylesheet'"]
        .map((needle) => root.indexOf(needle))
        .filter((at) => at >= 0),
    );

    expect(lastPreconnect).toBeLessThan(firstFetch);
  });

  test('the text fonts still swap rather than block first paint', () => {
    expect(root).toContain('display=swap');
  });
});

describe('where Discord sends you back to', () => {
  test('the sign-in route asks callbackFor, so the guard below is the one that runs', () => {
    expect(signIn).toContain('callbackURL: callbackFor(request.url)');
  });

  test('by default the guild picker, not the door the visitor just came through', () => {
    expect(callbackFor('http://localhost:3000/api/auth/signin/discord')).toBe(DEFAULT_CALLBACK);
  });

  test('the default names a route that exists', () => {
    expect(`${DEFAULT_CALLBACK} is a route: ${routeTree.includes(`'${DEFAULT_CALLBACK}'`)}`).toBe(
      `${DEFAULT_CALLBACK} is a route: true`,
    );
  });

  test('a verify link comes back to itself so the member finishes where they started', () => {
    const target = '/verify/abc.def';

    expect(callbackFor(`http://localhost:3000/x?redirect=${encodeURIComponent(target)}`)).toBe(
      target,
    );
  });

  // A fresh session cookie is set on this hop, so an accepted off-site redirect hands it away.
  test.each([
    '//evil.example',
    '/\\evil.example',
    'https://evil.example',
    'http://evil.example/path',
    'evil.example',
    '',
  ])('refuses %p and falls back to the guild picker', (redirect) => {
    expect(callbackFor(`http://localhost:3000/x?redirect=${encodeURIComponent(redirect)}`)).toBe(
      DEFAULT_CALLBACK,
    );
  });
});

describe('the head loads the faces the stylesheet asks for', () => {
  const styles = readFileSync(join(SRC, 'styles.css'), 'utf8');

  function familiesOf(declaration: string): string[] {
    const value = new RegExp(`--${declaration}:s*([^;]+);`).exec(styles)?.[1] ?? '';

    return value.split(',').map((name) => name.trim().replace(/^["']|["']$/g, ''));
  }

  // Archivo and IBM Plex Mono were fetched here for months while --font named Onest and --mono
  // named Spline Sans Mono, so the whole documented type ramp rendered in Segoe UI and Consolas.
  test('the first family of --font and --mono is each requested from Google Fonts', () => {
    for (const declaration of ['font', 'mono']) {
      const wanted = familiesOf(declaration)[0] ?? '';
      const requested = wanted.replaceAll(' ', '+');

      expect(`${declaration} -> ${wanted}: ${root.includes(`family=${requested}:`)}`).toBe(
        `${declaration} -> ${wanted}: true`,
      );
    }
  });

  // The card preview is the same component the bot rasterises, so it names its faces inline rather
  // than through a --token. Fetching them is the only way the live preview matches the PNG.
  test('nothing is fetched that no declaration names', () => {
    const named = new Set([
      ...familiesOf('font'),
      ...familiesOf('mono'),
      ...FONT_STACK.split(',').map((name) => name.trim()),
    ]);

    for (const match of root.matchAll(/family=([A-Za-z+]+):/g)) {
      const family = (match[1] ?? '').replaceAll('+', ' ');

      expect(`${family} is used: ${named.has(family)}`).toBe(`${family} is used: true`);
    }
  });
});
