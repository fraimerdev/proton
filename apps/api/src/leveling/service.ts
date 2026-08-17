import type { LeaderboardQuery, LeaderboardResult } from '@proton/core';
import type { DbHandle } from '@proton/db';
import { members } from '@proton/db/schema';
import { levelForXp } from '@proton/module-leveling/curve';
import { and, count, desc, eq, gt } from 'drizzle-orm';

export class LeaderboardService {
  readonly #db: DbHandle;

  constructor(db: DbHandle) {
    this.#db = db;
  }

  async search(guildId: string, query: LeaderboardQuery): Promise<LeaderboardResult> {
    // `xp > 0` matches the partial the leaderboard index is built for; without it every member
    // who never spoke sits at the bottom of every page.
    const where = and(eq(members.guildId, guildId), gt(members.xp, 0));
    const offset = (query.page - 1) * query.pageSize;

    const rows = await this.#db.db
      .select({ userId: members.userId, xp: members.xp })
      .from(members)
      .where(where)
      .orderBy(desc(members.xp), members.userId)
      .limit(query.pageSize)
      .offset(offset);

    const totals = await this.#db.db.select({ total: count() }).from(members).where(where);

    return {
      entries: rows.map((row, index) => ({
        userId: row.userId,
        xp: row.xp,
        // Derived, never read from `members.level` — that column is a cache and this is the one
        // place a stale write would be visible to every member at once.
        level: levelForXp(row.xp),
        rank: offset + index + 1,
      })),
      total: totals[0]?.total ?? 0,
      page: query.page,
      pageSize: query.pageSize,
    };
  }
}
