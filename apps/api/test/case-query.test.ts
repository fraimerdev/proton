import { describe, expect, test } from 'bun:test';
import {
  type CaseQuery,
  type CaseSearchResult,
  caseQuerySchema,
  MODERATION_ACTION_KINDS,
  reversalIdempotencyKey,
} from '@proton/core';
import type { cases } from '@proton/db/schema';
import type { ApiDeps } from '../src/app.ts';
import { createApiApp } from '../src/app.ts';
import { CaseQueryService, toCaseRecord } from '../src/cases/service.ts';
import { fakePostgres, pick } from './fake-postgres.ts';

const SECRET = 'shared-secret-for-tests';
const GUILD = '900000000000000001';
const MEMBER = '100000000000000001';
const OTHER_MEMBER = '100000000000000002';

function row(overrides: Partial<typeof cases.$inferSelect> = {}): typeof cases.$inferSelect {
  return {
    id: 'z2LcQRB',
    guildId: GUILD,
    caseNumber: 92,
    type: 'kick',
    actorId: MEMBER,
    targetId: '200000000000000001',
    moderatorId: null,
    reason: null,
    moduleId: 'moderation',
    payload: null,
    expiresAt: null,
    revertedAt: null,
    revertedBy: null,
    dryRun: false,
    idempotencyKey: 'k1',
    createdAt: new Date('2026-09-19T11:18:57.000Z'),
    ...overrides,
  };
}

describe('toCaseRecord', () => {
  test('a case recorded before moderators were written names the member who acted', () => {
    expect(toCaseRecord(row()).moderatorId).toBe(MEMBER);
  });

  test('a stored moderator is kept as it is', () => {
    expect(toCaseRecord(row({ moderatorId: OTHER_MEMBER })).moderatorId).toBe(OTHER_MEMBER);
  });

  test('an automatic action has no moderator', () => {
    expect(toCaseRecord(row({ actorId: 'proton:automod' })).moderatorId).toBeNull();
    expect(toCaseRecord(row({ actorId: 'rules:r1' })).moderatorId).toBeNull();
    expect(toCaseRecord(row({ actorId: null })).moderatorId).toBeNull();
  });

  test('a duration running out has no moderator, though it ran as the one who set it', () => {
    const lifted = row({ type: 'unban', idempotencyKey: reversalIdempotencyKey('k1') });

    expect(toCaseRecord(lifted).moderatorId).toBeNull();
    expect(toCaseRecord(lifted).actorId).toBe(MEMBER);
  });

  test('the actor is still returned alongside the moderator', () => {
    expect(toCaseRecord(row({ actorId: 'proton:automod' })).actorId).toBe('proton:automod');
  });
});

function searching() {
  const { handle, queries } = fakePostgres((query) =>
    query.sql.startsWith('select count(') ? [[0]] : [],
  );

  const service = new CaseQueryService(handle);
  const search = (input: Record<string, unknown>) =>
    service.search(GUILD, caseQuerySchema.parse(input));

  return { search, queries };
}

describe('CaseQueryService scope', () => {
  test('moderation narrows the search to the moderation kinds', async () => {
    const { search, queries } = searching();

    await search({ scope: 'moderation' });

    const [rows] = queries;
    expect(rows?.sql).toContain('"cases"."type" in (');
    expect(rows?.params).toEqual(expect.arrayContaining([...MODERATION_ACTION_KINDS]));
    expect(rows?.params).not.toContain('send');
  });

  test('all applies no kind filter', async () => {
    const { search, queries } = searching();

    await search({ scope: 'all' });
    await search({});

    for (const query of queries) expect(query.sql).not.toContain('"cases"."type"');
  });

  test('a type and the moderation scope must both hold', async () => {
    const { search, queries } = searching();

    await search({ scope: 'moderation', type: 'send' });

    const [rows] = queries;
    expect(rows?.sql).toContain('"cases"."type" in (');
    expect(rows?.sql).toContain('"cases"."type" = $');
    expect(rows?.sql).not.toContain(' or "cases"."type"');
  });

  test('a moderator’s cases leave out the durations that ran out on their own', async () => {
    const { search, queries } = searching();

    await search({ moderatorId: MEMBER });

    const [rows] = queries;
    expect(rows?.sql).toContain('"cases"."moderator_id" = $');
    expect(rows?.sql).toContain('"cases"."actor_id" = $');
    expect(rows?.sql).toContain('"cases"."idempotency_key" not like $');
    expect(rows?.params).toEqual(
      expect.arrayContaining([MEMBER, `${reversalIdempotencyKey('')}%`]),
    );
  });

  test('the rows come back with their moderator filled in', async () => {
    const { handle } = fakePostgres((query) =>
      query.sql.startsWith('select count(')
        ? [[1]]
        : [
            pick(query, {
              id: 'z2LcQRB',
              guild_id: GUILD,
              case_number: 92,
              type: 'kick',
              actor_id: MEMBER,
              target_id: '200000000000000001',
              moderator_id: null,
              reason: null,
              module_id: 'moderation',
              payload: null,
              expires_at: null,
              reverted_at: null,
              reverted_by: null,
              dry_run: false,
              idempotency_key: 'k1',
              created_at: '2026-09-19T11:18:57.000Z',
            }),
          ],
    );

    const result = await new CaseQueryService(handle).search(
      GUILD,
      caseQuerySchema.parse({ scope: 'moderation' }),
    );

    expect(result.cases.map((c) => [c.id, c.moderatorId])).toEqual([['z2LcQRB', MEMBER]]);
  });
});

describe('GET /guilds/:guildId/cases', () => {
  function app() {
    const seen: CaseQuery[] = [];

    const casesService = {
      search: async (_guildId: string, query: CaseQuery): Promise<CaseSearchResult> => {
        seen.push(query);
        return { cases: [], total: 0, page: query.page, pageSize: query.pageSize };
      },
    };

    const built = createApiApp({ cases: casesService, sharedSecret: SECRET } as unknown as ApiDeps);

    const get = (search: string) =>
      built.request(`/guilds/${GUILD}/cases${search}`, {
        headers: { 'x-proton-secret': SECRET },
      });

    return { get, seen };
  }

  test('reads the scope from the query string alongside the other filters', async () => {
    const { get, seen } = app();

    const response = await get('?scope=moderation&type=ban&page=2&pageSize=25');

    expect(response.status).toBe(200);
    expect(seen[0]).toMatchObject({ scope: 'moderation', type: 'ban', page: 2, pageSize: 25 });
  });

  test('without a scope every action is searched, as before', async () => {
    const { get, seen } = app();

    await get('');

    expect(seen[0]?.scope).toBe('all');
  });

  test('an unknown scope is refused and named', async () => {
    const { get, seen } = app();

    const response = await get('?scope=everything');
    const body = (await response.json()) as { error: string; message: string };

    expect(response.status).toBe(400);
    expect(body.error).toBe('invalid_query');
    expect(body.message).toContain('scope');
    expect(seen).toEqual([]);
  });
});
