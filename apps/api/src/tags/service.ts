import type { DbHandle } from '@proton/db';
import { type TagQuery, type TagSearchResult, toSummary } from '@proton/module-tags/query';
import { tags } from '@proton/module-tags/table';
import { and, asc, count, desc, eq, sql } from 'drizzle-orm';

const COLUMNS = {
  name: tags.name,
  uses: tags.uses,
  createdAt: tags.createdAt,
} as const;

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

export class TagSearchService {
  readonly #db: DbHandle;

  constructor(db: DbHandle) {
    this.#db = db;
  }

  async search(guildId: string, query: TagQuery): Promise<TagSearchResult> {
    const search = query.search?.trim().toLowerCase();

    const where = search
      ? and(
          eq(tags.guildId, guildId),
          sql`${tags.name} like ${`%${escapeLike(search)}%`} escape '\\'`,
        )
      : eq(tags.guildId, guildId);

    const column = COLUMNS[query.sort];
    const order = query.direction === 'desc' ? desc(column) : asc(column);

    const [rows, totals] = await Promise.all([
      this.#db.db
        .select()
        .from(tags)
        .where(where)
        // Name breaks every tie: two tags with the same use count would otherwise swap places
        // between pages and the reader would see one twice and miss another.
        .orderBy(order, asc(tags.name))
        .limit(query.pageSize)
        .offset((query.page - 1) * query.pageSize),
      this.#db.db.select({ value: count() }).from(tags).where(where),
    ]);

    return {
      tags: rows.map(toSummary),
      total: totals[0]?.value ?? 0,
      page: query.page,
      pageSize: query.pageSize,
    };
  }
}
