import { describe, expect, test } from 'bun:test';
import type { BlockedMemberList, BlockedMemberQuery } from '@proton/core';
import type { ApiDeps } from '../src/app.ts';
import { createApiApp } from '../src/app.ts';
import { BlockedMemberError } from '../src/moderation/blocked-members.ts';

const SECRET = 'shared-secret-for-tests';
const GUILD = '900000000000000001';
const MEMBER = '400000000000000001';

const HERE = {
  presence: (ids: readonly string[]) => Promise.resolve({ present: [...ids], known: true }),
};

const GONE = {
  presence: () => Promise.resolve({ present: [], known: true }),
};

const EMPTY: BlockedMemberList = { rows: [], total: 0 };

interface Recorded {
  listed: Array<{ guildId: string; query: BlockedMemberQuery }>;
  lifted: unknown[];
}

function appWith(
  overrides: {
    guilds?: unknown;
    list?: (guildId: string, query: BlockedMemberQuery) => Promise<BlockedMemberList>;
    lift?: (input: unknown) => Promise<unknown>;
  } = {},
): { app: ReturnType<typeof createApiApp>; recorded: Recorded } {
  const recorded: Recorded = { listed: [], lifted: [] };

  const blocked = {
    list: async (guildId: string, query: BlockedMemberQuery) => {
      recorded.listed.push({ guildId, query });
      return overrides.list ? overrides.list(guildId, query) : EMPTY;
    },
    lift: async (input: unknown) => {
      recorded.lifted.push(input);
      if (overrides.lift) return overrides.lift(input);
      return { lifted: true, userId: MEMBER };
    },
  };

  const app = createApiApp({
    blocked,
    guilds: overrides.guilds ?? HERE,
    sharedSecret: SECRET,
  } as unknown as ApiDeps);

  return { app, recorded };
}

const NO_SECRET = Symbol('no secret');

function get(
  app: ReturnType<typeof createApiApp>,
  path: string,
  secret: string | typeof NO_SECRET = SECRET,
) {
  return app.request(path, {
    headers: secret === NO_SECRET ? {} : { 'x-proton-secret': secret },
  });
}

function lift(
  app: ReturnType<typeof createApiApp>,
  body: unknown,
  secret: string | typeof NO_SECRET = SECRET,
) {
  return app.request(`/guilds/${GUILD}/blocked-members/${MEMBER}/lift`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(secret === NO_SECRET ? {} : { 'x-proton-secret': secret }),
    },
    body: JSON.stringify(body),
  });
}

const LIFT = { actorId: '100000000000000001', source: 'dashboard', liftReason: 'On appeal.' };

describe('GET /guilds/:guildId/blocked-members', () => {
  test('is refused without the shared secret', async () => {
    const { app } = appWith();

    expect((await get(app, `/guilds/${GUILD}/blocked-members`, NO_SECRET)).status).toBe(401);
  });

  test('applies the query defaults rather than making the caller send them', async () => {
    const { app, recorded } = appWith();

    expect((await get(app, `/guilds/${GUILD}/blocked-members`)).status).toBe(200);
    expect(recorded.listed[0]?.query).toMatchObject({
      state: 'live',
      page: 1,
      pageSize: 50,
      order: 'desc',
    });
  });

  test('reads the filters off the query string', async () => {
    const { app, recorded } = appWith();

    await get(app, `/guilds/${GUILD}/blocked-members?state=lifted&moduleId=honeypot&page=2`);

    expect(recorded.listed[0]?.query).toMatchObject({
      state: 'lifted',
      moduleId: 'honeypot',
      page: 2,
    });
  });

  test('refuses a page size past the ceiling instead of clamping it', async () => {
    const { app } = appWith();

    expect((await get(app, `/guilds/${GUILD}/blocked-members?pageSize=999`)).status).toBe(400);
  });

  test('is scoped to the guild in the path', async () => {
    const { app, recorded } = appWith();

    await get(app, `/guilds/${GUILD}/blocked-members`);

    expect(recorded.listed[0]?.guildId).toBe(GUILD);
  });
});

describe('POST /guilds/:guildId/blocked-members/:userId/lift', () => {
  test('is refused without the shared secret', async () => {
    const { app } = appWith();

    expect((await lift(app, LIFT, NO_SECRET)).status).toBe(401);
  });

  test('lifts, carrying the guild and member from the path', async () => {
    const { app, recorded } = appWith();

    expect((await lift(app, LIFT)).status).toBe(200);
    expect(recorded.lifted[0]).toMatchObject({ guildId: GUILD, userId: MEMBER, ...LIFT });
  });

  test('refuses a lift with no reason — an unexplained lift is not a record', async () => {
    const { app } = appWith();

    expect((await lift(app, { ...LIFT, liftReason: '  ' })).status).toBe(400);
  });

  test('answers 404 when there was no live block to lift', async () => {
    const { app } = appWith({
      lift: () => {
        throw new BlockedMemberError('not_blocked', 'nothing to lift');
      },
    });

    expect((await lift(app, LIFT)).status).toBe(404);
  });

  // Two path segments after the guild id, which is exactly the shape a naive write guard misses.
  test('is caught by the write-presence guard for a server Proton has left', async () => {
    const { app, recorded } = appWith({ guilds: GONE });

    expect((await lift(app, LIFT)).status).toBe(409);
    expect(recorded.lifted).toHaveLength(0);
  });
});
