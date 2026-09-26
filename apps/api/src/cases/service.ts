import {
  type CaseQuery,
  type CaseRecord,
  type CaseSearchResult,
  isReversalIdempotencyKey,
  MODERATION_ACTION_KINDS,
  reversalIdempotencyKey,
  snowflakeSchema,
} from '@proton/core';
import type { DbHandle } from '@proton/db';
import { cases } from '@proton/db/schema';
import { and, asc, count, desc, eq, gte, inArray, lte, notLike, or, type SQL } from 'drizzle-orm';

const REVERSAL_KEY_PREFIX = reversalIdempotencyKey('');

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
      cases: rows.map(toCaseRecord),
      total: totals[0]?.total ?? 0,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  #filters(query: CaseQuery): SQL[] {
    const filters: SQL[] = [];

    if (query.caseId !== undefined) filters.push(eq(cases.id, query.caseId));

    if (query.scope === 'moderation') {
      filters.push(inArray(cases.type, [...MODERATION_ACTION_KINDS]));
    }

    if (query.type !== undefined) filters.push(eq(cases.type, query.type));

    if (query.moderatorId !== undefined) {
      const either = or(
        eq(cases.moderatorId, query.moderatorId),
        and(
          eq(cases.actorId, query.moderatorId),
          notLike(cases.idempotencyKey, `${REVERSAL_KEY_PREFIX}%`),
        ),
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

function caseModerator(row: typeof cases.$inferSelect): string | null {
  if (row.moderatorId !== null) return row.moderatorId;
  if (isReversalIdempotencyKey(row.idempotencyKey)) return null;

  return row.actorId !== null && snowflakeSchema.safeParse(row.actorId).success
    ? row.actorId
    : null;
}

export function toCaseRecord(row: typeof cases.$inferSelect): CaseRecord {
  return {
    id: row.id,
    caseNumber: row.caseNumber,
    type: row.type,
    actorId: row.actorId,
    targetId: row.targetId,
    moderatorId: caseModerator(row),
    reason: row.reason,
    moduleId: row.moduleId,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    revertedAt: row.revertedAt?.toISOString() ?? null,
    revertedBy: row.revertedBy,
    dryRun: row.dryRun,
    createdAt: row.createdAt.toISOString(),
  };
}
