import type { DbHandle } from '@proton/db';
import { and, desc, eq, inArray, isNotNull, isNull, notInArray, or, sql } from 'drizzle-orm';
import { RECAP_MAX } from './config.ts';
import type {
  AfkPing,
  AfkStatus,
  AfkStore,
  RecordPingInput,
  StartAfkInput,
  StartAfkResult,
} from './store.ts';
import { type AfkPingRow, type AfkStatusRow, afkPings, afkStatuses } from './table.ts';

function toStatus(row: AfkStatusRow): AfkStatus {
  return {
    guildId: row.guildId,
    userId: row.userId,
    sessionId: row.sessionId,
    reason: row.reason,
    since: row.since,
    previousNick: row.previousNick,
    appliedNick: row.appliedNick,
    endedAt: row.endedAt,
    endedBy: row.endedBy,
  };
}

function toPing(row: AfkPingRow): AfkPing {
  return {
    sessionId: row.sessionId,
    guildId: row.guildId,
    userId: row.userId,
    messageId: row.messageId,
    channelId: row.channelId,
    authorId: row.authorId,
    pingedAt: row.pingedAt,
  };
}

export class DrizzleAfkStore implements AfkStore {
  readonly #handle: DbHandle;

  constructor(handle: DbHandle) {
    this.#handle = handle;
  }

  async start(input: StartAfkInput): Promise<StartAfkResult> {
    const inserted = await this.#handle.db
      .insert(afkStatuses)
      .values({
        guildId: input.guildId,
        userId: input.userId,
        sessionId: input.sessionId,
        reason: input.reason,
        since: input.since,
        previousNick: input.previousNick,
      })
      .onConflictDoNothing({ target: [afkStatuses.guildId, afkStatuses.userId] })
      .returning();

    const row = inserted[0];
    if (row) return { status: toStatus(row), created: true };

    const existing = await this.get(input.guildId, input.userId);
    if (!existing) {
      throw new Error(
        `an AFK status for ${input.userId} collided on insert and was gone by the time it was read ` +
          'back, so the session could not be started. Retrying the command will start it.',
      );
    }

    return { status: existing, created: false };
  }

  async get(guildId: string, userId: string): Promise<AfkStatus | null> {
    const rows = await this.#handle.db
      .select()
      .from(afkStatuses)
      .where(and(eq(afkStatuses.guildId, guildId), eq(afkStatuses.userId, userId)))
      .limit(1);

    const row = rows[0];
    return row ? toStatus(row) : null;
  }

  async active(guildId: string, userIds: readonly string[]): Promise<AfkStatus[]> {
    if (userIds.length === 0) return [];

    const rows = await this.#handle.db
      .select()
      .from(afkStatuses)
      .where(
        and(
          eq(afkStatuses.guildId, guildId),
          inArray(afkStatuses.userId, [...userIds]),
          isNull(afkStatuses.endedAt),
        ),
      );

    return rows.map(toStatus);
  }

  async all(guildId: string): Promise<AfkStatus[]> {
    const rows = await this.#handle.db
      .select()
      .from(afkStatuses)
      .where(eq(afkStatuses.guildId, guildId));

    return rows.map(toStatus);
  }

  async updateReason(
    guildId: string,
    userId: string,
    reason: string | null,
  ): Promise<AfkStatus | null> {
    const rows = await this.#handle.db
      .update(afkStatuses)
      .set({ reason })
      .where(
        and(
          eq(afkStatuses.guildId, guildId),
          eq(afkStatuses.userId, userId),
          isNull(afkStatuses.endedAt),
        ),
      )
      .returning();

    const row = rows[0];
    return row ? toStatus(row) : null;
  }

  async setAppliedNick(sessionId: string, appliedNick: string | null): Promise<void> {
    await this.#handle.db
      .update(afkStatuses)
      .set({ appliedNick })
      .where(eq(afkStatuses.sessionId, sessionId));
  }

  async recordTag(sessionId: string, nick: string): Promise<boolean> {
    const rows = await this.#handle.db
      .update(afkStatuses)
      .set({ appliedNick: nick })
      .where(and(eq(afkStatuses.sessionId, sessionId), isNull(afkStatuses.endedAt)))
      .returning({ sessionId: afkStatuses.sessionId });

    return rows.length > 0;
  }

  async recordPing(sessionId: string, input: RecordPingInput): Promise<boolean> {
    return this.#handle.db.transaction(async (tx) => {
      // FOR SHARE: without the lock a concurrent remove() leaves this ping orphaned forever.
      const held = await tx
        .select({ sessionId: afkStatuses.sessionId })
        .from(afkStatuses)
        .where(and(eq(afkStatuses.sessionId, sessionId), isNull(afkStatuses.endedAt)))
        .for('share');

      if (held.length === 0) return false;

      const inserted = await tx
        .insert(afkPings)
        .values({ sessionId, ...input })
        .onConflictDoNothing({ target: [afkPings.sessionId, afkPings.messageId] })
        .returning({ messageId: afkPings.messageId });

      const newest = tx
        .select({ messageId: afkPings.messageId })
        .from(afkPings)
        .where(eq(afkPings.sessionId, sessionId))
        .orderBy(desc(afkPings.pingedAt), desc(afkPings.messageId))
        .limit(RECAP_MAX);

      await tx
        .delete(afkPings)
        .where(and(eq(afkPings.sessionId, sessionId), notInArray(afkPings.messageId, newest)));

      return inserted.length > 0;
    });
  }

  async pings(sessionId: string): Promise<AfkPing[]> {
    const rows = await this.#handle.db
      .select()
      .from(afkPings)
      .where(eq(afkPings.sessionId, sessionId))
      .orderBy(desc(afkPings.pingedAt), desc(afkPings.messageId));

    return rows.map(toPing);
  }

  async markEnded(sessionId: string, endedBy: string): Promise<AfkStatus | null> {
    const rows = await this.#handle.db
      .update(afkStatuses)
      .set({ endedAt: sql`coalesce(${afkStatuses.endedAt}, now())`, endedBy })
      .where(
        and(
          eq(afkStatuses.sessionId, sessionId),
          or(isNull(afkStatuses.endedAt), eq(afkStatuses.endedBy, endedBy)),
        ),
      )
      .returning();

    const row = rows[0];
    return row ? toStatus(row) : null;
  }

  async finishSession(sessionId: string): Promise<void> {
    await this.#handle.db.transaction(async (tx) => {
      await tx
        .update(afkStatuses)
        .set({ reason: null, previousNick: null, appliedNick: null })
        .where(and(eq(afkStatuses.sessionId, sessionId), isNotNull(afkStatuses.endedAt)));
      await tx.delete(afkPings).where(eq(afkPings.sessionId, sessionId));
    });
  }

  async remove(sessionId: string): Promise<void> {
    await this.#handle.db.transaction(async (tx) => {
      await tx.delete(afkStatuses).where(eq(afkStatuses.sessionId, sessionId));
      await tx.delete(afkPings).where(eq(afkPings.sessionId, sessionId));
    });
  }

  async removeMember(guildId: string, userId: string): Promise<void> {
    await this.#handle.db.transaction(async (tx) => {
      await tx
        .delete(afkStatuses)
        .where(and(eq(afkStatuses.guildId, guildId), eq(afkStatuses.userId, userId)));
      await tx
        .delete(afkPings)
        .where(and(eq(afkPings.guildId, guildId), eq(afkPings.userId, userId)));
    });
  }
}
