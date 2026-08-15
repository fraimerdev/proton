import type { CaseQuery, CaseRecord, CaseSearchResult } from '@proton/core';
import type { DbHandle } from '@proton/db';
import { cases } from '@proton/db/schema';
import { and, asc, count, desc, eq, gte, lte, or, type SQL } from 'drizzle-orm';

/**
 * The single definition of "search a guild's moderation history" (PLAN.md §9).
 *
 * It lives here and not in a dashboard server function so the worker can answer
 * `/history` from the same query the dashboard's table uses — one definition of
 * what a case search means, as §9 requires of every domain operation.
 */
export class CaseQueryService {
  readonly #db: DbHandle;

  constructor(db: DbHandle) {
    this.#db = db;
  }

  /**
   * Page through a guild's cases.
   *
   * The guild id is a parameter rather than a filter the caller may omit: every
   * caller has already had its access to that guild checked (I6), and a query
   * that could accidentally span guilds would leak one server's moderation
   * history into another's dashboard.
   */
  async search(guildId: string, query: CaseQuery): Promise<CaseSearchResult> {
    const where = and(eq(cases.guildId, guildId), ...this.#filters(query));

    const column = query.sort === 'caseNumber' ? cases.caseNumber : cases.createdAt;
    const order = query.direction === 'asc' ? asc(column) : desc(column);

    const rows = await this.#db.db
      .select()
      .from(cases)
      .where(where)
      // `created_at` is not unique — two actions in the same millisecond would
      // otherwise be ordered arbitrarily, and an unstable order across pages
      // makes rows appear twice or vanish while paging.
      .orderBy(order, desc(cases.caseNumber))
      .limit(query.pageSize)
      .offset((query.page - 1) * query.pageSize);

    const totals = await this.#db.db.select({ total: count() }).from(cases).where(where);

    return {
      cases: rows.map(toRecord),
      total: totals[0]?.total ?? 0,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  #filters(query: CaseQuery): SQL[] {
    const filters: SQL[] = [];

    if (query.type !== undefined) filters.push(eq(cases.type, query.type));

    if (query.moderatorId !== undefined) {
      // Both columns, because `DrizzleCaseRecorder` writes the invoking
      // moderator to `actor_id` and leaves `moderator_id` null. Matching only
      // `moderator_id` would return nothing for every case recorded to date —
      // an empty table that reads as "this moderator has done nothing".
      const either = or(
        eq(cases.actorId, query.moderatorId),
        eq(cases.moderatorId, query.moderatorId),
      );
      if (either) filters.push(either);
    }

    if (query.targetId !== undefined) filters.push(eq(cases.targetId, query.targetId));

    // `from`/`to` are UTC calendar dates. `to` covers the whole day, so a range
    // of one day is not an empty range.
    if (query.from !== undefined) {
      filters.push(gte(cases.createdAt, new Date(`${query.from}T00:00:00.000Z`)));
    }
    if (query.to !== undefined) {
      filters.push(lte(cases.createdAt, new Date(`${query.to}T23:59:59.999Z`)));
    }

    return filters;
  }
}

function toRecord(row: typeof cases.$inferSelect): CaseRecord {
  return {
    id: row.id,
    caseNumber: row.caseNumber,
    type: row.type,
    actorId: row.actorId,
    targetId: row.targetId,
    moderatorId: row.moderatorId,
    reason: row.reason,
    moduleId: row.moduleId,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    revertedAt: row.revertedAt?.toISOString() ?? null,
    revertedBy: row.revertedBy,
    dryRun: row.dryRun,
    createdAt: row.createdAt.toISOString(),
  };
}
