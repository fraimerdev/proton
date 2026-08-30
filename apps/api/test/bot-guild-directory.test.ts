import { describe, expect, test } from 'bun:test';
import { BotGuildDirectory } from '../src/guilds/directory.ts';

const PROXY = 'http://rest-proxy.test';

function guild(id: string, name = `guild ${id}`) {
  return { id, name };
}

function page(size: number, offset = 0) {
  return Array.from({ length: size }, (_, index) => guild(String(offset + index + 1)));
}

interface Call {
  url: string;
  headers: Headers;
}

type FetchArgs = Parameters<typeof globalThis.fetch>;

function recorder(responses: Array<() => Response>) {
  const calls: Call[] = [];

  const fetch = ((input: FetchArgs[0], init?: FetchArgs[1]) => {
    calls.push({ url: String(input), headers: new Headers(init?.headers) });

    const next = responses.shift();
    if (!next) throw new Error('the directory asked for more pages than the test supplied');

    return Promise.resolve(next());
  }) as typeof globalThis.fetch;

  return { calls, fetch };
}

function ok(body: unknown): () => Response {
  return () => new Response(JSON.stringify(body), { status: 200 });
}

function status(code: number): () => Response {
  return () => new Response('{}', { status: code });
}

const quiet = { warn: () => {} };

describe('BotGuildDirectory', () => {
  test('reports the guilds Discord says the bot is in, by id and name', async () => {
    const { calls, fetch } = recorder([ok([guild('1', 'First'), guild('2', 'Second')])]);
    const directory = new BotGuildDirectory(PROXY, { fetch, logger: quiet });

    expect([...((await directory.guilds()) ?? [])]).toEqual([
      ['1', 'First'],
      ['2', 'Second'],
    ]);
    expect(calls[0]?.url).toBe(`${PROXY}/api/users/@me/guilds?limit=200`);
  });

  // The proxy signs with the bot token only when this header is absent. Sending one would ask
  // which guilds some user is in, which is a different question with a plausible-looking answer.
  test('sends no user authorisation, so the proxy uses the bot token', async () => {
    const { calls, fetch } = recorder([ok([])]);

    await new BotGuildDirectory(PROXY, { fetch, logger: quiet }).guilds();

    expect(calls[0]?.headers.get('x-proton-authorization')).toBeNull();
  });

  test('pages with the after cursor until Discord returns a short page', async () => {
    const { calls, fetch } = recorder([ok(page(200)), ok(page(200, 200)), ok(page(7, 400))]);
    const directory = new BotGuildDirectory(PROXY, { fetch, logger: quiet });

    expect((await directory.guilds())?.size).toBe(407);
    expect(calls[1]?.url).toBe(`${PROXY}/api/users/@me/guilds?limit=200&after=200`);
    expect(calls[2]?.url).toBe(`${PROXY}/api/users/@me/guilds?limit=200&after=400`);
  });

  // A half-read list is the dangerous shape: every guild past the failed page would read as one
  // Proton had left, and the picker would offer to re-invite it to servers it is sitting in.
  test('discards the whole read when a later page fails', async () => {
    const { fetch } = recorder([ok(page(200)), status(500)]);

    expect(await new BotGuildDirectory(PROXY, { fetch, logger: quiet }).guilds()).toBeNull();
  });

  test('answers from cache inside the ttl and asks again after it', async () => {
    let clock = 0;
    const { calls, fetch } = recorder([ok([guild('1')]), ok([guild('1'), guild('2')])]);
    const directory = new BotGuildDirectory(PROXY, {
      fetch,
      logger: quiet,
      ttlMs: 1000,
      now: () => clock,
    });

    await directory.guilds();
    clock = 999;
    expect((await directory.guilds())?.size).toBe(1);
    expect(calls).toHaveLength(1);

    clock = 1001;
    expect((await directory.guilds())?.size).toBe(2);
    expect(calls).toHaveLength(2);
  });

  test('overlapping callers share one read', async () => {
    const { calls, fetch } = recorder([ok([guild('1')])]);
    const directory = new BotGuildDirectory(PROXY, { fetch, logger: quiet });

    const [a, b] = await Promise.all([directory.guilds(), directory.guilds()]);

    expect(calls).toHaveLength(1);
    expect(Object.is(a, b)).toBe(true);
  });

  test('an unreachable Discord with nothing cached is unknown, not empty', async () => {
    const { fetch } = recorder([status(502)]);

    expect(await new BotGuildDirectory(PROXY, { fetch, logger: quiet }).guilds()).toBeNull();
  });

  // Otherwise one bad call greys out every card in every admin's picker at once.
  test('keeps answering from the last good read while a refresh is failing', async () => {
    let clock = 0;
    const { fetch } = recorder([ok([guild('1')]), status(502)]);
    const directory = new BotGuildDirectory(PROXY, {
      fetch,
      logger: quiet,
      ttlMs: 100,
      graceMs: 5000,
      now: () => clock,
    });

    await directory.guilds();
    clock = 200;

    expect((await directory.guilds())?.size).toBe(1);
  });

  test('stops trusting the last good read once the grace window closes', async () => {
    let clock = 0;
    const { fetch } = recorder([ok([guild('1')]), status(502)]);
    const directory = new BotGuildDirectory(PROXY, {
      fetch,
      logger: quiet,
      ttlMs: 100,
      graceMs: 5000,
      now: () => clock,
    });

    await directory.guilds();
    clock = 5001;

    expect(await directory.guilds()).toBeNull();
  });

  test('a body that is not a list is a failed read', async () => {
    const { fetch } = recorder([ok({ message: '401: Unauthorized' })]);

    expect(await new BotGuildDirectory(PROXY, { fetch, logger: quiet }).guilds()).toBeNull();
  });
});
