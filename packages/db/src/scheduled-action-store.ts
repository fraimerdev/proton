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

/**
 * postgres.js hands back raw column names. A type alias rather than an interface
 * because its rows must satisfy the driver's `Record<string, unknown>` bound.
 *
 * `run_at_ms` rather than `run_at`: see the note on `claimDue` — Drizzle
 * disables postgres.js's timestamp parsing on the shared client, so a raw query
 * gets Postgres's text rendering back, not a `Date`.
 */
type ClaimedRow = {
  id: string;
  guild_id: string;
  run_at_ms: number;
  kind: string;
  attempts: number;
  idempotency_key: string;
  payload: unknown;
};

/** Postgres implementation of §6's `scheduled_actions`. */
export class DrizzleScheduledActionStore implements ScheduledActionStore {
  readonly #handle: DbHandle;

  constructor(handle: DbHandle) {
    this.#handle = handle;
  }

  async schedule(input: ScheduledActionInput): Promise<{ scheduled: boolean }> {
    // ON CONFLICT DO NOTHING against the unique idempotency key rather than a
    // read-then-insert: two workers handling the same redelivered ban would both
    // see "no row" and both insert, and the guild would get two unbans.
    const inserted = await this.#handle.db
      .insert(scheduledActions)
      .values({
        id: newId(),
        guildId: input.guildId,
        runAt: input.runAt,
        kind: input.kind,
        // Drizzle serialises jsonb itself; see client.ts on double-encoding.
        payload: input.payload,
        idempotencyKey: input.idempotencyKey,
      })
      .onConflictDoNothing({ target: scheduledActions.idempotencyKey })
      .returning({ id: scheduledActions.id });

    return { scheduled: inserted.length > 0 };
  }

  /**
   * Claim due rows in one statement.
   *
   * Lock and attempt-count move together with the selection, so there is no
   * window in which a row is "mine" but not yet marked — two sweepers running
   * against the same database cannot both take the same reversal. `SKIP LOCKED`
   * means the loser walks away with the *other* due rows instead of blocking on
   * the winner's transaction.
   *
   * `attempts < maxAttempts` is what stops a permanently failing reversal (a
   * user whose account no longer exists, say) from re-issuing a REST call every
   * sweep forever. The row stays behind as the record of what never happened.
   *
   * Timestamps cross this boundary as ISO strings and epoch milliseconds, never
   * as `Date`. `drizzle({ client })` reaches into the shared postgres.js client
   * and replaces the serialiser *and* parser for every timestamp OID with an
   * identity function, so that Drizzle's column mappers can own date handling.
   * The side effect is that a raw query on the same client hands a `Date`
   * parameter straight to the wire encoder (which throws) and returns Postgres's
   * text rendering instead of a `Date`. Explicit casts sidestep both halves.
   */
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
      // `isNull(revertedAt)` so an automatic reversal never overwrites a moderator
      // who already lifted the action by hand — their name and their timestamp
      // are the true ones.
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
