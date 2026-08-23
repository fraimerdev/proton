import { describe, expect, test } from 'bun:test';
import type { ApiDeps } from '../src/app.ts';
import { createApiApp } from '../src/app.ts';
import type { GuildService } from '../src/guilds/service.ts';

const SECRET = 'shared-secret-for-tests';
const JOINED = '900000000000000001';
const LEFT = '900000000000000002';
const NEVER = '900000000000000003';

function appWith(present: readonly string[]) {
  const guilds = {
    presentIds: (ids: readonly string[]) =>
      Promise.resolve(ids.filter((id) => present.includes(id))),
  } as unknown as GuildService;

  return createApiApp({ guilds, sharedSecret: SECRET } as unknown as ApiDeps);
}

function post(app: ReturnType<typeof createApiApp>, body: unknown, secret?: string) {
  return app.request('/guilds/presence', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(secret === undefined ? {} : { 'x-proton-secret': secret }),
    },
    body: JSON.stringify(body),
  });
}

describe('POST /guilds/presence', () => {
  test('answers with only the servers Proton is in', async () => {
    const response = await post(appWith([JOINED]), { ids: [JOINED, LEFT, NEVER] }, SECRET);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ present: [JOINED] });
  });

  test('an empty list is an empty answer, not every guild', async () => {
    const response = await post(appWith([JOINED]), { ids: [] }, SECRET);

    expect(await response.json()).toEqual({ present: [] });
  });

  // The picker greys out everything this endpoint omits, so a 200 with a silently truncated list
  // would tell an admin the bot had left servers it is still in.
  test('refuses a list longer than Discord can hand the dashboard', async () => {
    const ids = Array.from({ length: 201 }, (_, index) => `9000000000000${String(index + 10000)}`);
    const response = await post(appWith(ids), { ids }, SECRET);

    expect(response.status).toBe(400);
  });

  test('refuses a body that is not a list of ids', async () => {
    expect((await post(appWith([]), { ids: 'nope' }, SECRET)).status).toBe(400);
    expect((await post(appWith([]), {}, SECRET)).status).toBe(400);
    expect((await post(appWith([]), { ids: [''] }, SECRET)).status).toBe(400);
  });

  test('it sits behind the shared secret like every other guild route', async () => {
    expect((await post(appWith([JOINED]), { ids: [JOINED] })).status).toBe(401);
    expect((await post(appWith([JOINED]), { ids: [JOINED] }, 'wrong')).status).toBe(401);
  });
});
