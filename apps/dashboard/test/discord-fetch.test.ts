import { afterEach, describe, expect, test } from 'bun:test';
import { fetchGuildChannels, fetchGuildRoles, fetchUserGuilds } from '../src/lib/discord.ts';
import { isPermanentFailure } from '../src/lib/errors.ts';

const PROXY = 'http://rest-proxy.test';

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

function stub(handler: () => Promise<Response>): typeof fetch {
  return Object.assign(handler, { preconnect: realFetch.preconnect });
}

function countingFetch(body: unknown, settle: Promise<void>): { calls: () => number } {
  let calls = 0;

  globalThis.fetch = stub(async () => {
    calls += 1;
    await settle;

    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });

  return { calls: () => calls };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });

  return { promise, resolve };
}

const GUILDS = [{ id: '1', name: 'Test', icon: null, owner: true, permissions: '8' }];

describe('the guild list Discord is asked for', () => {
  test('five overlapping callers cost one request, because a page load fires five at once', async () => {
    const gate = deferred();
    const fetches = countingFetch(GUILDS, gate.promise);

    const all = Promise.all(Array.from({ length: 5 }, () => fetchUserGuilds(PROXY, 'token-a')));
    gate.resolve();

    expect((await all).map((guilds) => guilds[0]?.id)).toEqual(['1', '1', '1', '1', '1']);
    expect(fetches.calls()).toBe(1);
  });

  test('two users overlapping are still two requests', async () => {
    const gate = deferred();
    const fetches = countingFetch(GUILDS, gate.promise);

    const both = Promise.all([
      fetchUserGuilds(PROXY, 'token-a'),
      fetchUserGuilds(PROXY, 'token-b'),
    ]);
    gate.resolve();
    await both;

    expect(fetches.calls()).toBe(2);
  });

  test('a later caller asks again, so authorisation is never answered from a stale list', async () => {
    const gate = deferred();
    const fetches = countingFetch(GUILDS, gate.promise);
    gate.resolve();

    await fetchUserGuilds(PROXY, 'token-a');
    await fetchUserGuilds(PROXY, 'token-a');

    expect(fetches.calls()).toBe(2);
  });

  test('a failure is shared and then forgotten, not cached as a refusal', async () => {
    let calls = 0;
    globalThis.fetch = stub(async () => {
      calls += 1;
      return new Response('nope', { status: 503 });
    });

    const first = fetchUserGuilds(PROXY, 'token-a');
    const second = fetchUserGuilds(PROXY, 'token-a');

    await expect(first).rejects.toThrow(/503/);
    await expect(second).rejects.toThrow(/503/);
    expect(calls).toBe(1);

    await expect(fetchUserGuilds(PROXY, 'token-a')).rejects.toThrow(/503/);
    expect(calls).toBe(2);
  });
});

describe('a guild whose channels or roles Proton cannot read', () => {
  async function refusal(
    call: (proxy: string, guildId: string) => Promise<unknown>,
    status: number,
  ): Promise<Error> {
    globalThis.fetch = stub(async () => new Response('no', { status }));

    return (await call(PROXY, '900000000000000001').then(
      () => new Error('it resolved'),
      (error: Error) => error,
    )) as Error;
  }

  // Returning [] here reads as "this server has no channels", and a save then writes that empty
  // selection over a working config.
  test('a 403 says which permission is missing rather than reporting an empty server', async () => {
    expect((await refusal(fetchGuildRoles, 403)).message).toMatch(/Manage Roles/);
    expect((await refusal(fetchGuildChannels, 403)).message).toMatch(/View Channels/);
  });

  test('and it is not retried, because the second ask is refused identically', async () => {
    expect(isPermanentFailure(await refusal(fetchGuildRoles, 403))).toBe(true);
  });

  test('a 502 from the proxy carries the status and stays retryable', async () => {
    const error = await refusal(fetchGuildChannels, 502);

    expect(error.message).toContain('502');
    expect(isPermanentFailure(error)).toBe(false);
  });
});

describe('the channel list the pickers are built from', () => {
  const RAW = [
    { id: 'c1', name: 'Text', type: 4, position: 0 },
    { id: 'c2', name: 'Voice', type: 4, position: 1 },
    { id: 'general', name: 'general', type: 0, position: 1, parent_id: 'c1' },
    { id: 'rules', name: 'rules', type: 0, position: 0, parent_id: 'c1' },
    { id: 'stage', name: 'Stage', type: 13, position: 0, parent_id: 'c2' },
    { id: 'loose', name: 'loose', type: 0, position: 0, parent_id: null },
  ];

  async function channels(): Promise<Awaited<ReturnType<typeof fetchGuildChannels>>> {
    globalThis.fetch = stub(
      async () =>
        new Response(JSON.stringify(RAW), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );

    return fetchGuildChannels(PROXY, '1');
  }

  test('comes back in the order Discord draws it, not the order the API returned', async () => {
    expect((await channels()).map((c) => c.id)).toEqual([
      'loose',
      'c1',
      'rules',
      'general',
      'c2',
      'stage',
    ]);
  });

  test('carries the category name, so a picker can group by it', async () => {
    const byId = new Map((await channels()).map((c) => [c.id, c]));

    expect(byId.get('general')?.parentName).toBe('Text');
    expect(byId.get('stage')?.parentName).toBe('Voice');
    expect(byId.get('loose')?.parentName).toBeNull();
  });
});
