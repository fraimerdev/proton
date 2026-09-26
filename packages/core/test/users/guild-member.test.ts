import { describe, expect, test } from 'bun:test';
import {
  type RestProxyClient,
  type RestRequestOptions,
  type RestResponse,
  RestTimeoutError,
} from '../../src/actions/rest-client.ts';
import { readGuildMember } from '../../src/users/guild-member.ts';

const GUILD = '900000000000000001';
const USER = '100000000000000001';

function answering(response: RestResponse | Error): {
  rest: RestProxyClient;
  asked: RestRequestOptions[];
} {
  const asked: RestRequestOptions[] = [];
  return {
    asked,
    rest: {
      async request(options) {
        asked.push(options);
        if (response instanceof Error) throw response;
        return response;
      },
    },
  };
}

const MEMBER = {
  user: { id: USER, username: 'tester' },
  roles: ['400000000000000001', '400000000000000002'],
  joined_at: '2026-01-04T10:00:00.000000+00:00',
  nick: null,
};

describe('readGuildMember', () => {
  test('reads a member’s roles and join time, and keeps the raw member', async () => {
    const { rest, asked } = answering({ status: 200, body: MEMBER });

    const read = await readGuildMember(rest, GUILD, USER);

    expect(asked).toEqual([{ method: 'GET', path: `/guilds/${GUILD}/members/${USER}` }]);
    expect(read).toEqual({
      state: 'member',
      raw: MEMBER,
      roleIds: MEMBER.roles,
      joinedAt: Date.parse('2026-01-04T10:00:00.000Z'),
    });
  });

  test('passes a timeout through to the proxy only when one is given', async () => {
    const { rest, asked } = answering({ status: 200, body: MEMBER });

    await readGuildMember(rest, GUILD, USER, { timeoutMs: 1500 });

    expect(asked[0]?.timeoutMs).toBe(1500);
  });

  test('a member with no join time reads as null, not as the epoch', async () => {
    const { rest } = answering({ status: 200, body: { ...MEMBER, joined_at: null } });

    const read = await readGuildMember(rest, GUILD, USER);

    expect(read.state === 'member' && read.joinedAt).toBeNull();
  });

  test.each([
    ['Unknown Member', 10007],
    ['Unknown User', 10013],
  ])('a 404 carrying %s means they are not in the server', async (_label, code) => {
    const { rest } = answering({ status: 404, body: { message: 'Unknown', code } });

    expect(await readGuildMember(rest, GUILD, USER)).toEqual({ state: 'absent' });
  });

  test('a bare 404 is the proxy’s own and proves nothing about the member', async () => {
    const { rest } = answering({ status: 404, body: 'Not Found' });

    expect(await readGuildMember(rest, GUILD, USER)).toEqual({ state: 'unavailable', status: 404 });
  });

  test('a 404 with some other Discord code is not a departure either', async () => {
    const { rest } = answering({ status: 404, body: { code: 10004, message: 'Unknown Guild' } });

    expect(await readGuildMember(rest, GUILD, USER)).toEqual({ state: 'unavailable', status: 404 });
  });

  test.each([403, 429, 500, 503])('a %d is unavailable, never absent', async (status) => {
    const { rest } = answering({ status, body: { code: 10007 } });

    expect(await readGuildMember(rest, GUILD, USER)).toEqual({ state: 'unavailable', status });
  });

  test('a success whose body is not a member is unavailable', async () => {
    const { rest } = answering({ status: 200, body: { user: { id: USER } } });

    expect(await readGuildMember(rest, GUILD, USER)).toEqual({ state: 'unavailable', status: 200 });
  });

  test('a proxy that times out or throws is unavailable rather than an error', async () => {
    const timedOut = answering(new RestTimeoutError('GET', '/guilds', 1500));
    const broken = answering(new Error('connection refused'));

    expect(await readGuildMember(timedOut.rest, GUILD, USER)).toEqual({ state: 'unavailable' });
    expect(await readGuildMember(broken.rest, GUILD, USER)).toEqual({ state: 'unavailable' });
  });
});
