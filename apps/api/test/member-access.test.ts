import { describe, expect, test } from 'bun:test';
import {
  ALL_PERMISSIONS,
  Permissions,
  type RestProxyClient,
  type RestRequestOptions,
  type RestResponse,
} from '@proton/core';
import { RestMemberAccess, ROSTER_TTL_MS } from '../src/applications/member-access.ts';

const GUILD = '900000000000000001';
const OWNER = '100000000000000001';
const MEMBER = '100000000000000002';
const ADMIN = '100000000000000003';
const CHANNEL = '500000000000000001';

const LOW = '200000000000000001';
const HIGH = '200000000000000002';
const ADMIN_ROLE = '200000000000000003';

type Route = RestResponse | 'throw';

const GUILD_BODY = {
  id: GUILD,
  name: 'Proton Test Server',
  icon: 'abc123',
  owner_id: OWNER,
  roles: [
    { id: GUILD, position: 0, permissions: String(Permissions.ViewChannel) },
    { id: LOW, position: 2, permissions: String(Permissions.ManageRoles) },
    { id: HIGH, position: 7, permissions: '0' },
    { id: ADMIN_ROLE, position: 9, permissions: String(Permissions.Administrator) },
  ],
};

function memberBody(userId: string, roles: string[]) {
  return {
    user: { id: userId, username: 'someone' },
    roles,
    joined_at: '2025-01-01T00:00:00.000Z',
  };
}

function fakeRest(routes: Record<string, Route>) {
  const calls: string[] = [];

  const client: RestProxyClient = {
    async request(options: RestRequestOptions): Promise<RestResponse> {
      calls.push(`${options.method} ${options.path}`);
      const route = routes[options.path];
      if (route === 'throw') throw new Error('socket hang up');
      return route ?? { status: 404, body: { message: '404: Not Found' } };
    },
  };

  return { client, calls, routes };
}

function standard(extra: Record<string, Route> = {}) {
  return fakeRest({
    [`/guilds/${GUILD}`]: { status: 200, body: GUILD_BODY },
    [`/guilds/${GUILD}/members/${MEMBER}`]: { status: 200, body: memberBody(MEMBER, [LOW, HIGH]) },
    [`/guilds/${GUILD}/members/${ADMIN}`]: { status: 200, body: memberBody(ADMIN, [ADMIN_ROLE]) },
    [`/guilds/${GUILD}/members/${OWNER}`]: { status: 200, body: memberBody(OWNER, []) },
    ...extra,
  });
}

describe('RestMemberAccess.read', () => {
  test('a member comes back with their roles, base permissions and highest position', async () => {
    const rest = standard();
    const access = new RestMemberAccess(rest.client);

    const read = await access.read(GUILD, MEMBER);

    expect(read.state).toBe('member');
    if (read.state !== 'member') return;
    expect(read.roleIds).toEqual([LOW, HIGH]);
    expect(read.highestPosition).toBe(7);
    expect(read.actor).toEqual({
      id: MEMBER,
      roleIds: [LOW, HIGH],
      permissions: Permissions.ViewChannel | Permissions.ManageRoles,
      owner: false,
    });
    expect(read.joinedAt).toBe(Date.parse('2025-01-01T00:00:00.000Z'));
    expect(read.raw.roles).toEqual([LOW, HIGH]);
  });

  test('the owner and Administrator holders get every permission', async () => {
    const access = new RestMemberAccess(standard().client);

    const owner = await access.read(GUILD, OWNER);
    const admin = await access.read(GUILD, ADMIN);

    expect(owner.state === 'member' && owner.actor.owner).toBe(true);
    expect(owner.state === 'member' && owner.actor.permissions).toBe(ALL_PERMISSIONS);
    expect(admin.state === 'member' && admin.actor.owner).toBe(false);
    expect(admin.state === 'member' && admin.actor.permissions).toBe(ALL_PERMISSIONS);
  });

  test('only Discord’s Unknown Member answer reads as absent', async () => {
    const access = new RestMemberAccess(
      standard({
        [`/guilds/${GUILD}/members/${MEMBER}`]: {
          status: 404,
          body: { message: 'Unknown Member', code: 10007 },
        },
      }).client,
    );

    expect(await access.read(GUILD, MEMBER)).toEqual({ state: 'absent' });
  });

  test('a bare proxy 404, a 5xx and a thrown request are unavailable, never absent', async () => {
    for (const route of [
      { status: 404, body: { message: '404: Not Found' } },
      { status: 502, body: { message: 'Bad gateway' } },
      'throw' as const,
    ]) {
      const access = new RestMemberAccess(
        standard({ [`/guilds/${GUILD}/members/${MEMBER}`]: route }).client,
      );
      expect(await access.read(GUILD, MEMBER)).toEqual({ state: 'unavailable' });
    }
  });

  test('a member whose server cannot be read is unavailable, and a departed one stays absent', async () => {
    const rest = standard({ [`/guilds/${GUILD}`]: { status: 503, body: {} } });
    const access = new RestMemberAccess(rest.client);

    expect(await access.read(GUILD, MEMBER)).toEqual({ state: 'unavailable' });

    rest.routes[`/guilds/${GUILD}/members/${MEMBER}`] = {
      status: 404,
      body: { message: 'Unknown Member', code: 10007 },
    };
    expect(await access.read(GUILD, MEMBER)).toEqual({ state: 'absent' });
  });

  test('member reads are never cached; the server roster is cached for 15 seconds', async () => {
    let now = 1_000_000;
    const rest = standard();
    const access = new RestMemberAccess(rest.client, { now: () => now });

    await access.read(GUILD, MEMBER);
    await access.read(GUILD, MEMBER);
    now += ROSTER_TTL_MS - 1;
    await access.read(GUILD, MEMBER);

    const guildReads = () => rest.calls.filter((call) => call === `GET /guilds/${GUILD}`).length;
    const memberReads = () =>
      rest.calls.filter((call) => call === `GET /guilds/${GUILD}/members/${MEMBER}`).length;

    expect(guildReads()).toBe(1);
    expect(memberReads()).toBe(3);

    now += 1;
    await access.read(GUILD, MEMBER);
    expect(guildReads()).toBe(2);
  });

  test('a failed roster read is not cached', async () => {
    const rest = standard({ [`/guilds/${GUILD}`]: 'throw' });
    const access = new RestMemberAccess(rest.client);

    expect(await access.roles(GUILD)).toBeNull();
    rest.routes[`/guilds/${GUILD}`] = { status: 200, body: GUILD_BODY };

    const roster = await access.roles(GUILD);
    expect(roster?.ownerId).toBe(OWNER);
    expect(roster?.roles.get(HIGH)?.position).toBe(7);
    expect(roster?.name).toBe('Proton Test Server');
  });

  test('a roster from another server is refused rather than trusted', async () => {
    const access = new RestMemberAccess(
      standard({
        [`/guilds/${GUILD}`]: { status: 200, body: { ...GUILD_BODY, id: '900000000000000002' } },
      }).client,
    );

    expect(await access.roles(GUILD)).toBeNull();
  });
});

describe('RestMemberAccess.channel', () => {
  test('reads the channel’s own overwrites and server', async () => {
    const access = new RestMemberAccess(
      standard({
        [`/channels/${CHANNEL}`]: {
          status: 200,
          body: {
            id: CHANNEL,
            guild_id: GUILD,
            permission_overwrites: [
              { id: GUILD, type: 0, allow: '0', deny: String(Permissions.ViewChannel) },
            ],
          },
        },
      }).client,
    );

    expect(await access.channel(CHANNEL)).toEqual({
      state: 'found',
      guildId: GUILD,
      overwrites: [{ id: GUILD, type: 0, allow: 0n, deny: Permissions.ViewChannel }],
    });
  });

  test('Unknown Channel and Missing Access are missing; anything else is unavailable', async () => {
    const answers: Array<[Route, string]> = [
      [{ status: 404, body: { code: 10003 } }, 'missing'],
      [{ status: 403, body: { code: 50001 } }, 'missing'],
      [{ status: 404, body: {} }, 'unavailable'],
      [{ status: 500, body: {} }, 'unavailable'],
      ['throw', 'unavailable'],
    ];

    for (const [route, state] of answers) {
      const access = new RestMemberAccess(standard({ [`/channels/${CHANNEL}`]: route }).client);
      expect((await access.channel(CHANNEL)).state).toBe(state as 'missing' | 'unavailable');
    }
  });
});
