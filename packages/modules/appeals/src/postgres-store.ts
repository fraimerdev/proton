import { newId } from '@proton/core';
import type { DbHandle } from '@proton/db';
import { and, desc, eq, isNotNull, sql } from 'drizzle-orm';
import type { AppealRecord, AppealStore, DecideInput, FileAppealInput } from './store.ts';
import { type AppealRow, appealAnswers, appeals } from './table.ts';
import type { CheckedAnswer } from './web.ts';

function toRecord(row: AppealRow, answers: CheckedAnswer[]): AppealRecord {
  return {
    id: row.id,
    number: row.number,
    guildId: row.guildId,
    userId: row.userId,
    panelId: row.panelId,
    origin: row.origin,
    jti: row.jti,
    status: row.status as AppealRecord['status'],
    filedAt: row.createdAt.getTime(),
    decidedAt: row.decidedAt?.getTime() ?? null,
    decidedBy: row.decidedBy,
    decisionNote: row.decisionNote,
    outcomeApplied: row.outcomeApplied,
    cardChannelId: row.cardChannelId,
    cardMessageId: row.cardMessageId,
    dmChannelId: row.dmChannelId,
    dmAttempts: row.dmAttempts,
    answers,
  };
}

export class DrizzleAppealStore implements AppealStore {
  readonly #handle: DbHandle;

  constructor(handle: DbHandle) {
    this.#handle = handle;
  }

  async #answersOf(appealId: string): Promise<CheckedAnswer[]> {
    const rows = await this.#handle.db
      .select()
      .from(appealAnswers)
      .where(eq(appealAnswers.appealId, appealId))
      .orderBy(appealAnswers.position);

    return rows.map((row) => ({ key: row.questionKey, label: row.label, value: row.value }));
  }

  async file(input: FileAppealInput): Promise<{ appeal: AppealRecord; filed: boolean }> {
    const id = newId();

    const inserted = await this.#handle.db
      .insert(appeals)
      .values({
        id,
        guildId: input.guildId,
        userId: input.userId,
        panelId: input.panelId,
        origin: input.origin,
        jti: input.jti,

        number: sql`(select coalesce(max(${appeals.number}), 0) + 1 from ${appeals} where ${appeals.guildId} = ${input.guildId})`,
      })
      .onConflictDoNothing()
      .returning();

    const row = inserted[0];

    // ON CONFLICT DO NOTHING returns no row, so the select-back is not optional: without it a
    // second open of the same link looks like a failure rather than the appeal already filed.
    if (!row) {
      const existing = await this.findByLink(input.guildId, input.origin, input.jti);
      if (!existing) throw new Error('an appeal conflicted on insert but could not be read back');

      return { appeal: existing, filed: false };
    }

    if (input.answers.length > 0) {
      await this.#handle.db.insert(appealAnswers).values(
        input.answers.map((answer, position) => ({
          id: newId(),
          appealId: id,
          position,
          questionKey: answer.key,
          label: answer.label,
          value: answer.value,
        })),
      );
    }

    return { appeal: toRecord(row, input.answers), filed: true };
  }

  async find(guildId: string, appealId: string): Promise<AppealRecord | null> {
    const rows = await this.#handle.db
      .select()
      .from(appeals)
      .where(and(eq(appeals.guildId, guildId), eq(appeals.id, appealId)))
      .limit(1);

    const row = rows[0];
    return row ? toRecord(row, await this.#answersOf(row.id)) : null;
  }

  async findByLink(guildId: string, origin: string, jti: string): Promise<AppealRecord | null> {
    const rows = await this.#handle.db
      .select()
      .from(appeals)
      .where(and(eq(appeals.guildId, guildId), eq(appeals.origin, origin), eq(appeals.jti, jti)))
      .limit(1);

    const row = rows[0];
    return row ? toRecord(row, await this.#answersOf(row.id)) : null;
  }

  async lastDecidedAt(guildId: string, userId: string): Promise<number | null> {
    const rows = await this.#handle.db
      .select({ decidedAt: appeals.decidedAt })
      .from(appeals)
      .where(
        and(eq(appeals.guildId, guildId), eq(appeals.userId, userId), isNotNull(appeals.decidedAt)),
      )
      .orderBy(desc(appeals.decidedAt))
      .limit(1);

    return rows[0]?.decidedAt?.getTime() ?? null;
  }

  async decide(input: DecideInput): Promise<AppealRecord | null> {
    const decided = await this.#handle.db
      .update(appeals)
      .set({
        status: input.decision,
        decidedBy: input.decidedBy,
        decidedAt: new Date(),
        decisionNote: input.note ?? null,
      })
      .where(
        and(
          eq(appeals.guildId, input.guildId),
          eq(appeals.id, input.appealId),
          eq(appeals.status, 'open'),
        ),
      )
      .returning();

    const row = decided[0];
    return row ? toRecord(row, await this.#answersOf(row.id)) : null;
  }

  async markApplied(guildId: string, appealId: string): Promise<void> {
    await this.#handle.db
      .update(appeals)
      .set({ outcomeApplied: true })
      .where(and(eq(appeals.guildId, guildId), eq(appeals.id, appealId)));
  }

  async rememberCard(
    guildId: string,
    appealId: string,
    channelId: string,
    messageId: string,
  ): Promise<void> {
    await this.#handle.db
      .update(appeals)
      .set({ cardChannelId: channelId, cardMessageId: messageId })
      .where(and(eq(appeals.guildId, guildId), eq(appeals.id, appealId)));
  }

  async rememberDm(guildId: string, appealId: string, channelId: string): Promise<void> {
    await this.#handle.db
      .update(appeals)
      .set({ dmChannelId: channelId })
      .where(and(eq(appeals.guildId, guildId), eq(appeals.id, appealId)));
  }

  async noteDmAttempt(guildId: string, appealId: string): Promise<number> {
    const bumped = await this.#handle.db
      .update(appeals)
      .set({ dmAttempts: sql`${appeals.dmAttempts} + 1` })
      .where(and(eq(appeals.guildId, guildId), eq(appeals.id, appealId)))
      .returning({ dmAttempts: appeals.dmAttempts });

    return bumped[0]?.dmAttempts ?? 1;
  }
}
