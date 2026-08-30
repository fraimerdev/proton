import type {
  BlockedMember,
  BlockedMemberList,
  BlockedMemberQuery,
  BlockedMemberStore,
  BlockMemberInput,
  LiftBlockInput,
  LiftBlockResult,
} from '@proton/core';
import { blockMemberInputSchema, liftBlockInputSchema, newId } from '@proton/core';
import { and, asc, count, desc, eq, isNotNull, isNull, type SQL } from 'drizzle-orm';
import type { DbHandle } from './client.ts';
import { type BlockedMemberRow, blockedMembers } from './schema/blocked-members.ts';

function toBlockedMember(row: BlockedMemberRow): BlockedMember {
  return {
    id: row.id,
    guildId: row.guildId,
    userId: row.userId,
    moduleId: row.moduleId,
    blockedBy: row.blockedBy,
    reason: row.reason,
    caseId: row.caseId,
    evidence: row.evidence ?? null,
    createdAt: row.createdAt.toISOString(),
    liftedAt: row.liftedAt?.toISOString() ?? null,
    liftedBy: row.liftedBy,
    liftReason: row.liftReason,
  };
}

export class DrizzleBlockedMemberStore implements BlockedMemberStore {
  readonly #handle: DbHandle;

  constructor(handle: DbHandle) {
    this.#handle = handle;
  }

  async block(input: BlockMemberInput): Promise<{ blocked: boolean }> {
    const values = blockMemberInputSchema.parse(input);

    // Untargeted, because either unique index may be the one that fires: the idempotency key on a
    // redelivery, the live index on a member somebody else already blocked.
    const inserted = await this.#handle.db
      .insert(blockedMembers)
      .values({
        id: newId(),
        guildId: values.guildId,
        userId: values.userId,
        moduleId: values.moduleId,
        blockedBy: values.blockedBy,
        reason: values.reason,
        caseId: values.caseId ?? null,
        evidence: values.evidence ?? null,
        idempotencyKey: values.idempotencyKey,
      })
      .onConflictDoNothing()
      .returning({ id: blockedMembers.id });

    return { blocked: inserted.length > 0 };
  }

  async find(guildId: string, userId: string): Promise<BlockedMember | null> {
    const rows = await this.#handle.db
      .select()
      .from(blockedMembers)
      .where(
        and(
          eq(blockedMembers.guildId, guildId),
          eq(blockedMembers.userId, userId),
          isNull(blockedMembers.liftedAt),
        ),
      )
      .limit(1);

    const row = rows[0];
    return row ? toBlockedMember(row) : null;
  }

  async list(guildId: string, query: BlockedMemberQuery): Promise<BlockedMemberList> {
    const filters: SQL[] = [eq(blockedMembers.guildId, guildId)];

    if (query.state === 'live') filters.push(isNull(blockedMembers.liftedAt));
    if (query.state === 'lifted') filters.push(isNotNull(blockedMembers.liftedAt));
    if (query.userId) filters.push(eq(blockedMembers.userId, query.userId));
    if (query.moduleId) filters.push(eq(blockedMembers.moduleId, query.moduleId));

    const where = and(...filters);
    const direction = query.order === 'asc' ? asc : desc;

    const [rows, totals] = await Promise.all([
      this.#handle.db
        .select()
        .from(blockedMembers)
        .where(where)
        // The id is a ULID, so it breaks a createdAt tie in the same direction rather than
        // leaving two rows of one millisecond free to swap between pages.
        .orderBy(direction(blockedMembers.createdAt), direction(blockedMembers.id))
        .limit(query.pageSize)
        .offset((query.page - 1) * query.pageSize),

      this.#handle.db.select({ total: count() }).from(blockedMembers).where(where),
    ]);

    return { rows: rows.map(toBlockedMember), total: totals[0]?.total ?? 0 };
  }

  async lift(input: LiftBlockInput): Promise<LiftBlockResult> {
    const values = liftBlockInputSchema.parse(input);

    const lifted = await this.#handle.db
      .update(blockedMembers)
      .set({ liftedAt: new Date(), liftedBy: values.liftedBy, liftReason: values.liftReason })
      .where(
        and(
          eq(blockedMembers.guildId, values.guildId),
          eq(blockedMembers.userId, values.userId),
          isNull(blockedMembers.liftedAt),
        ),
      )
      .returning({ id: blockedMembers.id });

    return { lifted: lifted.length > 0, userId: values.userId };
  }
}
