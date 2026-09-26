import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isRedirect } from '@tanstack/react-router';

const GUILD = '111111111111111111';
const EXPIRED = 'Discord no longer accepts your sign-in. Sign out, then sign in again.';

mock.module('../src/lib/auth.ts', () => ({
  auth: {
    api: {
      getSession: async () => ({ user: { id: 'user-1', name: 'Admin', image: null } }),
    },
  },
}));

mock.module('../src/lib/discord-token.ts', () => ({
  getDiscordAccessToken: async () => 'revoked-token',
  getDiscordUserId: async () => '222222222222222222',
}));

const QUERIES = readFileSync(join(import.meta.dir, '..', 'src', 'lib', 'queries.ts'), 'utf8');

mock.module('../src/lib/queries.ts', () =>
  Object.fromEntries(
    [...QUERIES.matchAll(/^export (?:function|const) (\w+)/gm)].map(([, name]) => [
      name,
      (...args: unknown[]) => ({ queryKey: ['stub', name, ...args], enabled: false }),
    ]),
  ),
);

mock.module('../src/server/session.ts', () => ({ signOut: async () => undefined }));

const FILLED: Record<string, string> = {
  DATABASE_URL: 'postgres://proton:proton@127.0.0.1:1/unused',
  DISCORD_CLIENT_ID: 'test-client',
  DISCORD_CLIENT_SECRET: 'test-client-secret',
  BETTER_AUTH_SECRET: 'test-better-auth-secret',
  API_SHARED_SECRET: 'test-api-shared-secret',
};

const filled = Object.keys(FILLED).filter((key) => process.env[key] === undefined);
for (const key of filled) process.env[key] = FILLED[key];

const loaded = await Promise.all([
  import('../src/routes/api/guilds/$guildId/card-preview.ts'),
  import('../src/routes/api/guilds/$guildId/branding.$kind.ts'),
  import('../src/routes/dashboard/$guildId.tsx'),
]).finally(() => {
  for (const key of filled) delete process.env[key];
});

const [cardPreview, branding, guildShell] = loaded;

type Get = (ctx: { request: Request; params: Record<string, string> }) => Promise<Response>;

function get(route: { options: { server?: { handlers?: unknown } } }): Get {
  const handlers = route.options.server?.handlers;
  if (typeof handlers !== 'object' || handlers === null || !('GET' in handlers))
    throw new Error('the route has no GET handler');

  return handlers.GET as Get;
}

type Loader = (ctx: {
  context: { queryClient: { fetchQuery: () => Promise<never> } };
  params: { guildId: string };
  location: { href: string };
}) => Promise<void>;

function load(failure: Error): Promise<void> {
  const loader = guildShell.Route.options.loader as unknown as Loader;

  return loader({
    context: { queryClient: { fetchQuery: () => Promise.reject(failure) } },
    params: { guildId: GUILD },
    location: { href: `/dashboard/${GUILD}/moderation?tab=reasons` },
  });
}

async function thrown(pending: Promise<unknown>): Promise<unknown> {
  try {
    await pending;
  } catch (error) {
    return error;
  }

  throw new Error('expected a failure');
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function proxyAnswers(guilds: Response): string[] {
  const asked: string[] = [];

  const stub = async (input: RequestInfo | URL): Promise<Response> => {
    const url = String(input);
    asked.push(url);

    if (url.endsWith('/api/users/@me/guilds')) return guilds.clone();
    if (url.endsWith('/api/users/@me')) return json(401, { message: '401: Unauthorized', code: 0 });

    throw new Error(`the handler went on to ${url}`);
  };

  spyOn(globalThis, 'fetch').mockImplementation(
    Object.assign(stub, { preconnect: globalThis.fetch.preconnect }),
  );

  return asked;
}

function request(path: string): Request {
  return new Request(`http://dashboard.test/api/guilds/${GUILD}/${path}`);
}

const IMAGE_ROUTES = [
  [
    'the card preview',
    () => get(cardPreview.Route)({ request: request('card-preview'), params: { guildId: GUILD } }),
  ],
  [
    'a branding image',
    () =>
      get(branding.Route)({
        request: request('branding/avatar'),
        params: { guildId: GUILD, kind: 'avatar' },
      }),
  ],
] as const;

describe('an image route asked with a sign-in Discord has stopped accepting', () => {
  afterEach(() => {
    mock.restore();
  });

  for (const [what, call] of IMAGE_ROUTES) {
    test(`${what} answers 401 with the sentence, and asks nothing further`, async () => {
      const asked = proxyAnswers(json(401, { message: '401: Unauthorized', code: 0 }));

      const response = await call();

      expect(response.status).toBe(401);
      expect(response.headers.get('content-type')).toBe('text/plain');
      expect(await response.text()).toBe(EXPIRED);
      expect(asked.every((url) => url.includes('/api/users/@me'))).toBe(true);
    });

    test(`${what} still fails loudly when Discord cannot give the server list`, async () => {
      proxyAnswers(json(502, { error: 'rest_proxy_upstream_failure' }));

      const error = await thrown(call());

      expect(error).toBeInstanceOf(Error);
      expect(error instanceof Error && error.message).toBe(
        'Discord answered 502 when Proton asked which servers you administer.',
      );
    });
  }
});

describe('opening a server with a sign-in that is no longer accepted', () => {
  test('sends the admin to sign in again, and back to the page they asked for', async () => {
    for (const failure of [new Error(EXPIRED), new Error('not signed in')]) {
      const sent = await thrown(load(failure));

      expect(isRedirect(sent)).toBe(true);
      expect(isRedirect(sent) && sent.options).toMatchObject({
        to: '/signin',
        search: { redirect: `/dashboard/${GUILD}/moderation?tab=reasons` },
      });
    }
  });

  test('access that was revoked still goes back to the server list', async () => {
    const sent = await thrown(load(new Error('you do not administer that server')));

    expect(isRedirect(sent)).toBe(true);
    expect(isRedirect(sent) && sent.options.to).toBe('/dashboard');
  });

  test('any other failure is shown, not redirected', async () => {
    const failure = new Error('Proton’s service did not respond.');

    expect(await thrown(load(failure))).toBe(failure);
  });
});
