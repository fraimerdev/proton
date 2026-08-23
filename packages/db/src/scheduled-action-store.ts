import type {
  CaseReversalInput,
  CaseReversalStore,
  ClaimDueOptions,
  CompleteOutcome,
  ScheduledActionInput,
  ScheduledActionRecord,
  ScheduledActionStore,
  ScheduleOutcome,
} from '@proton/core';
import { newId, redactSecrets } from '@proton/core';
import { and, eq, isNull } from 'drizzle-orm';
import type { DbHandle } from './client.ts';
import { cases } from './schema/cases.ts';
import { scheduledActions } from './schema/scheduled-actions.ts';

type ClaimedRow = {
  id: string;
  guild_id: string;
  run_at_ms: number;
  kind: string;
  attempts: number;
  idempotency_key: string;
  payload: unknown;
  lock_token: string;
};

export class DrizzleScheduledActionStore implements ScheduledActionStore, CaseReversalStore {
  readonly #handle: DbHandle;

  constructor(handle: DbHandle) {
    this.#handle = handle;
  }

  async schedule(input: ScheduledActionInput): Promise<ScheduleOutcome> {
    const values = this.#row(input);

    if (input.onConflict === 'replace') {
      const upserted = await this.#handle.db
        .insert(scheduledActions)
        .values(values)
        .onConflictDoUpdate({
          target: scheduledActions.idempotencyKey,
          set: {
            runAt: values.runAt,
            kind: values.kind,
            payload: values.payload,
            attempts: 0,
            // the fence dies with the token: replacing a row takes it off whatever sweep is
            // running it, which is what a caller asking to replace is asking for
            lockedUntil: null,
            lockToken: null,
          },
        })
        .returning({ id: scheduledActions.id });

      return { scheduled: true, replaced: upserted[0]?.id !== values.id };
    }

    const inserted = await this.#handle.db
      .insert(scheduledActions)
      .values(values)
      .onConflictDoNothing({ target: scheduledActions.idempotencyKey })
      .returning({ id: scheduledActions.id });

    return { scheduled: inserted.length > 0, replaced: false };
  }

  async claimDue(options: ClaimDueOptions): Promise<ScheduledActionRecord[]> {
    const now = options.now.toISOString();
    const tokens = Array.from({ length: options.limit }, () => newId());

    const rows = await this.#handle.client<ClaimedRow[]>`
      update scheduled_actions
         set locked_until = ${options.lockUntil.toISOString()}::timestamptz,
             attempts = attempts + 1,
             lock_token = claim.token
        from (
          select due.id, tokens.token
            from (
              select id, row_number() over () as n
                from (
                  select id
                    from scheduled_actions
                   where run_at <= ${now}::timestamptz
                     and (locked_until is null or locked_until < ${now}::timestamptz)
                     and attempts < ${options.maxAttempts}
                   order by run_at
                   limit ${options.limit}
                     for update skip locked
                ) as due_rows
            ) as due
            join unnest(${tokens}::text[]) with ordinality as tokens(token, n)
              on tokens.n = due.n
        ) as claim
       where scheduled_actions.id = claim.id
      returning scheduled_actions.id, guild_id, kind, attempts, idempotency_key, payload, lock_token,
                (extract(epoch from run_at) * 1000)::float8 as run_at_ms
    `;

    return rows.map((row) => ({
      id: row.id,
      guildId: row.guild_id,
      runAt: new Date(row.run_at_ms),
      kind: row.kind,
      attempts: row.attempts,
      idempotencyKey: row.idempotency_key,
      payload: row.payload,
      lockToken: row.lock_token,
    }));
  }

  async renew(scheduledActionId: string, lockToken: string, lockUntil: Date): Promise<boolean> {
    const renewed = await this.#handle.db
      .update(scheduledActions)
      .set({ lockedUntil: lockUntil })
      .where(this.#held(scheduledActionId, lockToken))
      .returning({ id: scheduledActions.id });

    return renewed.length > 0;
  }

  async complete(scheduledActionId: string, lockToken: string): Promise<CompleteOutcome> {
    const retired = await this.#handle.db
      .delete(scheduledActions)
      .where(this.#held(scheduledActionId, lockToken))
      .returning({ id: scheduledActions.id });

    return retired.length > 0 ? 'retired' : 'lost';
  }

  async completeAndSchedule(
    scheduledActionId: string,
    lockToken: string,
    next: Omit<ScheduledActionInput, 'onConflict'>,
  ): Promise<CompleteOutcome> {
    return this.#handle.db.transaction(async (tx) => {
      const retired = await tx
        .delete(scheduledActions)
        .where(this.#held(scheduledActionId, lockToken))
        .returning({ id: scheduledActions.id });

      if (retired.length === 0) return 'lost';

      await tx.insert(scheduledActions).values(this.#row(next));
      return 'retired';
    });
  }

  async cancel(idempotencyKey: string): Promise<{ cancelled: boolean }> {
    const deleted = await this.#handle.db
      .delete(scheduledActions)
      .where(eq(scheduledActions.idempotencyKey, idempotencyKey))
      .returning({ id: scheduledActions.id });

    return { cancelled: deleted.length > 0 };
  }

  async markReverted(input: CaseReversalInput): Promise<void> {
    await this.#handle.db
      .update(cases)
      .set({ revertedAt: input.revertedAt, revertedBy: input.revertedBy })
      // a moderator who lifted it by hand first owns the reversal, not the sweeper
      .where(and(eq(cases.id, input.caseId), isNull(cases.revertedAt)));
  }

  async release(scheduledActionId: string, lockToken: string): Promise<void> {
    await this.#handle.db
      .update(scheduledActions)
      .set({ lockedUntil: null, lockToken: null })
      .where(this.#held(scheduledActionId, lockToken));
  }

  #held(scheduledActionId: string, lockToken: string) {
    return and(
      eq(scheduledActions.id, scheduledActionId),
      eq(scheduledActions.lockToken, lockToken),
    );
  }

  #row(input: Omit<ScheduledActionInput, 'onConflict'>) {
    return {
      id: newId(),
      guildId: input.guildId,
      runAt: input.runAt,
      kind: input.kind,

      payload: redactSecrets(input.payload),
      idempotencyKey: input.idempotencyKey,
    };
  }
}
