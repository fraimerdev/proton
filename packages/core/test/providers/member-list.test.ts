import { describe, expect, test } from 'bun:test';
import type {
  RestProxyClient,
  RestRequestOptions,
  RestResponse,
} from '../../src/actions/rest-client.ts';
import { RestGuildMemberLister, upstreamRefusal } from '../../src/providers/member-list.ts';

const GUILD = '900000000000000001';

class FakeRest implements RestProxyClient {
  readonly paths: string[] = [];

  constructor(private readonly reply: (path: string) => RestResponse) {}

  async request(options: RestRequestOptions): Promise<RestResponse> {
    this.paths.push(options.path);
    return this.reply(options.path);
  }
}

function wire(id: string, extra: Record<string, unknown> = {}, user: Record<string, unknown> = {}) {
  return { user: { id, ...user }, roles: ['700000000000000001'], ...extra };
}

const proxied = (message: string): RestResponse => ({
  status: 502,
  body: { error: 'rest_proxy_upstream_failure', message },
});

describe('RestGuildMemberLister', () => {
  test('asks for one page after the cursor, clamped to the thousand Discord allows', async () => {
    const rest = new FakeRest(() => ({ status: 200, body: [] }));
    const lister = new RestGuildMemberLister(rest);

    await lister.list(GUILD, '100000000000000005', 5000);
    await lister.list(GUILD, '0', 0);

    expect(rest.paths).toEqual([
      `/guilds/${GUILD}/members?limit=1000&after=100000000000000005`,
      `/guilds/${GUILD}/members?limit=1&after=0`,
    ]);
  });

  test('Missing Access names the Server Members intent or a server Proton left, and is not retried', async () => {
    const lister = new RestGuildMemberLister(
      new FakeRest(() => ({ status: 403, body: { message: 'Missing Access', code: 50001 } })),
    );

    const page = await lister.list(GUILD, '0', 1000);

    expect(page).toEqual({
      retryable: false,
      failure:
        'Discord refused to list this server’s members (403, code 50001). Either the Server ' +
        'Members Intent is off for Proton (turn it on in the Discord Developer Portal under ' +
        'Bot → Privileged Gateway Intents), or Proton is no longer in this server.',
    });
  });

  test('a 403 with no Discord code, like Cloudflare’s HTML page, names no intent and is not retried', async () => {
    const lister = new RestGuildMemberLister(
      new FakeRest(() => ({ status: 403, body: '<html><title>403 Forbidden</title></html>' })),
    );

    const page = await lister.list(GUILD, '0', 1000);

    expect(page).toEqual({
      retryable: false,
      failure:
        'Discord refused to list this server’s members (403) and sent no Discord error code with ' +
        'it. Try again later.',
    });
  });

  test('a 403 with another Discord code names the code, not the intent, and is not retried', async () => {
    const lister = new RestGuildMemberLister(
      new FakeRest(() => ({ status: 403, body: { message: 'Missing Permissions', code: 50013 } })),
    );

    const page = await lister.list(GUILD, '0', 1000);

    expect(page).toEqual({
      retryable: false,
      failure: 'Discord refused to list this server’s members (403, code 50013).',
    });
  });

  test.each([
    { status: 404, body: {} },
    { status: 404, body: { message: 'Unknown Guild', code: 10004 } },
    { status: 429, body: {} },
    { status: 500, body: {} },
    proxied('Internal Server Error'),
    { status: 502, body: 'Bad Gateway' },
  ])('other failures are retried (%o)', async (response) => {
    const lister = new RestGuildMemberLister(new FakeRest(() => response));

    const page = await lister.list(GUILD, '0', 1000);

    expect(page).toEqual({ retryable: true, failure: expect.stringContaining('member list') });
  });

  test('only a Discord answer is called one: the proxy’s 5xx says Discord was not heard from', async () => {
    const answered = async (response: RestResponse) => {
      const page = await new RestGuildMemberLister(new FakeRest(() => response)).list(
        GUILD,
        '0',
        1000,
      );
      return 'failure' in page ? page.failure : null;
    };

    expect(await answered(proxied('The operation was aborted'))).toBe(
      "Proton couldn't get the member list from Discord (error 502). Try again later.",
    );
    expect(await answered({ status: 500, body: {} })).not.toContain('Discord answered');
    expect(await answered({ status: 404, body: { message: 'Unknown Guild', code: 10004 } })).toBe(
      'Discord answered 404 (code 10004) when Proton asked for the member list.',
    );
    expect(await answered({ status: 404, body: '' })).toBe(
      'Discord answered 404 when Proton asked for the member list.',
    );
  });

  test('a short page is the last one', async () => {
    const lister = new RestGuildMemberLister(
      new FakeRest(() => ({ status: 200, body: [wire('100000000000000002')] })),
    );

    const page = await lister.list(GUILD, '0', 1000);

    expect('members' in page && page.next).toBeNull();
  });

  test('a full page moves the cursor to its highest id, even out of order', async () => {
    const lister = new RestGuildMemberLister(
      new FakeRest(() => ({
        status: 200,
        body: [wire('100000000000000009'), wire('100000000000000003')],
      })),
    );

    const page = await lister.list(GUILD, '100000000000000001', 2);

    expect('members' in page && page.next).toBe('100000000000000009');
  });

  test('a page that would not move the cursor ends the walk rather than looping', async () => {
    const lister = new RestGuildMemberLister(
      new FakeRest(() => ({ status: 200, body: [wire('100000000000000001')] })),
    );

    const page = await lister.list(GUILD, '100000000000000001', 1);

    expect('members' in page && page.next).toBeNull();
  });

  test('reads bot and pending, and a member without pending is not pending', async () => {
    const lister = new RestGuildMemberLister(
      new FakeRest(() => ({
        status: 200,
        body: [
          wire('100000000000000002', { pending: true }),
          wire('100000000000000003', {}, { bot: true }),
          wire('100000000000000004'),
          { user: { id: 'not-a-snowflake' }, roles: [] },
        ],
      })),
    );

    const page = await lister.list(GUILD, '0', 1000);
    if (!('members' in page)) throw new Error('expected a page');

    expect(page.members).toEqual([
      {
        userId: '100000000000000002',
        bot: false,
        pending: true,
        roleIds: ['700000000000000001'],
      },
      { userId: '100000000000000003', bot: true, pending: false, roleIds: ['700000000000000001'] },
      {
        userId: '100000000000000004',
        bot: false,
        pending: false,
        roleIds: ['700000000000000001'],
      },
    ]);
  });
});

describe('upstreamRefusal', () => {
  test('reads a real status', () => {
    expect(upstreamRefusal(403)).toBe('forbidden');
    expect(upstreamRefusal(404)).toBe('not_found');
    expect(upstreamRefusal(500)).toBeNull();
    expect(upstreamRefusal(502)).toBeNull();
    expect(upstreamRefusal(429)).toBeNull();
  });
});
