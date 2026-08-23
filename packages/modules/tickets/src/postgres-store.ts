import { newId } from '@proton/core';
import type { DbHandle } from '@proton/db';
import { and, asc, count, eq, lt, sql } from 'drizzle-orm';
import type {
  CloseTicketInput,
  ReserveTicketInput,
  Ticket,
  TicketStatus,
  TicketStore,
} from './store.ts';
import { type TicketRow, tickets } from './table.ts';

function toTicket(row: TicketRow): Ticket {
  return {
    id: row.id,
    guildId: row.guildId,
    number: row.number,
    panelId: row.panelId,
    channelId: row.channelId,
    openerId: row.openerId,
    status: row.status as TicketStatus,
    openedAt: row.openedAt,
    lastActivityAt: row.lastActivityAt,
    closedAt: row.closedAt,
    closedBy: row.closedBy,
    closeReason: row.closeReason,
  };
}

export class DrizzleTicketStore implements TicketStore {
  readonly #handle: DbHandle;

  constructor(handle: DbHandle) {
    this.#handle = handle;
  }

  async reserve(input: ReserveTicketInput): Promise<Ticket> {
    const id = newId();

    const rows = await this.#handle.db
      .insert(tickets)
      .values({
        id,
        guildId: input.guildId,
        // The same idiom as cases.case_number: allocated inside the insert, guarded by the unique
        // index, so two members opening at once cannot both take the same number.
        number: sql<number>`(select coalesce(max(${tickets.number}), 0) + 1 from ${tickets} where ${tickets.guildId} = ${input.guildId})`,
        panelId: input.panelId,
        channelId: id,
        openerId: input.openerId,
      })
      .returning();

    const row = rows[0];
    if (!row) throw new Error('the ticket row was not written');

    return toTicket(row);
  }

  async attach(guildId: string, ticketId: string, channelId: string): Promise<Ticket | null> {
    const rows = await this.#handle.db
      .update(tickets)
      .set({ channelId })
      .where(and(eq(tickets.guildId, guildId), eq(tickets.id, ticketId)))
      .returning();

    const row = rows[0];
    return row ? toTicket(row) : null;
  }

  async abandon(guildId: string, ticketId: string): Promise<void> {
    await this.#handle.db
      .delete(tickets)
      .where(and(eq(tickets.guildId, guildId), eq(tickets.id, ticketId)));
  }

  async get(guildId: string, ticketId: string): Promise<Ticket | null> {
    const rows = await this.#handle.db
      .select()
      .from(tickets)
      .where(and(eq(tickets.guildId, guildId), eq(tickets.id, ticketId)))
      .limit(1);

    const row = rows[0];
    return row ? toTicket(row) : null;
  }

  async byChannel(guildId: string, channelId: string): Promise<Ticket | null> {
    const rows = await this.#handle.db
      .select()
      .from(tickets)
      .where(
        and(
          eq(tickets.guildId, guildId),
          eq(tickets.channelId, channelId),
          eq(tickets.status, 'open'),
        ),
      )
      .limit(1);

    const row = rows[0];
    return row ? toTicket(row) : null;
  }

  async byNumber(guildId: string, number: number): Promise<Ticket | null> {
    const rows = await this.#handle.db
      .select()
      .from(tickets)
      .where(and(eq(tickets.guildId, guildId), eq(tickets.number, number)))
      .limit(1);

    const row = rows[0];
    return row ? toTicket(row) : null;
  }

  async countOpenFor(guildId: string, openerId: string): Promise<number> {
    const rows = await this.#handle.db
      .select({ value: count() })
      .from(tickets)
      .where(
        and(
          eq(tickets.guildId, guildId),
          eq(tickets.openerId, openerId),
          eq(tickets.status, 'open'),
        ),
      );

    return rows[0]?.value ?? 0;
  }

  async listOpen(guildId: string): Promise<Ticket[]> {
    const rows = await this.#handle.db
      .select()
      .from(tickets)
      .where(and(eq(tickets.guildId, guildId), eq(tickets.status, 'open')))
      .orderBy(asc(tickets.number));

    return rows.map(toTicket);
  }

  async close(input: CloseTicketInput): Promise<Ticket | null> {
    const rows = await this.#handle.db
      .update(tickets)
      .set({
        status: 'closed',
        closedAt: new Date(),
        closedBy: input.closedBy,
        closeReason: input.reason,
      })
      .where(
        and(
          eq(tickets.guildId, input.guildId),
          eq(tickets.id, input.ticketId),
          eq(tickets.status, 'open'),
        ),
      )
      .returning();

    const row = rows[0];
    return row ? toTicket(row) : null;
  }

  async touch(guildId: string, channelId: string, notBefore: Date): Promise<void> {
    await this.#handle.db
      .update(tickets)
      .set({ lastActivityAt: new Date() })
      .where(
        and(
          eq(tickets.guildId, guildId),
          eq(tickets.channelId, channelId),
          eq(tickets.status, 'open'),
          lt(tickets.lastActivityAt, notBefore),
        ),
      );
  }
}
