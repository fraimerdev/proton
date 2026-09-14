import { auditTrail, type DbHandle } from '@proton/db';
import { and, asc, count, eq, gt, lt, lte, sql } from 'drizzle-orm';
import { type XpEventRow, xpEvents } from './xp-event-table.ts';
import type {
  CreateXpEventInput,
  CreateXpEventResult,
  EndXpEventAudit,
  EndXpEventResult,
  XpEvent,
  XpEventStore,
} from './xp-events.ts';

function toEvent(row: XpEventRow): XpEvent {
  return {
    guildId: row.guildId,
    id: row.id,
    multiplier: row.multiplierTenths / 10,
    startsAt: row.startsAt.getTime(),
    endsAt: row.endsAt.getTime(),
    createdBy: row.createdBy,
    createdAt: row.createdAt.getTime(),
  };
}

export class DrizzleXpEventStore implements XpEventStore {
  readonly #handle: DbHandle;

  constructor(handle: DbHandle) {
    this.#handle = handle;
  }

  async overlapping(guildId: string, from: number, to: number): Promise<XpEvent[]> {
    const rows = await this.#handle.db
      .select()
      .from(xpEvents)
      .where(
        and(
          eq(xpEvents.guildId, guildId),
          lt(xpEvents.startsAt, new Date(to)),
          gt(xpEvents.endsAt, new Date(from)),
        ),
      )
      .orderBy(asc(xpEvents.startsAt), asc(xpEvents.id));

    return rows.map(toEvent);
  }

  async pending(guildId: string, now: number): Promise<XpEvent[]> {
    const rows = await this.#handle.db
      .select()
      .from(xpEvents)
      .where(and(eq(xpEvents.guildId, guildId), gt(xpEvents.endsAt, new Date(now))))
      .orderBy(asc(xpEvents.startsAt), asc(xpEvents.id));

    return rows.map(toEvent);
  }

  async create(input: CreateXpEventInput): Promise<CreateXpEventResult> {
    return this.#handle.db.transaction(async (tx) => {
      // Serialises creates per guild: two at once would both count four and both insert a fifth.
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${`xp_events:${input.guildId}`}))`,
      );

      const existing = await tx
        .select()
        .from(xpEvents)
        .where(and(eq(xpEvents.guildId, input.guildId), eq(xpEvents.id, input.id)))
        .limit(1);

      const found = existing[0];
      if (found) return { status: 'exists', event: toEvent(found) };

      const [tally] = await tx
        .select({ pending: count() })
        .from(xpEvents)
        .where(and(eq(xpEvents.guildId, input.guildId), gt(xpEvents.endsAt, new Date(input.now))));

      const pending = tally?.pending ?? 0;
      if (pending >= input.maxPending) return { status: 'full', pending };

      const inserted = await tx
        .insert(xpEvents)
        .values({
          guildId: input.guildId,
          id: input.id,
          multiplierTenths: Math.round(input.multiplier * 10),
          startsAt: new Date(input.startsAt),
          endsAt: new Date(input.endsAt),
          createdBy: input.createdBy,
          createdAt: new Date(input.now),
        })
        .returning();

      const row = inserted[0];
      if (!row) throw new Error('xp_events insert returned no row, which should not be possible');

      return { status: 'created', event: toEvent(row) };
    });
  }

  async end(
    guildId: string,
    id: string,
    now: number,
    audit?: EndXpEventAudit,
  ): Promise<EndXpEventResult> {
    const at = new Date(now);

    return this.#handle.db.transaction(async (tx) => {
      const ended = await tx
        .update(xpEvents)
        .set({ endsAt: at })
        .where(
          and(
            eq(xpEvents.guildId, guildId),
            eq(xpEvents.id, id),
            lte(xpEvents.startsAt, at),
            gt(xpEvents.endsAt, at),
          ),
        )
        .returning({ id: xpEvents.id });

      let result: EndXpEventResult = 'ended';

      if (ended.length === 0) {
        const cancelled = await tx
          .delete(xpEvents)
          .where(and(eq(xpEvents.guildId, guildId), eq(xpEvents.id, id), gt(xpEvents.startsAt, at)))
          .returning({ id: xpEvents.id });

        result = cancelled.length > 0 ? 'cancelled' : 'not_found';
      }

      // Same transaction: an end that commits without its audit row can never be audited later.
      if (result !== 'not_found' && audit) await tx.insert(auditTrail).values(audit(result));

      return result;
    });
  }

  async purgeEndedBefore(guildId: string, before: number): Promise<number> {
    const rows = await this.#handle.db
      .delete(xpEvents)
      .where(and(eq(xpEvents.guildId, guildId), lt(xpEvents.endsAt, new Date(before))))
      .returning({ id: xpEvents.id });

    return rows.length;
  }
}
