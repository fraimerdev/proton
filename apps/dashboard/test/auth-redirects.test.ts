import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SIGN_IN_CALLBACK_URL, SIGN_OUT_CALLBACK_URL } from '../src/lib/auth-redirects.ts';

const SRC = join(import.meta.dir, '..', 'src');

function read(...segments: string[]): string {
  return readFileSync(join(SRC, ...segments), 'utf8');
}

/**
 * The bug this closes: the Discord sign-in handed Better Auth `callbackURL: '/guilds'`, a path no
 * route has ever served, so every completed OAuth round trip landed on a 404 instead of the guild
 * picker. Nothing in the type system connects a redirect string to the route tree, so assert it.
 */
function navigableRoutes(): string[] {
  const block = /export interface FileRoutesByTo \{([\s\S]*?)\n\}/.exec(read('routeTree.gen.ts'));
  if (!block?.[1]) {
    throw new Error('routeTree.gen.ts has no FileRoutesByTo block — regenerate the route tree');
  }

  return [...block[1].matchAll(/^\s*'([^']+)':/gm)].map((match) => match[1] ?? '');
}

describe('post-auth redirect targets', () => {
  const routes = navigableRoutes();

  test('the generated route tree really was parsed, or these assertions prove nothing', () => {
    expect(routes).toContain('/');
    expect(routes).toContain('/privacy');
  });

  test('a path with no route is not mistaken for one', () => {
    expect(routes).not.toContain('/guilds');
  });

  test('the sign-in callback resolves to a route', () => {
    expect(routes).toContain(SIGN_IN_CALLBACK_URL);
  });

  test('the sign-out callback resolves to a route', () => {
    expect(routes).toContain(SIGN_OUT_CALLBACK_URL);
  });

  test('the sign-in callback is the guild picker, not the landing page', () => {
    expect(SIGN_IN_CALLBACK_URL).toBe('/dashboard');
  });
});

describe('the auth routes redirect through the shared constants', () => {
  test('sign-in passes Better Auth the constant rather than its own literal', () => {
    const source = read('routes', 'api', 'auth', 'signin', 'discord.ts');

    expect(source).toContain('callbackURL: SIGN_IN_CALLBACK_URL');
    expect(source).not.toMatch(/callbackURL: '/);
  });

  test('sign-out redirects to the constant rather than its own literal', () => {
    const source = read('routes', 'api', 'auth', 'signout.ts');

    expect(source).toContain("headers.set('location', SIGN_OUT_CALLBACK_URL)");
  });
});
