import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { type CaseQueryInput, caseQuerySchema, newId } from '@proton/core';
import { createDb, type DbHandle, runMigrations } from '@proton/db';
import { cases, guilds } from '@proton/db/schema';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { CaseQueryService } from '../src/cases/service.ts';

let container: StartedPostgreSqlContainer;
let handle: DbHandle;
let service: CaseQueryService;

const GUILD = '900000000000000001';
const OTHER_GUILD = '900000000000000002';
const MOD_A = '100000000000000001';
const MOD_B = '100000000000000002';
const TARGET_A = '200000000000000001';
const TARGET_B = '200000000000000002';

function search(input: CaseQueryInput = {}) {
  return service.search(GUILD, caseQuerySchema.parse(input));
}

interface Seed {
  n: number;
  type: string;
  actorId: string;
  targetId: string;
  day: string;
  guildId?: string;
}

const SEEDS: Seed[] = [
  { n: 1, type: 'unban', actorId: MOD_A, targetId: TARGET_A, day: '2026-01-05' },
  { n: 2, type: 'ban', actorId: MOD_A, targetId: TARGET_B, day: '2026-01-10' },
  { n: 3, type: 'timeout', actorId: MOD_B, targetId: TARGET_A, day: '2026-01-15' },
  { n: 4, type: 'ban', actorId: MOD_B, targetId: TARGET_A, day: '2026-02-01' },
  { n: 5, type: 'kick', actorId: MOD_A, targetId: TARGET_B, day: '2026-02-20' },
];

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:17-alpine').start();
  handle = createDb(container.getConnectionUri());
  await runMigrations(handle);

  service = new CaseQueryService(handle);

  await handle.db.insert(guilds).values([
    { id: GUILD, name: 'test guild' },
    { id: OTHER_GUILD, name: 'other guild' },
  ]);

  await handle.db.insert(cases).values(
    SEEDS.map((seed) => ({
      id: newId(),
      guildId: seed.guildId ?? GUILD,
      caseNumber: seed.n,
      type: seed.type,
      actorId: seed.actorId,
      targetId: seed.targetId,
      moduleId: 'moderation',
      dryRun: false,
      idempotencyKey: `seed-${seed.n}`,

      createdAt: new Date(`${seed.day}T12:00:00.000Z`),
    })),
  );

  await handle.db.insert(cases).values({
    id: newId(),
    guildId: OTHER_GUILD,
    caseNumber: 1,
    type: 'ban',
    actorId: MOD_A,
    targetId: TARGET_A,
    moduleId: 'moderation',
    dryRun: false,
    idempotencyKey: 'seed-other',
    createdAt: new Date('2026-01-10T12:00:00.000Z'),
  });
}, 240_000);

afterAll(async () => {
  await handle?.close();
  await container?.stop();
}, 240_000);

describe('filtering', () => {
  test('an unfiltered query returns the guild’s whole history', async () => {
    const result = await search();

    expect(result.total).toBe(SEEDS.length);
    expect(result.cases).toHaveLength(SEEDS.length);
  });

  test('never returns another guild’s cases', async () => {
    const neighbour = await service.search(OTHER_GUILD, caseQuerySchema.parse({}));
    const ours = await search();

    expect(neighbour.total).toBe(1);

    const ids = new Set(ours.cases.map((c) => c.id));
    expect(neighbour.cases.some((c) => ids.has(c.id))).toBe(false);
  });

  test('filters by action type', async () => {
    const result = await search({ type: 'ban' });

    expect(result.total).toBe(2);
    expect(result.cases.map((c) => c.caseNumber).sort()).toEqual([2, 4]);
  });

  test('finds one case by the id a moderator quotes, and nothing else', async () => {
    const all = await search({});
    const wanted = all.cases[0];
    if (!wanted) throw new Error('the seed inserted no cases');

    const result = await search({ caseId: wanted.id });

    expect(result.total).toBe(1);
    expect(result.cases[0]?.caseNumber).toBe(wanted.caseNumber);
  });

  // Case-sensitive on purpose: the alphabet has both K and k, so a lookup that ignored case would
  // answer with somebody else's case.
  test('a case id in the wrong case matches nothing', async () => {
    const all = await search({});
    const wanted = all.cases[0];
    if (!wanted) throw new Error('the seed inserted no cases');

    expect((await search({ caseId: wanted.id.toLowerCase() })).total).toBe(
      wanted.id === wanted.id.toLowerCase() ? 1 : 0,
    );
  });

  test('filters by moderator, matching the actor the recorder actually writes', async () => {
    const result = await search({ moderatorId: MOD_A });

    expect(result.total).toBe(3);
    expect(result.cases.every((c) => c.actorId === MOD_A)).toBe(true);
  });

  test('filters by target', async () => {
    const result = await search({ targetId: TARGET_B });

    expect(result.cases.map((c) => c.caseNumber).sort()).toEqual([2, 5]);
  });

  test('combines filters rather than widening them', async () => {
    const result = await search({ type: 'ban', moderatorId: MOD_B });

    expect(result.total).toBe(1);
    expect(result.cases[0]?.caseNumber).toBe(4);
  });

  test('a date range includes both of its end days in full', async () => {
    const result = await search({ from: '2026-01-05', to: '2026-01-10' });

    expect(result.cases.map((c) => c.caseNumber).sort()).toEqual([1, 2]);
  });

  test('a single-day range is not an empty range', async () => {
    const result = await search({ from: '2026-01-15', to: '2026-01-15' });

    expect(result.total).toBe(1);
    expect(result.cases[0]?.caseNumber).toBe(3);
  });

  test('a range that matches nothing returns zero rather than everything', async () => {
    expect((await search({ from: '2027-01-01' })).total).toBe(0);
  });
});

describe('sorting and paging', () => {
  test('defaults to newest first', async () => {
    const result = await search();

    expect(result.cases.map((c) => c.caseNumber)).toEqual([5, 4, 3, 2, 1]);
  });

  test('sorts by case number in both directions', async () => {
    expect(
      (await search({ sort: 'caseNumber', direction: 'asc' })).cases.map((c) => c.caseNumber),
    ).toEqual([1, 2, 3, 4, 5]);
    expect(
      (await search({ sort: 'caseNumber', direction: 'desc' })).cases.map((c) => c.caseNumber),
    ).toEqual([5, 4, 3, 2, 1]);
  });

  test('total counts every match, not just the page', async () => {
    const result = await search({ pageSize: 2 });

    expect(result.cases).toHaveLength(2);
    expect(result.total).toBe(5);
    expect(result.pageSize).toBe(2);
  });

  test('pages do not overlap or skip rows', async () => {
    const seen: number[] = [];
    for (const page of [1, 2, 3]) {
      const result = await search({ page, pageSize: 2, sort: 'caseNumber', direction: 'asc' });
      seen.push(...result.cases.map((c) => c.caseNumber));
    }

    expect(seen).toEqual([1, 2, 3, 4, 5]);
  });

  test('a page past the end is empty but still reports the true total', async () => {
    const result = await search({ page: 99 });

    expect(result.cases).toEqual([]);
    expect(result.total).toBe(5);
    expect(result.page).toBe(99);
  });
});

describe('the wire shape', () => {
  test('timestamps cross as ISO strings and payloads never leave the API', async () => {
    const [first] = (await search({ pageSize: 1 })).cases;

    expect(typeof first?.createdAt).toBe('string');
    expect(first?.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(first).not.toHaveProperty('payload');
  });
});
