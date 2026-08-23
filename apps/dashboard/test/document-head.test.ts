import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

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
  test('the sign-in callback names a route that exists', () => {
    const target = /callbackURL: '([^']+)'/.exec(signIn)?.[1];

    expect(`${target} is a route: ${routeTree.includes(`'${target}'`)}`).toBe(
      `${target} is a route: true`,
    );
  });

  test('and it is the guild picker, not the door the visitor just came through', () => {
    expect(signIn).toContain("callbackURL: '/dashboard'");
  });
});
