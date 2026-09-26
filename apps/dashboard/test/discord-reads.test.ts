import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test';
import {
  expiredSignInResponse,
  fetchGuildChannels,
  fetchGuildEmojis,
  fetchGuildMembers,
  fetchGuildRoles,
  fetchUserGuilds,
  SignInExpiredError,
} from '../src/lib/discord.ts';
import {
  failureKind,
  isAccessError,
  isPermanentFailure,
  readFailure,
  saveFailure,
} from '../src/lib/errors.ts';

const GUILD = '111111111111111111';
const PROXY = 'http://proxy';
const EXPIRED = 'Discord no longer accepts your sign-in. Sign out, then sign in again.';

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function answer(respond: (url: string) => Response): string[] {
  const asked: string[] = [];

  const stub = async (input: RequestInfo | URL): Promise<Response> => {
    asked.push(String(input));
    return respond(String(input));
  };

  spyOn(globalThis, 'fetch').mockImplementation(
    Object.assign(stub, { preconnect: globalThis.fetch.preconnect }),
  );

  return asked;
}

async function thrown(pending: Promise<unknown>): Promise<Error> {
  try {
    await pending;
  } catch (error) {
    if (error instanceof Error) return error;
  }

  throw new Error('expected the read to be refused');
}

function member(id: string) {
  return { nick: null, user: { id, username: `user${id}`, discriminator: '0' } };
}

const READS = [
  ['roles', () => fetchGuildRoles(PROXY, GUILD)],
  ['channels', () => fetchGuildChannels(PROXY, GUILD)],
  ['emoji', () => fetchGuildEmojis(PROXY, GUILD)],
] as const;

describe('a picker read Discord refuses', () => {
  afterEach(() => {
    mock.restore();
  });

  for (const [what, read] of READS) {
    test(`a 403 on ${what} names no permission to grant, and is not asked again`, async () => {
      answer(() => json(403, { message: 'Missing Access', code: 50001 }));

      const error = await thrown(read());

      expect(error.message.startsWith(`Proton can't read this server's ${what}`)).toBe(true);
      expect(error.message).toContain('Discord refused with 403');
      expect(error.message).toContain('usually because Proton is no longer in this server');
      expect(error.message.endsWith('If so, add it to the server again.')).toBe(true);
      expect(error.message).not.toContain('server list');
      expect(error.message).not.toContain('Manage Roles');
      expect(error.message).not.toContain('View Channels');
      expect(error.message).not.toContain('Server Settings');
      expect(isPermanentFailure(error)).toBe(true);
      expect(readFailure(error, `this server’s ${what}`)).toBe(error.message);
    });

    test(`a 404 on ${what} says what Discord answered, and is not asked again`, async () => {
      answer(() => json(404, { message: 'Unknown Guild', code: 10004 }));

      const error = await thrown(read());

      expect(error.message).toContain('Discord answered 404');
      expect(isPermanentFailure(error)).toBe(true);
    });

    test(`a 502 from the proxy on ${what} is asked again`, async () => {
      answer(() => json(502, { error: 'rest_proxy_upstream_failure', message: 'socket hang up' }));

      const error = await thrown(read());

      expect(error.message).toContain('Discord answered 502');
      expect(isPermanentFailure(error)).toBe(false);
    });
  }

  test('a 429 is the one Discord answer that clears on its own', () => {
    expect(
      isPermanentFailure(
        new Error("Proton could not read this server's roles — Discord answered 429. Reload."),
      ),
    ).toBe(false);
    expect(isPermanentFailure(new Error('Discord refused with 429'))).toBe(false);
    expect(isPermanentFailure(new Error('Discord answered 400 to that'))).toBe(true);
    expect(isPermanentFailure(new Error('Discord answered 500 to that'))).toBe(false);
  });
});

describe('the members a page names by id', () => {
  afterEach(() => {
    mock.restore();
  });

  test('a member or user Discord no longer knows is left out, and the rest still resolve', async () => {
    answer((url) => {
      if (url.endsWith('/members/1')) return json(200, member('1'));
      if (url.endsWith('/members/2')) return json(404, { message: 'Unknown Member', code: 10007 });
      return json(404, { message: 'Unknown User', code: 10013 });
    });

    const found = await fetchGuildMembers(PROXY, GUILD, ['1', '2', '3']);

    expect(found.map((one) => one.id)).toEqual(['1']);
  });

  test('a page whose every member has left reads as nobody, not as a refusal', async () => {
    answer(() => json(404, { message: 'Unknown Member', code: 10007 }));

    expect(await fetchGuildMembers(PROXY, GUILD, ['1', '2'])).toEqual([]);
  });

  test('Unknown Guild is a refusal, not a server full of departed members', async () => {
    answer(() => json(404, { message: 'Unknown Guild', code: 10004 }));

    const error = await thrown(fetchGuildMembers(PROXY, GUILD, ['1', '2']));

    expect(error.message).toContain("Proton couldn't read this server's members");
    expect(error.message).toContain('Discord answered 404');
    expect(isPermanentFailure(error)).toBe(true);
  });

  test('a 404 with no Discord code is a refusal too', async () => {
    answer(() => new Response('404 Not Found', { status: 404 }));

    const error = await thrown(fetchGuildMembers(PROXY, GUILD, ['1']));

    expect(error.message).toContain('Discord answered 404');
  });

  test('a 403 names no permission to grant', async () => {
    answer(() => json(403, { message: 'Missing Access', code: 50001 }));

    const error = await thrown(fetchGuildMembers(PROXY, GUILD, ['1']));

    expect(error.message.startsWith("Proton can't read this server's members")).toBe(true);
    expect(error.message).not.toContain('Server Settings');
    expect(isPermanentFailure(error)).toBe(true);
  });

  test('an unreachable proxy on one id does not hide Discord refusing the others', async () => {
    answer((url) => {
      if (url.endsWith('/members/1')) throw new TypeError('fetch failed');
      return json(403, { message: 'Missing Access', code: 50001 });
    });

    const error = await thrown(fetchGuildMembers(PROXY, GUILD, ['2', '1']));

    expect(error.message).toContain('Discord refused with 403');
  });
});

describe('a Discord sign-in Discord has stopped accepting', () => {
  afterEach(() => {
    mock.restore();
  });

  test('a 401 on the server list is raised as an expired sign-in', async () => {
    const asked = answer(() => json(401, { message: '401: Unauthorized', code: 0 }));

    const error = await thrown(fetchUserGuilds(PROXY, 'revoked-token'));

    expect(error).toBeInstanceOf(SignInExpiredError);
    expect(error.message).toBe(EXPIRED);
    expect(asked).toEqual([`${PROXY}/api/users/@me/guilds`]);
  });

  test('it is a signed-out failure on the server and in the browser, never retried', () => {
    for (const error of [new SignInExpiredError(), new Error(EXPIRED)]) {
      expect(failureKind(error)).toBe('signed-out');
      expect(isAccessError(error)).toBe(true);
      expect(isPermanentFailure(error)).toBe(true);
      expect(saveFailure(error, 'Couldn’t save your changes')).toContain(
        'Your Discord sign-in expired',
      );
      expect(readFailure(error, 'this server’s roles')).toContain('Your Discord sign-in expired');
    }
  });

  test('any other refusal of the server list is not a sign-in problem', async () => {
    answer(() => json(403, { message: 'Missing Access', code: 50001 }));

    const refused = await thrown(fetchUserGuilds(PROXY, 'scoped-token'));

    expect(refused).not.toBeInstanceOf(SignInExpiredError);
    expect(failureKind(refused)).not.toBe('signed-out');
    expect(isPermanentFailure(refused)).toBe(true);

    mock.restore();
    answer(() => json(502, { error: 'rest_proxy_upstream_failure' }));

    const failed = await thrown(fetchUserGuilds(PROXY, 'another-token'));

    expect(failed).not.toBeInstanceOf(SignInExpiredError);
    expect(isPermanentFailure(failed)).toBe(false);
  });

  test('the image routes answer it with a 401 carrying the sentence', async () => {
    const response = expiredSignInResponse(new SignInExpiredError());

    expect(response.status).toBe(401);
    expect(await response.text()).toBe(EXPIRED);

    const other = new Error('Discord answered 500 when Proton asked which servers you administer.');
    expect(() => expiredSignInResponse(other)).toThrow(other);
  });
});
