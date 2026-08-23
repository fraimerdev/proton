import { describe, expect, test } from 'bun:test';
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
    const rest = new FakeRest(() => ({ status: 403, body: {} }));

    const loader = new BulkMemberContextLoader(rest, {
      now: () => NOW,
      onUnavailable: (_guildId, detail) => seen.push(detail),
    });

    const loaded = await loader.load(GUILD, [USER_A]);

    expect(seen[0]).toContain('Server Members privileged intent');
    expect(loaded.get(USER_A)?.member).toBeNull();
  });

  // A page that returns nothing new would otherwise loop forever against a proxy that ignores
  // `after`, which is exactly the shape a misconfigured mock or a cached 200 produces.
  test('a page that does not advance stops the walk', async () => {
    const rest = new FakeRest(() => ok([member(USER_A)]));
    const loader = new BulkMemberContextLoader(rest, { now: () => NOW, pageSize: 1 });

    await loader.load(GUILD, [USER_A]);

    expect(rest.paths.length).toBeLessThanOrEqual(2);
  });
});
