import type { Logger } from '../modules/manifest.ts';
import { isActionKind } from './kinds.ts';
import { AUTO_REVERSAL_ACTOR } from './reversal.ts';
import {
  type ScheduledActionRecord,
  type ScheduledActionStore,
  scheduledReversalPayloadSchema,
} from './scheduled-actions.ts';
import type { ActionExecutor, ActionRequest } from './types.ts';

export interface ReversalSweeperDeps {
  store: ScheduledActionStore;
  /** Reversals are state changes, so they go through the executor like any other (I1). */
  executor: ActionExecutor;
  logger: Logger;
  /**
   * Injected clock.
   *
   * The whole point of due-detection living in a SQL predicate rather than in a
   * delayed job: a test can advance this and prove the reversal fires, in
   * milliseconds and deterministically, instead of sleeping through a real
   * expiry (Gate 1).
   */
  now(): Date;
  /** How long a claim is held. Must exceed the slowest plausible reversal. */
  lockMs?: number;
  /** Rows claimed per sweep. Bounds the REST burst after a long outage. */
  batchSize?: number;
  /** Attempts before a row is left alone and reported as stuck. */
  maxAttempts?: number;
}

export interface SweepResult {
  claimed: number;
  reverted: number;
  /** Failed, lock released, will be retried by a later sweep. */
  retrying: number;
  /** Failed on its final attempt. The row stays as evidence; nothing retries it. */
  abandoned: number;
}

const DEFAULT_LOCK_MS = 60_000;
const DEFAULT_BATCH_SIZE = 50;
const DEFAULT_MAX_ATTEMPTS = 5;

/**
 * Reverses temporary actions whose expiry has passed (PLAN.md §4-P3, Gate 1).
 *
 * Due-detection is a query against `scheduled_actions`, not a BullMQ delayed
 * job. A delayed job lives in Redis: flush it, lose it, and a temp ban becomes
 * permanent with nothing to show that it happened. BullMQ's only role is to call
 * `sweep()` on an interval.
 *
 * The claim is a single atomic UPDATE, so running several workers is safe by
 * construction rather than by convention — the second sweeper simply sees no
 * rows.
 */
export class ReversalSweeper {
  readonly #deps: ReversalSweeperDeps;
  readonly #lockMs: number;
  readonly #batchSize: number;
  readonly #maxAttempts: number;

  constructor(deps: ReversalSweeperDeps) {
    this.#deps = deps;
    this.#lockMs = deps.lockMs ?? DEFAULT_LOCK_MS;
    this.#batchSize = deps.batchSize ?? DEFAULT_BATCH_SIZE;
    this.#maxAttempts = deps.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  }

  async sweep(): Promise<SweepResult> {
    const now = this.#deps.now();

    const claimed = await this.#deps.store.claimDue({
      now,
      lockUntil: new Date(now.getTime() + this.#lockMs),
      limit: this.#batchSize,
      maxAttempts: this.#maxAttempts,
    });

    const result: SweepResult = {
      claimed: claimed.length,
      reverted: 0,
      retrying: 0,
      abandoned: 0,
    };

    // Sequential on purpose: reversals share one REST proxy bucket, and a burst
    // of parallel unbans after an outage would just queue behind each other with
    // their locks ticking down.
    for (const row of claimed) {
      const outcome = await this.#revert(row, now);
      result[outcome] += 1;
    }

    return result;
  }

  async #revert(
    row: ScheduledActionRecord,
    now: Date,
  ): Promise<'reverted' | 'retrying' | 'abandoned'> {
    const parsed = scheduledReversalPayloadSchema.safeParse(row.payload);
    if (!parsed.success) {
      return this.#failed(
        row,
        `its stored payload no longer matches the expected shape (${parsed.error.issues
          .map((i) => `${i.path.map(String).join('.')} ${i.message}`)
          .join('; ')})`,
      );
    }

    if (!isActionKind(row.kind)) {
      return this.#failed(row, `'${row.kind}' is not an action Proton knows how to perform`);
    }

    const payload = parsed.data;
    const request: ActionRequest = {
      guildId: row.guildId,
      moduleId: payload.moduleId,
      kind: row.kind,
      actorId: payload.actorId,
      // The derived key (I4): if the sweeper crashes after Discord accepted the
      // unban but before the row is retired, the retry is skipped as a duplicate
      // instead of unbanning someone a moderator re-banned in the meantime.
      idempotencyKey: row.idempotencyKey,
      dryRun: false,
      payload: payload.action,
      ...(payload.targetId ? { targetId: payload.targetId } : {}),
      ...(payload.reason ? { reason: payload.reason } : {}),
    };

    let status: string;
    try {
      const result = await this.#deps.executor.execute(request);
      status = result.status;

      if (result.status === 'failed_precheck' || result.status === 'failed_api') {
        return this.#failed(
          row,
          result.failure?.humanReason ?? `the executor returned ${result.status}`,
        );
      }
    } catch (error) {
      return this.#failed(
        row,
        `the executor threw: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    // 'executed', 'dry_run' and 'skipped_duplicate' all mean the reversal is
    // done — the last of those is a previous attempt that got further than its
    // bookkeeping suggests.
    await this.#deps.store.complete({
      scheduledActionId: row.id,
      caseId: payload.caseId,
      revertedAt: now,
      revertedBy: AUTO_REVERSAL_ACTOR,
    });

    this.#deps.logger.info(`reverted a temporary ${payload.originalKind}`, {
      guildId: row.guildId,
      caseId: payload.caseId,
      kind: row.kind,
      status,
      attempts: row.attempts,
    });

    return 'reverted';
  }

  /**
   * Report a failed reversal and decide whether anything will retry it.
   *
   * Both branches log the guild, the case and the reason — a temporary action
   * that quietly failed to lift is exactly the "the bot did nothing" class of
   * bug PLAN.md §1 refuses to ship.
   */
  async #failed(row: ScheduledActionRecord, reason: string): Promise<'retrying' | 'abandoned'> {
    const meta = {
      guildId: row.guildId,
      scheduledActionId: row.id,
      kind: row.kind,
      attempts: row.attempts,
      reason,
    };

    if (row.attempts >= this.#maxAttempts) {
      this.#deps.logger.error(
        `giving up on a scheduled ${row.kind} after ${row.attempts} attempts — ` +
          `it must be performed by hand: ${reason}`,
        meta,
      );
      return 'abandoned';
    }

    this.#deps.logger.warn(`scheduled ${row.kind} failed, will retry: ${reason}`, meta);
    await this.#deps.store.release(row.id);
    return 'retrying';
  }
}
