import { cases, type DbHandle } from '@proton/db';
import { and, asc, count, desc, eq, gte, inArray, isNull, lte, ne, notInArray } from 'drizzle-orm';
import {
  type ModerationCaseMessageRow,
  type ModerationTimeoutRow,
  moderationCaseMessages,
  moderationTimeouts,
} from '../tables.ts';
import {
  type CaseLedger,
  type CaseMatch,
  type CaseMessage,
  type CaseMessageStore,
  type CaseStamp,
  caseAttachmentsSchema,
  type LedgerCase,
  type NewCaseMessage,
  type NewTimeout,
  TIMEOUT_CLOSE_REASONS,
  type TimeoutClose,
  type TimeoutCloseReason,
  type TimeoutRow,
  type TimeoutStore,
} from './store.ts';

function ms(value: Date | null): number | null {
  return value === null ? null : value.getTime();
}

function closeReasonOf(value: string | null): TimeoutCloseReason | null {
  return TIMEOUT_CLOSE_REASONS.find((reason) => reason === value) ?? null;
}

function timeoutOf(row: ModerationTimeoutRow): TimeoutRow {
  return {
    caseId: row.caseId,
    guildId: row.guildId,
    userId: row.userId,
    startedAt: row.startedAt.getTime(),
    endsAt: row.endsAt.getTime(),
    appliedUntil: ms(row.appliedUntil),
    closedAt: ms(row.closedAt),
    closedBy: row.closedBy,
    closeReason: closeReasonOf(row.closeReason),
    expiryLoggedAt: ms(row.expiryLoggedAt),
  };
}

export class DrizzleTimeoutStore implements TimeoutStore {
  readonly #handle: DbHandle;

  constructor(handle: DbHandle) {
    this.#handle = handle;
  }

  async record(row: NewTimeout): Promise<boolean> {
    const inserted = await this.#handle.db
      .insert(moderationTimeouts)
      .values({
        caseId: row.caseId,
        guildId: row.guildId,
        userId: row.userId,
        startedAt: row.startedAt,
        endsAt: row.endsAt,
        appliedUntil: row.appliedUntil,
      })
      .onConflictDoNothing({ target: moderationTimeouts.caseId })
      .returning({ caseId: moderationTimeouts.caseId });

    return inserted.length > 0;
  }

  async open(guildId: string, userId: string): Promise<TimeoutRow[]> {
    const rows = await this.#handle.db
      .select()
      .from(moderationTimeouts)
      .where(
        and(
          eq(moderationTimeouts.guildId, guildId),
          eq(moderationTimeouts.userId, userId),
          isNull(moderationTimeouts.closedAt),
        ),
      )
      .orderBy(asc(moderationTimeouts.endsAt));

    return rows.map(timeoutOf);
  }

  async openUsers(guildId: string): Promise<string[]> {
    const rows = await this.#handle.db
      .selectDistinct({ userId: moderationTimeouts.userId })
      .from(moderationTimeouts)
      .where(and(eq(moderationTimeouts.guildId, guildId), isNull(moderationTimeouts.closedAt)));

    return rows.map((row) => row.userId);
  }

  async close(
    guildId: string,
    caseIds: readonly string[],
    close: TimeoutClose,
  ): Promise<TimeoutRow[]> {
    if (caseIds.length === 0) return [];

    const rows = await this.#handle.db
      .update(moderationTimeouts)
      .set({ closedAt: close.at, closedBy: close.by, closeReason: close.reason })
      .where(
        and(
          eq(moderationTimeouts.guildId, guildId),
          inArray(moderationTimeouts.caseId, [...caseIds]),
          isNull(moderationTimeouts.closedAt),
        ),
      )
      .returning();

    return rows.map(timeoutOf);
  }

  async closeOpen(
    guildId: string,
    userId: string,
    close: TimeoutClose,
    options: { except?: string } = {},
  ): Promise<TimeoutRow[]> {
    const rows = await this.#handle.db
      .update(moderationTimeouts)
      .set({ closedAt: close.at, closedBy: close.by, closeReason: close.reason })
      .where(
        and(
          eq(moderationTimeouts.guildId, guildId),
          eq(moderationTimeouts.userId, userId),
          isNull(moderationTimeouts.closedAt),
          options.except === undefined ? undefined : ne(moderationTimeouts.caseId, options.except),
        ),
      )
      .returning();

    return rows.map(timeoutOf);
  }

  async setAppliedUntil(guildId: string, userId: string, until: Date): Promise<void> {
    await this.#handle.db
      .update(moderationTimeouts)
      .set({ appliedUntil: until })
      .where(
        and(
          eq(moderationTimeouts.guildId, guildId),
          eq(moderationTimeouts.userId, userId),
          isNull(moderationTimeouts.closedAt),
        ),
      );
  }

  async markExpiryLogged(guildId: string, caseId: string, at: Date): Promise<boolean> {
    const updated = await this.#handle.db
      .update(moderationTimeouts)
      .set({ expiryLoggedAt: at })
      .where(
        and(
          eq(moderationTimeouts.guildId, guildId),
          eq(moderationTimeouts.caseId, caseId),
          isNull(moderationTimeouts.expiryLoggedAt),
        ),
      )
      .returning({ caseId: moderationTimeouts.caseId });

    return updated.length > 0;
  }

  async trackedCaseIds(guildId: string, userId: string): Promise<string[]> {
    const rows = await this.#handle.db
      .select({ caseId: moderationTimeouts.caseId })
      .from(moderationTimeouts)
      .where(and(eq(moderationTimeouts.guildId, guildId), eq(moderationTimeouts.userId, userId)));

    return rows.map((row) => row.caseId);
  }
}

type CaseRow = typeof cases.$inferSelect;

function ledgerCaseOf(row: CaseRow): LedgerCase {
  return {
    caseId: row.id,
    kind: row.type,
    targetId: row.targetId,
    actorId: row.actorId,
    reason: row.reason,
    idempotencyKey: row.idempotencyKey,
    createdAt: row.createdAt.getTime(),
    expiresAt: ms(row.expiresAt),
    revertedAt: ms(row.revertedAt),
    revertedBy: row.revertedBy,
  };
}

export class DrizzleCaseLedger implements CaseLedger {
  readonly #handle: DbHandle;

  constructor(handle: DbHandle) {
    this.#handle = handle;
  }

  async recent(
    guildId: string,
    targetId: string,
    kind: string,
    since: Date,
  ): Promise<LedgerCase | null> {
    const [row] = await this.#handle.db
      .select()
      .from(cases)
      .where(
        and(
          eq(cases.guildId, guildId),
          eq(cases.targetId, targetId),
          eq(cases.type, kind),
          eq(cases.dryRun, false),
          isNull(cases.revertedAt),
          gte(cases.createdAt, since),
        ),
      )
      .orderBy(desc(cases.createdAt))
      .limit(1);

    return row ? ledgerCaseOf(row) : null;
  }

  async closeOpen(guildId: string, match: CaseMatch, stamp: CaseStamp): Promise<LedgerCase[]> {
    if (match.caseIds !== undefined && match.caseIds.length === 0) return [];

    const rows = await this.#handle.db
      .update(cases)
      .set({ revertedAt: stamp.at, revertedBy: stamp.by })
      .where(
        and(
          eq(cases.guildId, guildId),
          eq(cases.targetId, match.targetId),
          eq(cases.type, match.kind),
          eq(cases.dryRun, false),
          isNull(cases.revertedAt),
          match.caseIds === undefined ? undefined : inArray(cases.id, [...match.caseIds]),
          match.exceptCaseIds === undefined || match.exceptCaseIds.length === 0
            ? undefined
            : notInArray(cases.id, [...match.exceptCaseIds]),
          match.createdAfter === undefined ? undefined : gte(cases.createdAt, match.createdAfter),
        ),
      )
      .returning();

    return rows.map(ledgerCaseOf);
  }

  async byIdempotencyKey(
    guildId: string,
    key: string,
  ): Promise<{ caseId: string; kind: string; revertedAt: number | null } | null> {
    const [row] = await this.#handle.db
      .select({ caseId: cases.id, kind: cases.type, revertedAt: cases.revertedAt })
      .from(cases)
      .where(and(eq(cases.guildId, guildId), eq(cases.idempotencyKey, key)))
      .limit(1);

    return row ? { caseId: row.caseId, kind: row.kind, revertedAt: ms(row.revertedAt) } : null;
  }

  async find(guildId: string, caseId: string): Promise<LedgerCase | null> {
    const [row] = await this.#handle.db
      .select()
      .from(cases)
      .where(and(eq(cases.guildId, guildId), eq(cases.id, caseId)))
      .limit(1);

    return row ? ledgerCaseOf(row) : null;
  }

  async countsForTarget(guildId: string, targetId: string): Promise<Record<string, number>> {
    const rows = await this.#handle.db
      .select({ kind: cases.type, total: count() })
      .from(cases)
      .where(and(eq(cases.guildId, guildId), eq(cases.targetId, targetId), eq(cases.dryRun, false)))
      .groupBy(cases.type);

    return Object.fromEntries(rows.map((row) => [row.kind, row.total]));
  }

  async lastCase(guildId: string, targetId: string): Promise<LedgerCase | null> {
    const [row] = await this.#handle.db
      .select()
      .from(cases)
      .where(and(eq(cases.guildId, guildId), eq(cases.targetId, targetId), eq(cases.dryRun, false)))
      .orderBy(desc(cases.createdAt))
      .limit(1);

    return row ? ledgerCaseOf(row) : null;
  }
}

function caseMessageOf(row: ModerationCaseMessageRow): CaseMessage {
  const attachments = caseAttachmentsSchema.safeParse(row.attachments);

  return {
    caseId: row.caseId,
    guildId: row.guildId,
    messageId: row.messageId,
    channelId: row.channelId,
    authorId: row.authorId,
    content: row.content,
    attachments: attachments.success ? attachments.data : [],
    createdAt: row.createdAt.getTime(),
    deletedAt: ms(row.deletedAt),
    proof: row.proof,
    capturedAt: row.capturedAt.getTime(),
    expiresAt: row.expiresAt.getTime(),
  };
}

export class DrizzleCaseMessageStore implements CaseMessageStore {
  readonly #handle: DbHandle;

  constructor(handle: DbHandle) {
    this.#handle = handle;
  }

  async save(rows: readonly NewCaseMessage[]): Promise<number> {
    if (rows.length === 0) return 0;

    const inserted = await this.#handle.db
      .insert(moderationCaseMessages)
      .values(
        rows.map((row) => ({
          caseId: row.caseId,
          messageId: row.messageId,
          guildId: row.guildId,
          channelId: row.channelId,
          authorId: row.authorId,
          content: row.content,
          attachments: row.attachments,
          createdAt: new Date(row.createdAt),
          deletedAt: row.deletedAt === null ? null : new Date(row.deletedAt),
          proof: row.proof,
          expiresAt: new Date(row.expiresAt),
        })),
      )
      .onConflictDoNothing({
        target: [moderationCaseMessages.caseId, moderationCaseMessages.messageId],
      })
      .returning({ messageId: moderationCaseMessages.messageId });

    return inserted.length;
  }

  async forCase(guildId: string, caseId: string): Promise<CaseMessage[]> {
    const rows = await this.#handle.db
      .select()
      .from(moderationCaseMessages)
      .where(
        and(eq(moderationCaseMessages.guildId, guildId), eq(moderationCaseMessages.caseId, caseId)),
      )
      .orderBy(asc(moderationCaseMessages.createdAt), asc(moderationCaseMessages.messageId));

    return rows.map(caseMessageOf);
  }

  async purgeExpired(now: Date): Promise<number> {
    const deleted = await this.#handle.db
      .delete(moderationCaseMessages)
      .where(lte(moderationCaseMessages.expiresAt, now))
      .returning({ messageId: moderationCaseMessages.messageId });

    return deleted.length;
  }
}
