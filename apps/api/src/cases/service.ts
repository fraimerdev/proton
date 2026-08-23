import type { CaseQuery, CaseRecord, CaseSearchResult } from '@proton/core';
import type { DbHandle } from '@proton/db';
import { cases } from '@proton/db/schema';
import { and, asc, count, desc, eq, gte, lte, or, type SQL } from 'drizzle-orm';

export class CaseQueryService {
  readonly #db: DbHandle;

  constructor(db: DbHandle) {
    this.#db = db;
  }

  async search(guildId: string, query: CaseQuery): Promise<CaseSearchResult> {
    const where = and(eq(cases.guildId, guildId), ...this.#filters(query));

    const column = query.sort === 'caseNumber' ? cases.caseNumber : cases.createdAt;
    const order = query.direction === 'asc' ? asc(column) : desc(column);

    const rows = await this.#db.db
      .select()
      .from(cases)
      .where(where)

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

    if (query.caseId !== undefined) filters.push(eq(cases.id, query.caseId));

    if (query.type !== undefined) filters.push(eq(cases.type, query.type));

    if (query.moderatorId !== undefined) {
      const either = or(
        eq(cases.actorId, query.moderatorId),
        eq(cases.moderatorId, query.moderatorId),
      );
      if (either) filters.push(either);
    }

    if (query.targetId !== undefined) filters.push(eq(cases.targetId, query.targetId));

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
