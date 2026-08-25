import type { TicketPriority } from '@proton/core';
import type { DbHandle } from '@proton/db';
import {
  DrizzleTicketStore,
  type TicketStats,
  type TicketStatus,
  type TicketStore,
} from '@proton/module-tickets';
import {
  type TicketQuery,
  type TicketSearchResult,
  type TicketStatsQuery,
  toSummary,
} from '@proton/module-tickets/query';
import { tickets } from '@proton/module-tickets/table';
import { and, asc, count, desc, eq, sql } from 'drizzle-orm';

const DAY_MS = 86_400_000;

const COLUMNS = {
  number: tickets.number,
  openedAt: tickets.openedAt,
  closedAt: tickets.closedAt,
} as const;

const SUMMARY = {
  id: tickets.id,
  number: tickets.number,
  typeId: tickets.typeId,
  panelId: tickets.panelId,
  channelId: tickets.channelId,
  status: sql<TicketStatus>`${tickets.status}`,
  priority: sql<TicketPriority>`${tickets.priority}`,
  subject: tickets.subject,
  openerId: tickets.openerId,
  ownerId: tickets.ownerId,
  claimedById: tickets.claimedById,
  assignedToId: tickets.assignedToId,
  closedBy: tickets.closedBy,
  closeReason: tickets.closeReason,
  messageCount: tickets.messageCount,
  transcriptUrl: tickets.transcriptUrl,
  openedAt: tickets.openedAt,
  lastActivityAt: tickets.lastActivityAt,
  closedAt: tickets.closedAt,
} as const;

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

export class TicketSearchService {
  readonly #db: DbHandle;
  readonly #store: TicketStore;

  constructor(db: DbHandle) {
    this.#db = db;
    this.#store = new DrizzleTicketStore(db);
  }

  async search(guildId: string, query: TicketQuery): Promise<TicketSearchResult> {
    const search = query.search?.trim().toLowerCase();

    const where = and(
      eq(tickets.guildId, guildId),
      query.status ? eq(tickets.status, query.status) : undefined,
      query.priority ? eq(tickets.priority, query.priority) : undefined,
      query.typeId ? eq(tickets.typeId, query.typeId) : undefined,
      query.ownerId ? eq(tickets.ownerId, query.ownerId) : undefined,
      search
        ? sql`lower(${tickets.subject}) like ${`%${escapeLike(search)}%`} escape '\\'`
        : undefined,
    );

    const column = COLUMNS[query.sort];
    const order = query.direction === 'desc' ? desc(column) : asc(column);

    // Sorting by number already is the tie-break, and repeating it emits `order by number desc,
    // number desc` — valid, but it reads as a mistake to whoever finds it in a slow-query log.
    const ordering = query.sort === 'number' ? [order] : [order, desc(tickets.number)];

    const [rows, totals] = await Promise.all([
      this.#db.db
        .select(SUMMARY)
        .from(tickets)
        .where(where)
        // The number breaks every tie: two tickets opened in the same second would otherwise swap
        // places between pages and the reader would see one twice and miss another.
        .orderBy(...ordering)
        .limit(query.pageSize)
        .offset((query.page - 1) * query.pageSize),
      this.#db.db.select({ value: count() }).from(tickets).where(where),
    ]);

    return {
      tickets: rows.map(toSummary),
      total: totals[0]?.value ?? 0,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  stats(guildId: string, query: TicketStatsQuery): Promise<TicketStats> {
    return this.#store.stats(guildId, new Date(Date.now() - query.days * DAY_MS));
  }
}
