import { cases, type DbHandle } from '@proton/db';
import { and, count, eq, gte, inArray, isNull, or } from 'drizzle-orm';
import type { CaseCountQuery, CaseHistoryStore } from './history.ts';

export class DrizzleCaseHistoryStore implements CaseHistoryStore {
  readonly #handle: DbHandle;

  constructor(handle: DbHandle) {
    this.#handle = handle;
  }

  async countByTarget(query: CaseCountQuery): Promise<Map<string, number>> {
    const userIds = [...new Set(query.userIds)];
    if (userIds.length === 0 || query.types.length === 0) return new Map();

    const filters = [
      eq(cases.guildId, query.guildId),
      inArray(cases.targetId, userIds),
      inArray(cases.type, [...query.types]),
      // A dry run never happened to the member, so counting it would refuse somebody an entry on
      // the strength of a moderation action nobody took.
      eq(cases.dryRun, false),
    ];

    if (query.since) filters.push(gte(cases.createdAt, query.since));

    if (query.activeAt) {
      filters.push(isNull(cases.revertedAt));
      const stillInForce = or(isNull(cases.expiresAt), gte(cases.expiresAt, query.activeAt));
      if (stillInForce) filters.push(stillInForce);
    }

    const rows = await this.#handle.db
      .select({ targetId: cases.targetId, value: count() })
      .from(cases)
      .where(and(...filters))
      .groupBy(cases.targetId);

    const counts = new Map<string, number>();
    for (const row of rows) {
      if (row.targetId !== null) counts.set(row.targetId, row.value);
    }

    return counts;
  }
}
