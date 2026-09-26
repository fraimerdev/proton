import { describe, expect, test } from 'bun:test';
import {
  type ActionRequest,
  type GuildState,
  Permissions,
  type RestProxyClient,
  type RestRequestOptions,
  type RestResponse,
  resolvePrecheckContext,
} from '@proton/core';
import { createFetchMemberRoles, createMemberRolesLookup } from '../src/member-roles.ts';

const GUILD = '900000000000000001';
const USER = '100000000000000001';
const BOT = '300000000000000001';
const ROLE = '700000000000000001';
const BOT_ROLE = '700000000000000002';

function answering(response: RestResponse) {
  const calls: RestRequestOptions[] = [];
  const unavailable: Array<[string, string, number]> = [];
  const rest: RestProxyClient = {
    async request(options) {
      calls.push(options);
      return response;
    },
  };
  const options = {
    onUnavailable: (guildId: string, userId: string, status: number) => {
      unavailable.push([guildId, userId, status]);
    },
  };
  return { rest, calls, unavailable, options };
}

const unknownMember: RestResponse = {
  status: 404,
  body: { message: 'Unknown Member', code: 10007 },
};

describe('member role lookup', () => {
  test('reads the roles of a member', async () => {
    const { rest, calls, options } = answering({
      status: 200,
      body: { roles: [ROLE, 7], user: { id: USER } },
    });

    expect(await createMemberRolesLookup(rest, options)(GUILD, USER)).toEqual([ROLE]);
    expect(await createFetchMemberRoles(rest, options)(GUILD, USER)).toEqual([ROLE]);
    expect(calls[0]).toEqual({ method: 'GET', path: `/guilds/${GUILD}/members/${USER}` });
  });

  test.each<[string, RestResponse]>([
    ['Unknown Member', unknownMember],
    ['Unknown User', { status: 404, body: { message: 'Unknown User', code: 10013 } }],
  ])('%s says they are not in the server, and is not an outage', async (_name, response) => {
    const { rest, unavailable, options } = answering(response);

    expect(await createMemberRolesLookup(rest, options)(GUILD, USER)).toBe('not_member');
    expect(unavailable).toEqual([]);
  });

  test('the lookup modules are given still answers null for a member who is not there', async () => {
    const { rest, unavailable, options } = answering(unknownMember);

    expect(await createFetchMemberRoles(rest, options)(GUILD, USER)).toBeNull();
    expect(unavailable).toEqual([]);
  });

  test.each<[string, RestResponse]>([
    [
      'a 404 with no Discord code, which Discord did not send',
      { status: 404, body: '404 Not Found' },
    ],
    ['a 404 whose body has no Discord code', { status: 404, body: { error: 'not_found' } }],
    ['Unknown Guild', { status: 404, body: { message: 'Unknown Guild', code: 10004 } }],
    ['Missing Access', { status: 403, body: { message: 'Missing Access', code: 50001 } }],
    ['an outage', { status: 502, body: { error: 'rest_proxy_upstream_failure', message: 'x' } }],
  ])('%s is a lookup that failed, never proof they left', async (_name, response) => {
    const { rest, unavailable, options } = answering(response);

    expect(await createMemberRolesLookup(rest, options)(GUILD, USER)).toBeNull();
    expect(await createFetchMemberRoles(rest, options)(GUILD, USER)).toBeNull();
    expect(unavailable).toEqual([
      [GUILD, USER, response.status],
      [GUILD, USER, response.status],
    ]);
  });

  test('a member body without a role list is unreadable', async () => {
    const { rest, options } = answering({ status: 200, body: { user: { id: USER } } });

    expect(await createMemberRolesLookup(rest, options)(GUILD, USER)).toBeNull();
  });
});

describe('member role lookup in the executor’s precheck', () => {
  const state: GuildState = {
    guildId: GUILD,
    ownerId: '200000000000000001',
    everyoneRoleId: GUILD,
    roles: new Map([
      [GUILD, { id: GUILD, permissions: 0n, position: 0 }],
      [BOT_ROLE, { id: BOT_ROLE, permissions: Permissions.KickMembers, position: 5 }],
    ]),
    botRoleIds: [BOT_ROLE],
    channels: new Map(),
    updatedAt: 0,
  };

  const kick: ActionRequest = {
    guildId: GUILD,
    moduleId: 'phishing',
    kind: 'kick',
    actorId: 'phishing',
    targetId: USER,
    payload: { userId: USER },
    dryRun: false,
    idempotencyKey: 'kick-1',
  };

  async function precheck(response: RestResponse) {
    const { rest } = answering(response);
    return resolvePrecheckContext(
      {
        store: {
          get: async () => state,
          put: async () => undefined,
          patch: async () => undefined,
          delete: async () => undefined,
        },
        botUserId: BOT,
        fetchMemberRoles: createMemberRolesLookup(rest),
      },
      kick,
    );
  }

  test('a member Discord does not know is refused as not in the server', async () => {
    const result = await precheck(unknownMember);

    expect('failure' in result && result.failure.code).toBe('target_not_member');
  });

  test('a lookup that failed stays a lookup that failed', async () => {
    const result = await precheck({ status: 502, body: { error: 'rest_proxy_upstream_failure' } });

    expect('failure' in result && result.failure.code).toBe('target_state_unavailable');
  });
});
