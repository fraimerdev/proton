import type {
  ClaimDueOptions,
  CompleteReversalInput,
  ScheduledActionInput,
  ScheduledActionRecord,
  ScheduledActionStore,
} from '@proton/core';
import { newId } from '@proton/core';
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
};

export class DrizzleScheduledActionStore implements ScheduledActionStore {
  readonly #handle: DbHandle;

  constructor(handle: DbHandle) {
    this.#handle = handle;
  }

  async schedule(input: ScheduledActionInput): Promise<{ scheduled: boolean }> {
    const inserted = await this.#handle.db
      .insert(scheduledActions)
      .values({
        id: newId(),
        guildId: input.guildId,
        runAt: input.runAt,
        kind: input.kind,

        payload: input.payload,
        idempotencyKey: input.idempotencyKey,
      })
      .onConflictDoNothing({ target: scheduledActions.idempotencyKey })
      .returning({ id: scheduledActions.id });

    return { scheduled: inserted.length > 0 };
  }

  async claimDue(options: ClaimDueOptions): Promise<ScheduledActionRecord[]> {
    const now = options.now.toISOString();

    const rows = await this.#handle.client<ClaimedRow[]>`
      update scheduled_actions
         set locked_until = ${options.lockUntil.toISOString()}::timestamptz,
             attempts = attempts + 1
       where id in (
         select id
           from scheduled_actions
          where run_at <= ${now}::timestamptz
            and (locked_until is null or locked_until < ${now}::timestamptz)
            and attempts < ${options.maxAttempts}
          order by run_at
          limit ${options.limit}
            for update skip locked
       )
      returning id, guild_id, kind, attempts, idempotency_key, payload,
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
    }));
  }

  async complete(input: CompleteReversalInput): Promise<void> {
    await this.#handle.db.transaction(async (tx) => {
      await tx
        .update(cases)
        .set({ revertedAt: input.revertedAt, revertedBy: input.revertedBy })
        .where(and(eq(cases.id, input.caseId), isNull(cases.revertedAt)));

      await tx.delete(scheduledActions).where(eq(scheduledActions.id, input.scheduledActionId));
    });
  }

  async release(scheduledActionId: string): Promise<void> {
    await this.#handle.db
      .update(scheduledActions)
      .set({ lockedUntil: null })
      .where(eq(scheduledActions.id, scheduledActionId));
  }
}
