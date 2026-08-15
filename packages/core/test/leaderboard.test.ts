import { describe, expect, test } from 'bun:test';
import {
  LEADERBOARD_PAGE_SIZE_DEFAULT,
  LEADERBOARD_PAGE_SIZE_MAX,
  leaderboardQuerySchema,
} from '../src/leaderboard.ts';

describe('leaderboardQuerySchema', () => {
  test('defaults to the first page', () => {
    expect(leaderboardQuerySchema.parse({})).toEqual({
      page: 1,
      pageSize: LEADERBOARD_PAGE_SIZE_DEFAULT,
    });
  });

  test('rejects a page below one, which would compute a negative offset', () => {
    expect(leaderboardQuerySchema.safeParse({ page: 0 }).success).toBe(false);
    expect(leaderboardQuerySchema.safeParse({ page: -3 }).success).toBe(false);
  });

  test('caps the page size, so a shared URL cannot ask for every member at once', () => {
    expect(leaderboardQuerySchema.safeParse({ pageSize: LEADERBOARD_PAGE_SIZE_MAX }).success).toBe(
      true,
    );
    expect(
      leaderboardQuerySchema.safeParse({ pageSize: LEADERBOARD_PAGE_SIZE_MAX + 1 }).success,
    ).toBe(false);
  });

  test('rejects non-integers', () => {
    expect(leaderboardQuerySchema.safeParse({ page: 1.5 }).success).toBe(false);
  });

  test('is the same schema the URL and the API both validate against', () => {
    const fromUrl = leaderboardQuerySchema.parse({ page: 3, pageSize: 10 });

    expect(fromUrl).toEqual({ page: 3, pageSize: 10 });
  });
});
