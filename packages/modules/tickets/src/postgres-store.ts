import { newId, type TicketPriority } from '@proton/core';
import type { DbHandle } from '@proton/db';
import { and, asc, count, desc, eq, gte, inArray, isNull, lt, lte, ne, or, sql } from 'drizzle-orm';
import type {
  BlacklistEntry,
  BlacklistInput,
  CaptureMessageInput,
  CloseTicketInput,
  ParticipantKind,
  RecordTicketEventInput,
  ReserveTicketInput,
  Ticket,
  TicketAttachment,
  TicketEvent,
  TicketFormAnswer,
  TicketMessage,
  TicketParticipant,
  TicketRating,
  TicketStats,
  TicketStatus,
  TicketStore,
  TicketWaitingOn,
} from './store.ts';
import {
  type TicketBlacklistRow,
  type TicketEventRow,
  type TicketMessageRow,
  type TicketRow,
  ticketBlacklist,
  ticketEvents,
  ticketFormAnswers,
  ticketMessages,
  ticketParticipants,
  ticketRatings,
  tickets,
} from './table.ts';

const NUMBER_CONFLICT = 'tickets_guild_number_uq';

const RESERVE_ATTEMPTS = 5;

function toTicket(row: TicketRow): Ticket {
  return {
    id: row.id,
    guildId: row.guildId,
    number: row.number,
    typeId: row.typeId,
    panelId: row.panelId,
    channelId: row.channelId,
    openerId: row.openerId,
    ownerId: row.ownerId,
    status: row.status as TicketStatus,
    priority: row.priority as TicketPriority,
    subject: row.subject,
    claimedById: row.claimedById,
    claimedAt: row.claimedAt,
    assignedToId: row.assignedToId,
    assignedById: row.assignedById,
    assignedAt: row.assignedAt,
    lockedAt: row.lockedAt,
    lockedById: row.lockedById,
    waitingOn: row.waitingOn as TicketWaitingOn,
    openedAt: row.openedAt,
    lastActivityAt: row.lastActivityAt,
    lastUserMessageAt: row.lastUserMessageAt,
    lastStaffMessageAt: row.lastStaffMessageAt,
    firstResponseAt: row.firstResponseAt,
    closeRequestedById: row.closeRequestedById,
    closeRequestedAt: row.closeRequestedAt,
    closedAt: row.closedAt,
    closedBy: row.closedBy,
    closeReason: row.closeReason,
    archivedAt: row.archivedAt,
    deletedAt: row.deletedAt,
    messageCount: row.messageCount,
    transcriptUrl: row.transcriptUrl,
  };
}

function toMessage(row: TicketMessageRow): TicketMessage {
  return {
    id: row.id,
    ticketId: row.ticketId,
    messageId: row.messageId,
    authorId: row.authorId,
    authorName: row.authorName,
    authorBot: row.authorBot,
    content: row.content,
    attachments: (row.attachments ?? []) as TicketAttachment[],
    embeds: (row.embeds ?? []) as Array<Record<string, unknown>>,
    replyToId: row.replyToId,
    createdAt: row.createdAt,
    editedAt: row.editedAt,
    deletedAt: row.deletedAt,
  };
}

function toBlacklist(row: TicketBlacklistRow): BlacklistEntry {
  return {
    id: row.id,
    guildId: row.guildId,
    userId: row.userId,
    reason: row.reason,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
  };
}

function toEvent(row: TicketEventRow): TicketEvent {
  return {
    id: row.id,
    ticketId: row.ticketId,
    guildId: row.guildId,
    type: row.type,
    actorId: row.actorId,
    data: (row.data ?? null) as Record<string, unknown> | null,
    at: row.at,
  };
}

function isNumberCollision(error: unknown): boolean {
  const shape = error as { code?: unknown; constraint_name?: unknown; constraint?: unknown };

  return (
    shape?.code === '23505' &&
    (shape.constraint_name === NUMBER_CONFLICT || shape.constraint === NUMBER_CONFLICT)
  );
}

export class DrizzleTicketStore implements TicketStore {
  readonly #handle: DbHandle;

  constructor(handle: DbHandle) {
    this.#handle = handle;
  }

  async reserve(input: ReserveTicketInput): Promise<Ticket> {
    // max(number)+1 races under READ COMMITTED and the unique index is what catches it, so the
    // loser retries rather than surfacing a 23505 at somebody who pressed a button. Same idiom as
    // DrizzleCaseRecorder.record.
    for (let attempt = 1; ; attempt += 1) {
      const id = newId();

      try {
        const rows = await this.#handle.db
          .insert(tickets)
          .values({
            id,
            guildId: input.guildId,
            number: sql<number>`(select coalesce(max(${tickets.number}), 0) + 1 from ${tickets} where ${tickets.guildId} = ${input.guildId})`,
            typeId: input.typeId,
            panelId: input.panelId,
            channelId: id,
            openerId: input.openerId,
            ownerId: input.openerId,
            priority: input.priority,
            ...(input.subject === undefined ? {} : { subject: input.subject }),
            waitingOn: 'staff',
          })
          .returning();

        const row = rows[0];
        if (!row) throw new Error('the ticket row was not written');

        return toTicket(row);
      } catch (error) {
        if (attempt >= RESERVE_ATTEMPTS || !isNumberCollision(error)) throw error;
      }
    }
  }

  async attach(guildId: string, ticketId: string, channelId: string): Promise<Ticket | null> {
    const rows = await this.#handle.db
      .update(tickets)
      .set({ channelId })
      .where(and(eq(tickets.guildId, guildId), eq(tickets.id, ticketId)))
      .returning();

    return rows[0] ? toTicket(rows[0]) : null;
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

    return rows[0] ? toTicket(rows[0]) : null;
  }

  async byChannel(guildId: string, channelId: string): Promise<Ticket | null> {
    const rows = await this.#handle.db
      .select()
      .from(tickets)
      .where(
        and(
          eq(tickets.guildId, guildId),
          eq(tickets.channelId, channelId),
          ne(tickets.status, 'deleted'),
        ),
      )
      .limit(1);

    return rows[0] ? toTicket(rows[0]) : null;
  }

  async byNumber(guildId: string, number: number): Promise<Ticket | null> {
    const rows = await this.#handle.db
      .select()
      .from(tickets)
      .where(and(eq(tickets.guildId, guildId), eq(tickets.number, number)))
      .limit(1);

    return rows[0] ? toTicket(rows[0]) : null;
  }

  async countOpenFor(guildId: string, ownerId: string): Promise<number> {
    const rows = await this.#handle.db
      .select({ value: count() })
      .from(tickets)
      .where(
        and(eq(tickets.guildId, guildId), eq(tickets.ownerId, ownerId), eq(tickets.status, 'open')),
      );

    return rows[0]?.value ?? 0;
  }

  async countOpenForType(guildId: string, ownerId: string, typeId: string): Promise<number> {
    const rows = await this.#handle.db
      .select({ value: count() })
      .from(tickets)
      .where(
        and(
          eq(tickets.guildId, guildId),
          eq(tickets.ownerId, ownerId),
          eq(tickets.typeId, typeId),
          eq(tickets.status, 'open'),
        ),
      );

    return rows[0]?.value ?? 0;
  }

  async countOpen(guildId: string): Promise<number> {
    const rows = await this.#handle.db
      .select({ value: count() })
      .from(tickets)
      .where(and(eq(tickets.guildId, guildId), eq(tickets.status, 'open')));

    return rows[0]?.value ?? 0;
  }

  async lastOpenedAt(guildId: string, openerId: string): Promise<Date | null> {
    const rows = await this.#handle.db
      .select({ at: tickets.openedAt })
      .from(tickets)
      .where(and(eq(tickets.guildId, guildId), eq(tickets.openerId, openerId)))
      .orderBy(desc(tickets.openedAt))
      .limit(1);

    return rows[0]?.at ?? null;
  }

  async openRankAt(
    guildId: string,
    ownerId: string,
    number: number,
    typeId?: string,
  ): Promise<number> {
    const rows = await this.#handle.db
      .select({ value: count() })
      .from(tickets)
      .where(
        and(
          eq(tickets.guildId, guildId),
          eq(tickets.ownerId, ownerId),
          eq(tickets.status, 'open'),
          lte(tickets.number, number),
          ...(typeId === undefined ? [] : [eq(tickets.typeId, typeId)]),
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
        closeRequestedById: null,
        closeRequestedAt: null,
        waitingOn: null,
      })
      .where(
        and(
          eq(tickets.guildId, input.guildId),
          eq(tickets.id, input.ticketId),
          eq(tickets.status, 'open'),
        ),
      )
      .returning();

    return rows[0] ? toTicket(rows[0]) : null;
  }

  async reopen(guildId: string, ticketId: string, byId: string): Promise<Ticket | null> {
    const rows = await this.#handle.db
      .update(tickets)
      .set({
        status: 'open',
        closedAt: null,
        closedBy: null,
        closeReason: null,
        archivedAt: null,
        lastActivityAt: new Date(),
        waitingOn: 'staff',
      })
      .where(
        and(
          eq(tickets.guildId, guildId),
          eq(tickets.id, ticketId),
          or(eq(tickets.status, 'closed'), eq(tickets.status, 'archived')),
        ),
      )
      .returning();

    const row = rows[0];
    if (!row) return null;

    await this.recordEvent({
      ticketId,
      guildId,
      type: 'reopened',
      actorId: byId,
    });

    return toTicket(row);
  }

  async archive(guildId: string, ticketId: string): Promise<Ticket | null> {
    const rows = await this.#handle.db
      .update(tickets)
      .set({ status: 'archived', archivedAt: new Date() })
      .where(
        and(eq(tickets.guildId, guildId), eq(tickets.id, ticketId), eq(tickets.status, 'closed')),
      )
      .returning();

    return rows[0] ? toTicket(rows[0]) : null;
  }

  async markDeleted(
    guildId: string,
    ticketId: string,
    byId: string,
    reason: string | null,
    expected?: readonly TicketStatus[],
  ): Promise<Ticket | null> {
    const rows = await this.#handle.db
      .update(tickets)
      .set({
        status: 'deleted',
        deletedAt: new Date(),
        ...(reason === null ? {} : { closeReason: reason }),
      })
      .where(
        and(
          eq(tickets.guildId, guildId),
          eq(tickets.id, ticketId),
          expected === undefined
            ? ne(tickets.status, 'deleted')
            : inArray(tickets.status, [...expected]),
        ),
      )
      .returning();

    const row = rows[0];
    if (!row) return null;

    await this.recordEvent({ ticketId, guildId, type: 'deleted', actorId: byId });

    return toTicket(row);
  }

  async claim(guildId: string, ticketId: string, userId: string): Promise<Ticket | null> {
    // The null guard is the whole race: two staff pressing Claim at once both reach here, and only
    // the update whose WHERE still sees an unclaimed row returns anything.
    const rows = await this.#handle.db
      .update(tickets)
      .set({ claimedById: userId, claimedAt: new Date() })
      .where(
        and(
          eq(tickets.guildId, guildId),
          eq(tickets.id, ticketId),
          eq(tickets.status, 'open'),
          isNull(tickets.claimedById),
        ),
      )
      .returning();

    return rows[0] ? toTicket(rows[0]) : null;
  }

  async unclaim(guildId: string, ticketId: string): Promise<Ticket | null> {
    const rows = await this.#handle.db
      .update(tickets)
      .set({ claimedById: null, claimedAt: null })
      .where(
        and(
          eq(tickets.guildId, guildId),
          eq(tickets.id, ticketId),
          sql`${tickets.claimedById} is not null`,
        ),
      )
      .returning();

    return rows[0] ? toTicket(rows[0]) : null;
  }

  async assign(
    guildId: string,
    ticketId: string,
    assigneeId: string | null,
    byId: string,
  ): Promise<Ticket | null> {
    const rows = await this.#handle.db
      .update(tickets)
      .set({
        assignedToId: assigneeId,
        assignedById: assigneeId === null ? null : byId,
        assignedAt: assigneeId === null ? null : new Date(),
      })
      .where(
        and(eq(tickets.guildId, guildId), eq(tickets.id, ticketId), ne(tickets.status, 'deleted')),
      )
      .returning();

    return rows[0] ? toTicket(rows[0]) : null;
  }

  async transferOwner(guildId: string, ticketId: string, ownerId: string): Promise<Ticket | null> {
    const rows = await this.#handle.db
      .update(tickets)
      .set({ ownerId })
      .where(
        and(
          eq(tickets.guildId, guildId),
          eq(tickets.id, ticketId),
          ne(tickets.status, 'deleted'),
          ne(tickets.ownerId, ownerId),
        ),
      )
      .returning();

    return rows[0] ? toTicket(rows[0]) : null;
  }

  async setPriority(
    guildId: string,
    ticketId: string,
    priority: TicketPriority,
  ): Promise<Ticket | null> {
    const rows = await this.#handle.db
      .update(tickets)
      .set({ priority })
      .where(
        and(eq(tickets.guildId, guildId), eq(tickets.id, ticketId), ne(tickets.status, 'deleted')),
      )
      .returning();

    return rows[0] ? toTicket(rows[0]) : null;
  }

  async setSubject(
    guildId: string,
    ticketId: string,
    subject: string | null,
  ): Promise<Ticket | null> {
    const rows = await this.#handle.db
      .update(tickets)
      .set({ subject })
      .where(
        and(eq(tickets.guildId, guildId), eq(tickets.id, ticketId), ne(tickets.status, 'deleted')),
      )
      .returning();

    return rows[0] ? toTicket(rows[0]) : null;
  }

  async setLocked(
    guildId: string,
    ticketId: string,
    lockedById: string | null,
  ): Promise<Ticket | null> {
    const rows = await this.#handle.db
      .update(tickets)
      .set({ lockedById, lockedAt: lockedById === null ? null : new Date() })
      .where(
        and(
          eq(tickets.guildId, guildId),
          eq(tickets.id, ticketId),
          eq(tickets.status, 'open'),
          lockedById === null ? sql`${tickets.lockedAt} is not null` : isNull(tickets.lockedAt),
        ),
      )
      .returning();

    return rows[0] ? toTicket(rows[0]) : null;
  }

  async requestClose(guildId: string, ticketId: string, byId: string): Promise<Ticket | null> {
    const rows = await this.#handle.db
      .update(tickets)
      .set({ closeRequestedById: byId, closeRequestedAt: new Date() })
      .where(
        and(
          eq(tickets.guildId, guildId),
          eq(tickets.id, ticketId),
          eq(tickets.status, 'open'),
          isNull(tickets.closeRequestedAt),
        ),
      )
      .returning();

    return rows[0] ? toTicket(rows[0]) : null;
  }

  async clearCloseRequest(guildId: string, ticketId: string): Promise<Ticket | null> {
    const rows = await this.#handle.db
      .update(tickets)
      .set({ closeRequestedById: null, closeRequestedAt: null })
      .where(
        and(
          eq(tickets.guildId, guildId),
          eq(tickets.id, ticketId),
          sql`${tickets.closeRequestedAt} is not null`,
        ),
      )
      .returning();

    return rows[0] ? toTicket(rows[0]) : null;
  }

  async setTranscriptUrl(guildId: string, ticketId: string, url: string): Promise<void> {
    await this.#handle.db
      .update(tickets)
      .set({ transcriptUrl: url })
      .where(and(eq(tickets.guildId, guildId), eq(tickets.id, ticketId)));
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

  async recordActivity(
    guildId: string,
    channelId: string,
    input: { fromStaff: boolean; at: Date },
  ): Promise<Ticket | null> {
    const rows = await this.#handle.db
      .update(tickets)
      .set({
        lastActivityAt: input.at,
        waitingOn: input.fromStaff ? 'user' : 'staff',
        ...(input.fromStaff
          ? { lastStaffMessageAt: input.at }
          : { lastUserMessageAt: input.at, messageCount: sql`${tickets.messageCount} + 1` }),
        // coalesce, not a conditional write: the first staff reply is the one that counts and a
        // later one must not keep moving the first-response clock forward.
        ...(input.fromStaff
          ? { firstResponseAt: sql`coalesce(${tickets.firstResponseAt}, ${input.at})` }
          : {}),
      })
      .where(
        and(
          eq(tickets.guildId, guildId),
          eq(tickets.channelId, channelId),
          eq(tickets.status, 'open'),
        ),
      )
      .returning();

    return rows[0] ? toTicket(rows[0]) : null;
  }

  async due(guildId: string, limit: number): Promise<Ticket[]> {
    const rows = await this.#handle.db
      .select()
      .from(tickets)
      .where(
        and(
          eq(tickets.guildId, guildId),
          or(eq(tickets.status, 'open'), eq(tickets.status, 'closed')),
        ),
      )
      .orderBy(asc(tickets.lastActivityAt))
      .limit(limit);

    return rows.map(toTicket);
  }

  async addParticipant(
    ticketId: string,
    userId: string,
    kind: ParticipantKind,
    addedById: string | null,
  ): Promise<void> {
    await this.#handle.db
      .insert(ticketParticipants)
      .values({ ticketId, userId, kind, addedById })
      .onConflictDoNothing();
  }

  async removeParticipant(ticketId: string, userId: string): Promise<boolean> {
    const rows = await this.#handle.db
      .delete(ticketParticipants)
      .where(
        and(
          eq(ticketParticipants.ticketId, ticketId),
          eq(ticketParticipants.userId, userId),
          ne(ticketParticipants.kind, 'opener'),
        ),
      )
      .returning();

    return rows.length > 0;
  }

  async listParticipants(ticketId: string): Promise<TicketParticipant[]> {
    const rows = await this.#handle.db
      .select()
      .from(ticketParticipants)
      .where(eq(ticketParticipants.ticketId, ticketId))
      .orderBy(asc(ticketParticipants.addedAt));

    return rows.map((row) => ({
      ticketId: row.ticketId,
      userId: row.userId,
      kind: row.kind as ParticipantKind,
      addedById: row.addedById,
      addedAt: row.addedAt,
    }));
  }

  async recordEvent(input: RecordTicketEventInput): Promise<void> {
    await this.#handle.db.insert(ticketEvents).values({
      id: newId(),
      ticketId: input.ticketId,
      guildId: input.guildId,
      type: input.type,
      actorId: input.actorId,
      data: input.data ?? null,
    });
  }

  async listEvents(ticketId: string, limit: number): Promise<TicketEvent[]> {
    const rows = await this.#handle.db
      .select()
      .from(ticketEvents)
      .where(eq(ticketEvents.ticketId, ticketId))
      .orderBy(asc(ticketEvents.at))
      .limit(limit);

    return rows.map(toEvent);
  }

  async saveAnswers(ticketId: string, answers: readonly TicketFormAnswer[]): Promise<void> {
    if (answers.length === 0) return;

    await this.#handle.db
      .insert(ticketFormAnswers)
      .values(answers.map((answer) => ({ ticketId, ...answer })))
      .onConflictDoNothing();
  }

  async listAnswers(ticketId: string): Promise<TicketFormAnswer[]> {
    const rows = await this.#handle.db
      .select()
      .from(ticketFormAnswers)
      .where(eq(ticketFormAnswers.ticketId, ticketId))
      .orderBy(asc(ticketFormAnswers.position));

    return rows.map((row) => ({
      fieldId: row.fieldId,
      label: row.label,
      value: row.value,
      position: row.position,
    }));
  }

  async captureMessage(input: CaptureMessageInput): Promise<void> {
    await this.#handle.db
      .insert(ticketMessages)
      .values({
        id: newId(),
        ticketId: input.ticketId,
        messageId: input.messageId,
        authorId: input.authorId,
        authorName: input.authorName,
        authorBot: input.authorBot,
        content: input.content,
        attachments: input.attachments,
        embeds: input.embeds,
        replyToId: input.replyToId,
        createdAt: input.createdAt,
        expiresAt: input.expiresAt,
      })
      .onConflictDoNothing();
  }

  async markMessageEdited(
    ticketId: string,
    messageId: string,
    content: string,
    at: Date,
  ): Promise<void> {
    await this.#handle.db
      .update(ticketMessages)
      .set({ content, editedAt: at })
      .where(and(eq(ticketMessages.ticketId, ticketId), eq(ticketMessages.messageId, messageId)));
  }

  async markMessageDeleted(ticketId: string, messageId: string, at: Date): Promise<void> {
    await this.#handle.db
      .update(ticketMessages)
      .set({ deletedAt: at })
      .where(and(eq(ticketMessages.ticketId, ticketId), eq(ticketMessages.messageId, messageId)));
  }

  async listMessages(ticketId: string): Promise<TicketMessage[]> {
    const rows = await this.#handle.db
      .select()
      .from(ticketMessages)
      .where(eq(ticketMessages.ticketId, ticketId))
      .orderBy(asc(ticketMessages.createdAt));

    return rows.map(toMessage);
  }

  async purgeExpiredMessages(now: Date, limit: number): Promise<number> {
    const doomed = await this.#handle.db
      .select({ id: ticketMessages.id })
      .from(ticketMessages)
      .where(lte(ticketMessages.expiresAt, now))
      .limit(limit);

    if (doomed.length === 0) return 0;

    const rows = await this.#handle.db
      .delete(ticketMessages)
      .where(
        inArray(
          ticketMessages.id,
          doomed.map((row) => row.id),
        ),
      )
      .returning({ id: ticketMessages.id });

    return rows.length;
  }

  async blacklist(input: BlacklistInput): Promise<BlacklistEntry> {
    const rows = await this.#handle.db
      .insert(ticketBlacklist)
      .values({
        id: newId(),
        guildId: input.guildId,
        userId: input.userId,
        reason: input.reason,
        createdBy: input.createdBy,
        expiresAt: input.expiresAt,
      })
      .onConflictDoUpdate({
        target: [ticketBlacklist.guildId, ticketBlacklist.userId],
        set: {
          reason: input.reason,
          createdBy: input.createdBy,
          createdAt: new Date(),
          expiresAt: input.expiresAt,
        },
      })
      .returning();

    const row = rows[0];
    if (!row) throw new Error('the blacklist row was not written');

    return toBlacklist(row);
  }

  async unblacklist(guildId: string, userId: string): Promise<boolean> {
    const rows = await this.#handle.db
      .delete(ticketBlacklist)
      .where(and(eq(ticketBlacklist.guildId, guildId), eq(ticketBlacklist.userId, userId)))
      .returning();

    return rows.length > 0;
  }

  async blacklistEntry(guildId: string, userId: string, now: Date): Promise<BlacklistEntry | null> {
    const rows = await this.#handle.db
      .select()
      .from(ticketBlacklist)
      .where(
        and(
          eq(ticketBlacklist.guildId, guildId),
          eq(ticketBlacklist.userId, userId),
          or(isNull(ticketBlacklist.expiresAt), gte(ticketBlacklist.expiresAt, now)),
        ),
      )
      .limit(1);

    return rows[0] ? toBlacklist(rows[0]) : null;
  }

  async listBlacklist(guildId: string): Promise<BlacklistEntry[]> {
    const rows = await this.#handle.db
      .select()
      .from(ticketBlacklist)
      .where(eq(ticketBlacklist.guildId, guildId))
      .orderBy(desc(ticketBlacklist.createdAt));

    return rows.map(toBlacklist);
  }

  async saveRating(input: Omit<TicketRating, 'createdAt'>): Promise<boolean> {
    // Not upsert: a member rates once, and letting a second press overwrite the first would make
    // the average a measure of who pressed last.
    const rows = await this.#handle.db
      .insert(ticketRatings)
      .values({
        ticketId: input.ticketId,
        guildId: input.guildId,
        userId: input.userId,
        rating: input.rating,
        comment: input.comment,
      })
      .onConflictDoNothing()
      .returning();

    return rows.length > 0;
  }

  async getRating(ticketId: string): Promise<TicketRating | null> {
    const rows = await this.#handle.db
      .select()
      .from(ticketRatings)
      .where(eq(ticketRatings.ticketId, ticketId))
      .limit(1);

    const row = rows[0];
    if (!row) return null;

    return {
      ticketId: row.ticketId,
      guildId: row.guildId,
      userId: row.userId,
      rating: row.rating,
      comment: row.comment,
      createdAt: row.createdAt,
    };
  }

  async stats(guildId: string, since: Date): Promise<TicketStats> {
    const scope = and(eq(tickets.guildId, guildId), gte(tickets.openedAt, since));

    const [totals] = await this.#handle.db
      .select({
        opened: count(),
        closed: sql<number>`count(*) filter (where ${tickets.closedAt} is not null)`,
        open: sql<number>`count(*) filter (where ${tickets.status} = 'open')`,
        resolution: sql<
          number | null
        >`avg(extract(epoch from (${tickets.closedAt} - ${tickets.openedAt})) * 1000) filter (where ${tickets.closedAt} is not null)`,
        firstResponse: sql<
          number | null
        >`avg(extract(epoch from (${tickets.firstResponseAt} - ${tickets.openedAt})) * 1000) filter (where ${tickets.firstResponseAt} is not null)`,
      })
      .from(tickets)
      .where(scope);

    const priorities = await this.#handle.db
      .select({ key: tickets.priority, value: count() })
      .from(tickets)
      .where(scope)
      .groupBy(tickets.priority);

    const types = await this.#handle.db
      .select({ key: tickets.typeId, value: count() })
      .from(tickets)
      .where(scope)
      .groupBy(tickets.typeId);

    const staff = await this.#handle.db
      .select({
        userId: tickets.claimedById,
        claimed: count(),
        closed: sql<number>`count(*) filter (where ${tickets.closedAt} is not null)`,
      })
      .from(tickets)
      .where(and(scope, sql`${tickets.claimedById} is not null`))
      .groupBy(tickets.claimedById)
      .orderBy(desc(count()))
      .limit(25);

    const [reopened] = await this.#handle.db
      .select({ value: count() })
      .from(ticketEvents)
      .where(
        and(
          eq(ticketEvents.guildId, guildId),
          eq(ticketEvents.type, 'reopened'),
          gte(ticketEvents.at, since),
        ),
      );

    const [rating] = await this.#handle.db
      .select({ value: sql<number | null>`avg(${ticketRatings.rating})`, given: count() })
      .from(ticketRatings)
      .where(and(eq(ticketRatings.guildId, guildId), gte(ticketRatings.createdAt, since)));

    const numeric = (value: number | string | null | undefined): number | null =>
      value === null || value === undefined ? null : Number(value);

    return {
      opened: totals?.opened ?? 0,
      closed: Number(totals?.closed ?? 0),
      reopened: reopened?.value ?? 0,
      open: Number(totals?.open ?? 0),
      averageResolutionMs: numeric(totals?.resolution),
      averageFirstResponseMs: numeric(totals?.firstResponse),
      averageRating: numeric(rating?.value),
      ratings: rating?.given ?? 0,
      byPriority: Object.fromEntries(priorities.map((row) => [row.key, row.value])),
      byType: Object.fromEntries(types.map((row) => [row.key, row.value])),
      byStaff: staff.map((row) => ({
        userId: row.userId ?? 'unknown',
        claimed: row.claimed,
        closed: Number(row.closed),
      })),
    };
  }
}
