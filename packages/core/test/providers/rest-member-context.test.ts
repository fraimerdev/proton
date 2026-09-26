import { describe, expect, test } from 'bun:test';
import fc from 'fast-check';
import type {
  RestProxyClient,
  RestRequestOptions,
  RestResponse,
} from '../../src/actions/rest-client.ts';
import {
  BulkMemberContextLoader,
  RestMemberContextLoader,
} from '../../src/providers/rest-member-context.ts';
import { GUILD, NOW, ROLE_A, USER_A, USER_B, userIdAt } from './harness.ts';

function member(userId: string, roles: string[] = [ROLE_A]) {
  return {
    joined_at: '2024-03-01T00:00:00.000Z',
    roles,
    premium_since: null,
    communication_disabled_until: null,
    user: { id: userId, avatar: 'abc', bot: false },
  };
}

class FakeRest implements RestProxyClient {
  readonly paths: string[] = [];

  constructor(private readonly reply: (path: string) => RestResponse) {}

  async request(options: RestRequestOptions): Promise<RestResponse> {
    this.paths.push(options.path);
    return this.reply(options.path);
  }
}

const ok = (body: unknown): RestResponse => ({ status: 200, body });

describe('RestMemberContextLoader', () => {
  test('reads one member per id', async () => {
    const rest = new FakeRest((path) => ok(member(path.split('/').pop() ?? '')));
    const loader = new RestMemberContextLoader(rest, { now: () => NOW });

    const loaded = await loader.load(GUILD, [USER_A, USER_B]);

    expect(loaded.size).toBe(2);
    expect(loaded.get(USER_A)?.member?.roleIds).toEqual([ROLE_A]);
    expect(rest.paths).toHaveLength(2);
  });

  // A 404 is a fact, not an outage: judging them on roles they no longer hold is the bug.
  test('a member who left becomes a context with no member, not a missing entry', async () => {
    const rest = new FakeRest(() => ({ status: 404, body: {} }));
    const loader = new RestMemberContextLoader(rest, { now: () => NOW });

    const loaded = await loader.load(GUILD, [USER_A]);

    expect(loaded.get(USER_A)).toBeDefined();
    expect(loaded.get(USER_A)?.member).toBeNull();
  });

  test('a non-404 failure is reported to the caller', async () => {
    const seen: string[] = [];
    const rest = new FakeRest(() => ({ status: 403, body: {} }));
    const loader = new RestMemberContextLoader(rest, {
      now: () => NOW,
      onUnavailable: (_guildId, detail) => seen.push(detail),
    });

    await loader.load(GUILD, [USER_A]);

    expect(seen[0]).toContain('403');
  });

  test('the guild tier is carried onto every context it builds', async () => {
    const rest = new FakeRest((path) => ok(member(path.split('/').pop() ?? '')));
    const loader = new RestMemberContextLoader(rest, { now: () => NOW, tierOf: () => 'pro' });

    expect((await loader.load(GUILD, [USER_A])).get(USER_A)?.tier).toBe('pro');
  });
});

describe('BulkMemberContextLoader', () => {
  function ascendingIds(count: number): string[] {
    return Array.from({ length: count }, (_unused, index) =>
      userIdAt(new Date(Date.UTC(2020, 0, 1) + index * 86_400_000)),
    );
  }

  test('pages the member list rather than fetching one member at a time', async () => {
    const ids = ascendingIds(25);
    const rest = new FakeRest((path) => {
      const after = new URL(`https://x${path}`).searchParams.get('after') ?? '0';
      const page = ids.filter((id) => BigInt(id) > BigInt(after)).slice(0, 10);
      return ok(page.map((id) => member(id)));
    });

    const loader = new BulkMemberContextLoader(rest, { now: () => NOW, pageSize: 10 });
    const loaded = await loader.load(GUILD, ids);

    expect(loaded.size).toBe(25);
    expect(rest.paths).toHaveLength(3);
  });

  test('the request count follows guild size, not the number of entrants asked about', async () => {
    const ids = ascendingIds(30);
    const rest = new FakeRest((path) => {
      const after = new URL(`https://x${path}`).searchParams.get('after') ?? '0';
      const page = ids.filter((id) => BigInt(id) > BigInt(after)).slice(0, 10);
      return ok(page.map((id) => member(id)));
    });

    const loader = new BulkMemberContextLoader(rest, { now: () => NOW, pageSize: 10 });
    await loader.load(GUILD, [ids[0] as string]);

    // Thirty members in pages of ten: three full pages, then one more to learn there are no more.
    expect(rest.paths).toHaveLength(4);
  });

  test('entrants who are no longer members come back with no member', async () => {
    const present = ascendingIds(3);
    const rest = new FakeRest(() => ok(present.map((id) => member(id))));

    const loader = new BulkMemberContextLoader(rest, { now: () => NOW, pageSize: 1000 });
    const loaded = await loader.load(GUILD, [...present, USER_B]);

    expect(loaded.get(USER_B)?.member).toBeNull();
    expect(loaded.get(present[0] as string)?.member).not.toBeNull();
  });

  test('a missing Server Members intent is named rather than silently emptying the draw', async () => {
    const seen: string[] = [];
    const rest = new FakeRest(() => ({
      status: 403,
      body: { message: 'Missing Access', code: 50001 },
    }));

    const loader = new BulkMemberContextLoader(rest, {
      now: () => NOW,
      onUnavailable: (_guildId, detail) => seen.push(detail),
    });

    const loaded = await loader.load(GUILD, [USER_A]);

    expect(seen[0]).toContain('Server Members privileged intent');
    expect(seen[0]).toContain('Bot → Privileged Gateway Intents');
    expect(loaded.has(USER_A)).toBe(false);
  });

  test.each([
    [
      'a 403 without a Discord error code',
      403,
      '<html><title>Access denied | discord.com used Cloudflare</title></html>',
      'Discord refused to list members (403) and sent no Discord error code with it',
    ],
    [
      'Unknown Guild',
      404,
      { message: 'Unknown Guild', code: 10004 },
      'Discord refused to list members (404, code 10004): the server no longer exists or Proton ' +
        'is no longer in it',
    ],
    [
      'a refused bot token',
      401,
      { message: '401: Unauthorized', code: 0 },
      'Discord refused to list members (401, code 0)',
    ],
    [
      'Missing Access under another status',
      404,
      { message: 'Missing Access', code: 50001 },
      'Discord refused to list members (404, code 50001): the Server Members privileged intent ' +
        'is off for this application (Bot → Privileged Gateway Intents in the developer portal), ' +
        'or Proton is no longer in the server',
    ],
    [
      'a proxy that could not reach Discord',
      502,
      { error: 'rest_proxy_upstream_failure', message: 'socket hang up' },
      'the REST proxy answered 502 listing members',
    ],
  ] as const)('%s is worded from what actually answered', async (_label, status, body, detail) => {
    const seen: { detail: string; status: number | undefined }[] = [];
    const rest = new FakeRest(() => ({ status, body }));
    const loader = new BulkMemberContextLoader(rest, {
      now: () => NOW,
      onUnavailable: (_guildId, said, answered) => seen.push({ detail: said, status: answered }),
    });

    const loaded = await loader.load(GUILD, [USER_A]);

    expect(seen).toEqual([{ detail, status }]);
    expect(loaded.has(USER_A)).toBe(false);
  });

  test('a list that fails partway says nothing about the entrants it never reached', async () => {
    const ids = ascendingIds(25);
    const seen: { detail: string; status: number | undefined }[] = [];
    const rest = new FakeRest((path) => {
      const after = new URL(`https://x${path}`).searchParams.get('after') ?? '0';
      if (after !== '0') return { status: 502, body: { error: 'rest_proxy_upstream_failure' } };
      return ok(ids.slice(0, 10).map((id) => member(id)));
    });

    const between = (index: number) =>
      userIdAt(new Date(Date.UTC(2020, 0, 1) + index * 86_400_000 + 43_200_000));
    const goneBeforeTheFailure = between(4);
    const beyondTheFailure = between(20);

    const loader = new BulkMemberContextLoader(rest, {
      now: () => NOW,
      pageSize: 10,
      onUnavailable: (_guildId, detail, status) => seen.push({ detail, status }),
    });
    const loaded = await loader.load(GUILD, [
      ids[3] as string,
      goneBeforeTheFailure,
      ids[15] as string,
      beyondTheFailure,
    ]);

    expect(loaded.get(ids[3] as string)?.member).not.toBeNull();
    expect(loaded.get(goneBeforeTheFailure)?.member).toBeNull();
    expect(loaded.has(ids[15] as string)).toBe(false);
    expect(loaded.has(beyondTheFailure)).toBe(false);
    expect(seen).toEqual([{ detail: 'the REST proxy answered 502 listing members', status: 502 }]);
  });

  test('a 200 that is not a member list is not read as an empty server', async () => {
    const seen: string[] = [];
    const rest = new FakeRest(() => ok('<html>cached</html>'));
    const loader = new BulkMemberContextLoader(rest, {
      now: () => NOW,
      onUnavailable: (_guildId, detail) => seen.push(detail),
    });

    const loaded = await loader.load(GUILD, [USER_A]);

    expect(loaded.has(USER_A)).toBe(false);
    expect(seen).toEqual(['the REST proxy answered 200 without a member list']);
  });

  // A page that returns nothing new would otherwise loop forever against a proxy that ignores
  // `after`, which is exactly the shape a misconfigured mock or a cached 200 produces.
  test('a page that does not advance stops the walk', async () => {
    const rest = new FakeRest(() => ok([member(USER_A)]));
    const loader = new BulkMemberContextLoader(rest, { now: () => NOW, pageSize: 1 });

    await loader.load(GUILD, [USER_A]);

    expect(rest.paths.length).toBeLessThanOrEqual(2);
  });

  test('a walk that stopped advancing leaves the members above it unknown and says so', async () => {
    const seen: string[] = [];
    const rest = new FakeRest(() => ok([member(USER_A)]));
    const loader = new BulkMemberContextLoader(rest, {
      now: () => NOW,
      pageSize: 1,
      onUnavailable: (_guildId, detail) => seen.push(detail),
    });

    const loaded = await loader.load(GUILD, [USER_A, USER_B]);

    expect(loaded.get(USER_A)?.member).not.toBeNull();
    expect(loaded.has(USER_B)).toBe(false);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain(USER_A);
  });

  test('no current member is ever reported as having left, whichever page fails', async () => {
    const memberDays = fc.uniqueArray(fc.integer({ min: 0, max: 400 }), { maxLength: 40 });

    await fc.assert(
      fc.asyncProperty(
        memberDays,
        fc.array(fc.integer({ min: 0, max: 400 }), { maxLength: 20 }),
        fc.integer({ min: 1, max: 7 }),
        fc.option(fc.integer({ min: 0, max: 8 }), { nil: null }),
        async (days, askedDays, pageSize, failingPage) => {
          const idOf = (day: number) => userIdAt(new Date(Date.UTC(2020, 0, 1) + day * 86_400_000));
          const members = [...days].sort((a, b) => a - b).map(idOf);
          const memberSet = new Set(members);
          const asked = [...new Set([...askedDays.map(idOf), ...members.slice(0, 5)])];

          let request = 0;
          const rest = new FakeRest((path) => {
            const index = request++;
            if (index === failingPage) return { status: 502, body: {} };

            const after = new URL(`https://x${path}`).searchParams.get('after') ?? '0';
            const page = members.filter((id) => BigInt(id) > BigInt(after)).slice(0, pageSize);
            return ok(page.map((id) => member(id)));
          });

          const loader = new BulkMemberContextLoader(rest, { now: () => NOW, pageSize });
          const loaded = await loader.load(GUILD, asked);

          for (const id of asked) {
            const ctx = loaded.get(id);
            if (memberSet.has(id)) expect(ctx === undefined || ctx.member !== null).toBe(true);
            else expect(ctx === undefined || ctx.member === null).toBe(true);

            if (failingPage === null || failingPage >= request) expect(ctx).toBeDefined();
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});
