import { cases, type DbHandle } from '@proton/db';
import { and, eq, isNull } from 'drizzle-orm';

export interface StandingWarning {
  caseId: string;
  caseNumber: number;
  targetId: string | null;
  reason: string | null;
  createdAt: Date;
  revertedAt: Date | null;
  revertedBy: string | null;
}

export interface WithdrawInput {
  guildId: string;
  caseId: string;
  at: Date;
  by: string;
}

export interface WarningStore {
  find(guildId: string, caseId: string): Promise<StandingWarning | null>;

  /** False when somebody else withdrew it first — the caller must not claim it did the withdrawing. */
  withdraw(input: WithdrawInput): Promise<boolean>;
}

export class DrizzleWarningStore implements WarningStore {
  readonly #handle: DbHandle;

  constructor(handle: DbHandle) {
    this.#handle = handle;
  }

  async find(guildId: string, caseId: string): Promise<StandingWarning | null> {
    const [row] = await this.#handle.db
      .select({
        caseId: cases.id,
        caseNumber: cases.caseNumber,
        targetId: cases.targetId,
        reason: cases.reason,
        createdAt: cases.createdAt,
        revertedAt: cases.revertedAt,
        revertedBy: cases.revertedBy,
      })
      .from(cases)
      .where(and(eq(cases.guildId, guildId), eq(cases.id, caseId), eq(cases.type, 'warn')))
      .limit(1);

    return row ?? null;
  }

  async withdraw(input: WithdrawInput): Promise<boolean> {
    const updated = await this.#handle.db
      .update(cases)
      .set({ revertedAt: input.at, revertedBy: input.by })
      .where(
        and(
          eq(cases.guildId, input.guildId),
          eq(cases.id, input.caseId),
          eq(cases.type, 'warn'),
          isNull(cases.revertedAt),
        ),
      )
      .returning({ id: cases.id });

    return updated.length > 0;
  }
}
