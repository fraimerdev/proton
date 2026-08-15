import { z } from 'zod';

export const LEADERBOARD_PAGE_SIZE_DEFAULT = 25;
export const LEADERBOARD_PAGE_SIZE_MAX = 100;

export const leaderboardQuerySchema = z.object({
  page: z.number().int().min(1).default(1),
  pageSize: z
    .number()
    .int()
    .min(1)
    .max(LEADERBOARD_PAGE_SIZE_MAX)
    .default(LEADERBOARD_PAGE_SIZE_DEFAULT),
});

export type LeaderboardQuery = z.infer<typeof leaderboardQuerySchema>;
export type LeaderboardQueryInput = z.input<typeof leaderboardQuerySchema>;

export interface LeaderboardRow {
  userId: string;
  xp: number;
  level: number;
  rank: number;
}

export interface LeaderboardResult {
  entries: LeaderboardRow[];
  total: number;
  page: number;
  pageSize: number;
}
