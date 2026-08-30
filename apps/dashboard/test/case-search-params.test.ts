import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CASE_PAGE_SIZE_MAX, type CaseQueryInput, caseQuerySchema } from '@proton/core';
import { defaultParseSearch, defaultStringifySearch } from '@tanstack/react-router';
import { zodValidator } from '@tanstack/zod-adapter';
import { z } from 'zod';
import { type ModuleView, parseViewSearch } from '../src/components/module/views.ts';
import { pageSizeOf } from '../src/components/views/views.tsx';

function roundTrip(input: CaseQueryInput) {
  return caseQuerySchema.parse(defaultParseSearch(defaultStringifySearch(input)));
}

/**
 * A copy, not the import: moduleSearchSchema lives in components/module/route.tsx, which reaches
 * lib/queries and through it the database at module scope. view-registry.test.tsx pins the real
 * declaration against the route's source, so a change there fails rather than leaving this loose.
 */
const moduleSearchSchema = z.looseObject({
  view: z.unknown().optional(),
  area: z.unknown().optional(),
});

const routeValidator = zodValidator(moduleSearchSchema);

const ROUTES = join(import.meta.dir, '..', 'src', 'routes', 'dashboard', '$guildId');

const DECLARED_VIEW = /\{ id: '([^']+)', title: '([^']+)', searchSchema: ([A-Za-z0-9_]+),/;

/**
 * There is no MODULE_VIEWS any more: the cases route declares its own VIEWS inline, and that file
 * cannot be imported either. The entry is rebuilt from what the route actually declares, so a route
 * that stops filtering with caseQuerySchema fails here instead of leaving this file exercising a
 * fossil — the same guard the old activeView('cases', 'cases') lookup gave.
 */
function casesView(): ModuleView {
  const source = readFileSync(join(ROUTES, 'cases.tsx'), 'utf8').replace(/\s+/g, ' ');
  const [, id, title, schema] = DECLARED_VIEW.exec(source) ?? [];

  if (id !== 'cases' || schema !== 'caseQuerySchema' || title === undefined)
    throw new Error("the cases route registers no 'cases' view filtered by caseQuerySchema");

  return {
    id,
    title,
    searchSchema: caseQuerySchema,
    query: ({ guildId }) => ({ queryKey: [guildId, 'cases'], queryFn: async () => undefined }),
    View: () => null,
  };
}

function fromUrl(url: string): unknown {
  return parseViewSearch(casesView(), routeValidator.parse(defaultParseSearch(url)));
}

describe('case filters survive a URL round trip', () => {
  test('a fully specified filter set comes back identical', () => {
    const filters = {
      caseId: 'K7f3M2q',
      type: 'ban',
      moderatorId: '100000000000000001',
      targetId: '200000000000000002',
      from: '2026-01-01',
      to: '2026-01-31',
      sort: 'caseNumber',
      direction: 'asc',
      page: 3,
      pageSize: 25,
    } as const;

    expect(roundTrip(filters)).toEqual(filters);
  });

  test('a case id keeps its case through the URL, since K7f3M2q and k7F3m2Q differ', () => {
    expect(roundTrip({ caseId: 'K7f3M2q' }).caseId).toBe('K7f3M2q');
  });

  test('a case id recorded before ids were shortened is still searchable', () => {
    expect(roundTrip({ caseId: '01JG7Z9V4K8QW2RSTUVWXYZABC' }).caseId).toBe(
      '01JG7Z9V4K8QW2RSTUVWXYZABC',
    );
  });

  test('something that is not a case id is refused rather than searched for', () => {
    expect(caseQuerySchema.safeParse({ caseId: 'K7f3 M2q' }).success).toBe(false);
    expect(caseQuerySchema.safeParse({ caseId: '' }).success).toBe(false);
  });

  test('numeric filters keep their type through the URL', () => {
    const url = defaultStringifySearch({ page: 12, pageSize: 25 });

    expect(url).toContain('page=12');

    expect((defaultParseSearch(url) as { page: unknown }).page).toBe(12);
    expect(roundTrip({ page: 12 }).page).toBe(12);
  });

  test('an empty URL yields the declared defaults, not empty filters', () => {
    expect(roundTrip({})).toEqual({
      sort: 'createdAt',
      direction: 'desc',
      page: 1,
      pageSize: 50,
    });
  });

  test('a cleared filter stays absent rather than becoming empty', () => {
    const result = roundTrip({ type: undefined, targetId: undefined, page: 2 });

    expect(result).not.toHaveProperty('type');
    expect(result).not.toHaveProperty('targetId');
    expect(result.page).toBe(2);
  });

  test('the sort a header click writes is the sort the URL gives back', () => {
    for (const sort of ['createdAt', 'caseNumber'] as const) {
      for (const direction of ['asc', 'desc'] as const) {
        expect(roundTrip({ sort, direction })).toMatchObject({ sort, direction });
      }
    }
  });
});

describe('the cases tab rejects what the API would reject', () => {
  test('a hand-edited URL with a bad snowflake is refused, not silently ignored', () => {
    expect(() => fromUrl('?view=cases&targetId=not-an-id')).toThrow(/snowflake/);
  });

  test('an unknown action kind is refused', () => {
    expect(() => fromUrl('?view=cases&type=explode')).toThrow();
  });

  test('a reversed date range is refused with a readable message', () => {
    expect(() => fromUrl('?view=cases&from=2026-05-01&to=2026-01-01')).toThrow(/must not be after/);
  });

  test('a page size beyond the cap is refused rather than clamped', () => {
    expect(() => fromUrl('?view=cases&pageSize=100000')).toThrow();
  });

  test('a hand-typed unquoted id is refused with the reason, because coercing it would be wrong', () => {
    expect(() => fromUrl('?view=cases&targetId=200000000000000002')).toThrow(/targetId="2000…"/);
    expect(() => fromUrl('?view=cases&targetId=200000000000000002')).toThrow(
      /loses its last digits/,
    );
    expect(() => fromUrl('?view=cases&moderatorId=100000000000000001')).toThrow(
      /moderatorId="2000…"/,
    );
  });

  test('the id the dashboard writes into its own links is quoted and survives untouched', () => {
    const url = defaultStringifySearch({ view: 'cases', targetId: '200000000000000002' });

    expect(url).toContain('%22200000000000000002%22');
    expect(fromUrl(url)).toMatchObject({ targetId: '200000000000000002' });
  });

  test('an unquoted id that is not a snowflake keeps the filter-specific message it already had', () => {
    expect(() => fromUrl('?view=cases&targetId=not-an-id')).not.toThrow(/has to be quoted/);
  });

  test('the tab parses a valid URL into the same object the schema does', () => {
    const url = '?view=cases&type=timeout&page=2';

    expect(fromUrl(url)).toEqual(caseQuerySchema.parse(defaultParseSearch('?type=timeout&page=2')));
  });
});

describe('the per-page filter cannot push the ledger out of its own schema', () => {
  test('a value above the ceiling clamps instead of failing validateSearch', () => {
    expect(pageSizeOf('500')).toBe(CASE_PAGE_SIZE_MAX);
    expect(() => caseQuerySchema.parse({ pageSize: pageSizeOf('500') })).not.toThrow();
  });

  test('zero and negatives clamp to the floor', () => {
    expect(pageSizeOf('0')).toBe(1);
    expect(pageSizeOf('-40')).toBe(1);
  });

  test('an empty box and unparseable text both mean "unset", not NaN', () => {
    expect(pageSizeOf('')).toBeUndefined();
    expect(pageSizeOf('   ')).toBeUndefined();
    expect(pageSizeOf('abc')).toBeUndefined();
  });

  test('a fractional value truncates to a whole number of rows', () => {
    expect(pageSizeOf('25.7')).toBe(25);
  });
});
