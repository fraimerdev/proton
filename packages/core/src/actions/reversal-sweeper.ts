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

  executor: ActionExecutor;
  logger: Logger;

  now(): Date;

  lockMs?: number;

  batchSize?: number;

  maxAttempts?: number;
}

export interface SweepResult {
  claimed: number;
  reverted: number;

  retrying: number;

  abandoned: number;
}

const DEFAULT_LOCK_MS = 60_000;
const DEFAULT_BATCH_SIZE = 50;
const DEFAULT_MAX_ATTEMPTS = 5;

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
