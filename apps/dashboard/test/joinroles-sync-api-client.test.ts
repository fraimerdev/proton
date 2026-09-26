import { afterEach, describe, expect, test } from 'bun:test';
import { queuedRun, syncRunView } from '@proton/module-joinroles/sync-view';
import { ApiClient, ApiError } from '../src/lib/api-client.ts';

const GUILD = '900000000000000002';
const ACTOR = '400000000000000001';
const NOW = Date.parse('2026-09-18T14:00:00.000Z');

const realFetch = globalThis.fetch;

let calls: { url: string; init: RequestInit }[] = [];

afterEach(() => {
  globalThis.fetch = realFetch;
  calls = [];
});

function answer(status: number, body: unknown) {
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
}

async function refusal(run: () => Promise<unknown>): Promise<ApiError> {
  try {
    await run();
  } catch (error) {
    if (error instanceof ApiError) return error;
    throw error;
  }
  throw new Error('expected the api client to throw');
}

const api = () => new ApiClient('http://api.test/', 'secret');

describe('ApiClient.getJoinRolesSync', () => {
  test('parses the status, filling skip counts a writer left out', async () => {
    const run = syncRunView(
      queuedRun({
        runId: 'r1',
        guildId: GUILD,
        kind: 'sync',
        trigger: 'dashboard',
        actorId: ACTOR,
        now: NOW,
      }),
    );
    answer(200, {
      run: { ...run, total: undefined, state: 'running', processed: 10, skipped: { pending: 2 } },
      last: null,
      estimate: null,
      nextCountAt: null,
      now: NOW,
    });

    const status = await api().getJoinRolesSync(GUILD);

    expect(calls[0]?.url).toBe(`http://api.test/guilds/${GUILD}/joinroles/sync`);
    expect(calls[0]?.init.method).toBeUndefined();
    expect(status.run?.state).toBe('running');
    expect(status.run?.total).toBeUndefined();
    expect(status.run?.skipped).toEqual({
      excluded: 0,
      pending: 2,
      outranks: 0,
      owner: 0,
      left: 0,
      failed: 0,
    });
  });

  test('a scheduled run carries no actor', async () => {
    const run = syncRunView(
      queuedRun({
        runId: 's7',
        guildId: GUILD,
        kind: 'sync',
        trigger: 'schedule',
        actorId: null,
        now: NOW,
      }),
    );

    answer(200, { run, last: null, estimate: null, nextCountAt: null, now: NOW });

    expect((await api().getJoinRolesSync(GUILD)).run?.actorId).toBeNull();
  });

  test('a status missing a key is refused by name rather than read as undefined', async () => {
    answer(200, { last: null, estimate: null, nextCountAt: null, now: NOW });

    await expect(api().getJoinRolesSync(GUILD)).rejects.toThrow(/does not understand: run: /);
  });
});

describe('ApiClient.startJoinRolesSync', () => {
  test('posts the kind with the audit stamp and reads back the run it claimed', async () => {
    answer(200, { runId: 'r2', kind: 'count' });

    const started = await api().startJoinRolesSync(GUILD, {
      kind: 'count',
      actorId: ACTOR,
      source: 'dashboard',
      ipHash: 'abc',
    });

    expect(started).toEqual({ runId: 'r2', kind: 'count' });
    expect(calls[0]?.url).toBe(`http://api.test/guilds/${GUILD}/joinroles/sync`);
    expect(calls[0]?.init.method).toBe('POST');
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      kind: 'count',
      actorId: ACTOR,
      source: 'dashboard',
      ipHash: 'abc',
    });
    expect(new Headers(calls[0]?.init.headers).get('x-proton-secret')).toBe('secret');
  });

  test('a 409 reaches the page as the api’s own sentence, with its code', async () => {
    answer(409, {
      error: 'already_running',
      message: 'A sync or count is already running in this server. Wait for it to finish.',
    });

    const error = await refusal(() =>
      api().startJoinRolesSync(GUILD, { kind: 'sync', actorId: ACTOR, source: 'dashboard' }),
    );

    expect(error.status).toBe(409);
    expect(error.code).toBe('already_running');
    expect(error.message).toBe(
      'A sync or count is already running in this server. Wait for it to finish.',
    );
  });

  test('an answer that is not JSON keeps the neutral outage wording', async () => {
    answer(502, '<html>bad gateway</html>');

    const error = await refusal(() =>
      api().startJoinRolesSync(GUILD, { kind: 'sync', actorId: ACTOR, source: 'dashboard' }),
    );

    expect(error.code).toBeUndefined();
    expect(error.message).toContain("Proton's API did not answer (HTTP 502)");
  });
});
