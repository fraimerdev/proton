import { describe, expect, test } from 'bun:test';
import { type CaseQueryInput, caseQuerySchema } from '@proton/core';
import { defaultParseSearch, defaultStringifySearch } from '@tanstack/react-router';
import { zodValidator } from '@tanstack/zod-adapter';

function roundTrip(input: CaseQueryInput) {
  return caseQuerySchema.parse(defaultParseSearch(defaultStringifySearch(input)));
}

const validator = zodValidator(caseQuerySchema);

describe('case filters survive a URL round trip', () => {
  test('a fully specified filter set comes back identical', () => {
    const filters = {
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

describe('the router adapter rejects what the API would reject', () => {
  test('a hand-edited URL with a bad snowflake is refused, not silently ignored', () => {
    expect(() => validator.parse(defaultParseSearch('?targetId=not-an-id'))).toThrow(/snowflake/);
  });

  test('an unknown action kind is refused', () => {
    expect(() => validator.parse(defaultParseSearch('?type=explode'))).toThrow();
  });

  test('a reversed date range is refused with a readable message', () => {
    expect(() => validator.parse(defaultParseSearch('?from=2026-05-01&to=2026-01-01'))).toThrow(
      /must not be after/,
    );
  });

  test('a page size beyond the cap is refused rather than clamped', () => {
    expect(() => validator.parse(defaultParseSearch('?pageSize=100000'))).toThrow();
  });

  test('the adapter parses a valid URL into the same object the schema does', () => {
    const url = '?type=timeout&page=2';

    expect(validator.parse(defaultParseSearch(url))).toEqual(
      caseQuerySchema.parse(defaultParseSearch(url)),
    );
  });
});
