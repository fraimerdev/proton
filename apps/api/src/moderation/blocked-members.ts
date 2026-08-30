import type { BlockedMemberList, BlockedMemberQuery } from '@proton/core';
import { blockedMemberQuerySchema, newId } from '@proton/core';
import { auditTrail, blockedMembers, type DbHandle, DrizzleBlockedMemberStore } from '@proton/db';
import { and, eq, isNull } from 'drizzle-orm';

export class BlockedMemberError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = 'BlockedMemberError';
  }
}

export interface LiftInput {
  guildId: string;
  userId: string;

  actorId: string;
  source: string;
  liftReason: string;

  ipHash?: string | undefined;
}

export class BlockedMemberService {
  readonly #db: DbHandle;
  readonly #store: DrizzleBlockedMemberStore;

  constructor(db: DbHandle) {
    this.#db = db;
    this.#store = new DrizzleBlockedMemberStore(db);
  }

  async list(guildId: string, query: BlockedMemberQuery): Promise<BlockedMemberList> {
    return this.#store.list(guildId, blockedMemberQuerySchema.parse(query));
  }

  // The lift and the audit row go in one transaction: an unrecorded lift is exactly the case the
  // product's "every change is auditable" promise exists to prevent.
  async lift(input: LiftInput): Promise<{ lifted: true; userId: string }> {
    const lifted = await this.#db.db.transaction(async (tx) => {
      const rows = await tx
        .update(blockedMembers)
        .set({
          liftedAt: new Date(),
          liftedBy: input.actorId,
          liftReason: input.liftReason,
        })
        .where(
          and(
            eq(blockedMembers.guildId, input.guildId),
            eq(blockedMembers.userId, input.userId),
            isNull(blockedMembers.liftedAt),
          ),
        )
        .returning();

      const row = rows[0];
      if (!row) return null;

      await tx.insert(auditTrail).values({
        id: newId(),
        guildId: input.guildId,
        actorId: input.actorId,
        source: input.source,
        action: 'moderation.blocked.lift',
        before: { userId: row.userId, moduleId: row.moduleId, reason: row.reason },
        after: { userId: row.userId, liftedBy: input.actorId, liftReason: input.liftReason },
        ipHash: input.ipHash ?? null,
      });

      return row;
    });

    if (!lifted) {
      throw new BlockedMemberError(
        'not_blocked',
        `${input.userId} is not on this server's blocked list, so there was nothing to lift.`,
      );
    }

    return { lifted: true, userId: lifted.userId };
  }
}
