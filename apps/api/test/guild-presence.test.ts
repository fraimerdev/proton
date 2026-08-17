import { describe, expect, test } from 'bun:test';
import type { ApiDeps } from '../src/app.ts';
import { createApiApp } from '../src/app.ts';

const SECRET = 'shared-secret-for-tests';

function appWith(present: readonly string[]) {
  const asked: string[][] = [];

  const app = createApiApp({
    sharedSecret: SECRET,
    guilds: {
      presentIn: (guildIds: readonly string[]) => {
        asked.push([...guildIds]);
        return Promise.resolve(present.filter((id) => guildIds.includes(id)));
      },
    },
  } as unknown as ApiDeps);

  return { app, asked };
}

function post(body: unknown, secret: string | null = SECRET): RequestInit {
  return {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(secret ? { 'x-proton-secret': secret } : {}),
    },
    body: JSON.stringify(body),
  };
}

describe('POST /guilds/presence', () => {
  test('reports only the guilds Proton is still in', async () => {
    const { app, asked } = appWith(['1', '3']);

    const response = await app.request('/guilds/presence', post({ guildIds: ['1', '2', '3'] }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ present: ['1', '3'] });
    expect(asked).toEqual([['1', '2', '3']]);
  });

  test('an empty request asks for nothing and reports nothing', async () => {
    const { app } = appWith(['1']);

    const response = await app.request('/guilds/presence', post({ guildIds: [] }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ present: [] });
  });

  test('refuses without the shared secret', async () => {
    const { app, asked } = appWith(['1']);

    const response = await app.request('/guilds/presence', post({ guildIds: ['1'] }, null));

    expect(response.status).toBe(401);
    expect(asked).toEqual([]);
  });

  test('rejects a malformed body instead of treating it as an empty list', async () => {
    const { app, asked } = appWith(['1']);

    const response = await app.request('/guilds/presence', post({ guildIds: [42] }));

    expect(response.status).toBe(400);
    expect(asked).toEqual([]);
  });
});
