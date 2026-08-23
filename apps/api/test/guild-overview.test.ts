import { describe, expect, test } from 'bun:test';
import type { ApiDeps } from '../src/app.ts';
import { createApiApp } from '../src/app.ts';
import type { GuildOverview, GuildService } from '../src/guilds/service.ts';

const SECRET = 'shared-secret-for-tests';
const GUILD = '900000000000000001';

const OVERVIEW: GuildOverview = {
  id: GUILD,
  name: 'Test Guild',
  locale: 'en-GB',
  tier: 'premium',
  joinedAt: '2026-03-14T09:30:00.000Z',
};

function appWith(overview: GuildOverview | null) {
  const guilds = {
    overview: (guildId: string) => Promise.resolve(guildId === GUILD ? overview : null),
  } as unknown as GuildService;

  return createApiApp({ guilds, sharedSecret: SECRET } as unknown as ApiDeps);
}

function get(app: ReturnType<typeof createApiApp>, path: string, secret?: string) {
  return app.request(path, {
    headers: secret === undefined ? {} : { 'x-proton-secret': secret },
  });
}

describe('GET /guilds/:guildId', () => {
  test('returns the row Proton keeps for the guild', async () => {
    const response = await get(appWith(OVERVIEW), `/guilds/${GUILD}`, SECRET);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(OVERVIEW);
  });

  // The dashboard renders the tier and the join date and nothing else from this row; a shape drift
  // here is a blank General settings page rather than an error anyone would notice.
  test('carries the fields the dashboard reads', async () => {
    const body = (await (
      await get(appWith(OVERVIEW), `/guilds/${GUILD}`, SECRET)
    ).json()) as Record<string, unknown>;

    for (const key of ['id', 'name', 'locale', 'tier', 'joinedAt']) {
      expect(`${key}: ${body[key] !== undefined}`).toBe(`${key}: true`);
    }
  });

  test('a guild Proton has no row for is a 404, not an empty object', async () => {
    const response = await get(appWith(null), `/guilds/${GUILD}`, SECRET);

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'unknown_guild' });
  });

  test('it sits behind the shared secret like every other guild route', async () => {
    expect((await get(appWith(OVERVIEW), `/guilds/${GUILD}`)).status).toBe(401);
    expect((await get(appWith(OVERVIEW), `/guilds/${GUILD}`, 'wrong')).status).toBe(401);
  });
});
