import type { Logger } from '../modules/manifest.ts';
import { isActionKind } from './kinds.ts';
import { AUTO_REVERSAL_ACTOR, type CaseReversalStore } from './reversal.ts';
import {
  type CompleteOutcome,
  type ScheduledActionInput,
  type ScheduledActionRecord,
  type ScheduledActionStore,
  type ScheduledModulePayload,
  type ScheduledReversalPayload,
  scheduledActionPayloadSchema,
} from './scheduled-actions.ts';
import type { ActionExecutor, ActionRequest } from './types.ts';

export interface ScheduledModuleJob {
  guildId: string;
  moduleId: string;
  jobId: string;

  data: unknown;

  idempotencyKey: string;
  attempts: number;

  reschedule(next: Omit<ScheduledActionInput, 'onConflict'>): Promise<CompleteOutcome>;
}

export interface ScheduledActionSweeperDeps {
  store: ScheduledActionStore;
  cases: CaseReversalStore;

  executor: ActionExecutor;
  logger: Logger;

  now(): Date;

  runModuleJob?(job: ScheduledModuleJob): Promise<void>;

  lockMs?: number;

  renewMs?: number;

  batchSize?: number;

  maxAttempts?: number;
}

export interface SweepResult {
  claimed: number;
  reverted: number;

  ran: number;

  retrying: number;

  abandoned: number;

  aborted: number;
}

const DEFAULT_LOCK_MS = 60_000;
const DEFAULT_BATCH_SIZE = 50;
const DEFAULT_MAX_ATTEMPTS = 5;
const RENEWALS_PER_LEASE = 3;

// dead, but packages/core/src/index.ts still re-exports it: drop both in the same change or the
// barrel stops linking
export const sweepClaimKey = (idempotencyKey: string): string => `sweep:${idempotencyKey}`;

type SweepOutcome = 'reverted' | 'ran' | 'retrying' | 'abandoned' | 'aborted';

interface Lease {
  lost(): boolean;
  markLost(): void;
  stop(): Promise<void>;
}

interface RunState {
  retired: boolean;
}

interface Arm {
  label: string;
  outcome: 'reverted' | 'ran';

  perform(lease: Lease, state: RunState): Promise<string | null>;
  settle?(): Promise<void>;
  logSuccess(): void;
}

const reasonFor = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export class ScheduledActionSweeper {
  readonly #deps: ScheduledActionSweeperDeps;
  readonly #lockMs: number;
  readonly #renewMs: number;
  readonly #batchSize: number;
  readonly #maxAttempts: number;

  constructor(deps: ScheduledActionSweeperDeps) {
    this.#deps = deps;
    this.#lockMs = deps.lockMs ?? DEFAULT_LOCK_MS;
    this.#renewMs = deps.renewMs ?? Math.max(1, Math.floor(this.#lockMs / RENEWALS_PER_LEASE));
    this.#batchSize = deps.batchSize ?? DEFAULT_BATCH_SIZE;
    this.#maxAttempts = deps.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  }

  async sweep(): Promise<SweepResult> {
    const now = this.#deps.now();
    const lockUntil = new Date(now.getTime() + this.#lockMs);

    const claimed = await this.#deps.store.claimDue({
      now,
      lockUntil,
      limit: this.#batchSize,
      maxAttempts: this.#maxAttempts,
    });

    const result: SweepResult = {
      claimed: claimed.length,
      reverted: 0,
      ran: 0,
      retrying: 0,
      abandoned: 0,
      aborted: 0,
    };

    for (const row of claimed) {
      try {
        result[await this.#dispatch(row, now, lockUntil)] += 1;
      } catch (error) {
        // claimDue already spent an attempt on every other row in the batch, so one row's
        // store failure must not escape this loop and strand them undispatched
        result.aborted += 1;
        this.#deps.logger.error(
          `the sweep could not finish a scheduled ${row.kind}: ${reasonFor(error)}. Its lock is ` +
            `left to lapse, after which another sweep claims it — one of its ${this.#maxAttempts} ` +
            'attempts has been spent on this.',
          {
            guildId: row.guildId,
            scheduledActionId: row.id,
            kind: row.kind,
            attempts: row.attempts,
          },
        );
      }
    }

    return result;
  }

  async #dispatch(row: ScheduledActionRecord, now: Date, lockUntil: Date): Promise<SweepOutcome> {
    const parsed = scheduledActionPayloadSchema.safeParse(row.payload);
    if (!parsed.success) {
      return this.#failed(
        row,
        `its stored payload no longer matches the expected shape (${parsed.error.issues
          .map((i) => `${i.path.map(String).join('.')} ${i.message}`)
          .join('; ')})`,
      );
    }

    const arm =
      parsed.data.kind === 'module'
        ? this.#moduleArm(row, parsed.data)
        : this.#reversalArm(row, parsed.data, now);

    return 'failure' in arm
      ? this.#failed(row, arm.failure)
      : this.#underLease(row, lockUntil, arm);
  }

  async #underLease(row: ScheduledActionRecord, lockUntil: Date, arm: Arm): Promise<SweepOutcome> {
    const lease = this.#lease(row, arm.label, lockUntil);
    const state: RunState = { retired: false };

    let failure: string | null;
    try {
      failure = await arm.perform(lease, state);
    } catch (error) {
      failure = `${arm.label} threw: ${reasonFor(error)}`;
    }
    await lease.stop();

    if (state.retired) {
      if (failure === null) {
        arm.logSuccess();
        return arm.outcome;
      }

      this.#deps.logger.error(
        `${arm.label} booked its next run and then failed: ${failure}. The next run stands, so ` +
          'this one is not retried — whatever it had left to do after rescheduling itself did ' +
          'not happen.',
        { guildId: row.guildId, scheduledActionId: row.id, attempts: row.attempts },
      );
      return 'aborted';
    }

    if (lease.lost()) return this.#aborted(row, arm.label, failure);
    if (failure !== null) return this.#failed(row, failure);

    await arm.settle?.();

    if ((await this.#deps.store.complete(row.id, row.lockToken)) === 'lost') {
      return this.#aborted(row, arm.label, null);
    }

    arm.logSuccess();
    return arm.outcome;
  }

  #moduleArm(
    row: ScheduledActionRecord,
    payload: ScheduledModulePayload,
  ): Arm | { failure: string } {
    const job = `${payload.moduleId}:${payload.jobId}`;
    const run = this.#deps.runModuleJob;

    if (!run) {
      return {
        failure:
          `this process cannot run module jobs — its sweeper was built without a runModuleJob ` +
          `port, so '${job}' has nowhere to go`,
      };
    }

    return {
      label: `the '${job}' job`,
      outcome: 'ran',

      perform: async (lease, state) => {
        await run({
          guildId: row.guildId,
          moduleId: payload.moduleId,
          jobId: payload.jobId,
          data: payload.data,
          idempotencyKey: row.idempotencyKey,
          attempts: row.attempts,

          reschedule: async (next) => {
            const outcome = await this.#deps.store.completeAndSchedule(row.id, row.lockToken, next);

            if (outcome === 'retired') state.retired = true;
            else lease.markLost();

            return outcome;
          },
        });

        return null;
      },

      logSuccess: () => {
        this.#deps.logger.info(`ran the scheduled '${job}' job`, {
          guildId: row.guildId,
          moduleId: payload.moduleId,
          jobId: payload.jobId,
          attempts: row.attempts,
        });
      },
    };
  }

  #reversalArm(
    row: ScheduledActionRecord,
    payload: ScheduledReversalPayload,
    now: Date,
  ): Arm | { failure: string } {
    if (!isActionKind(row.kind)) {
      return { failure: `'${row.kind}' is not an action Proton knows how to perform` };
    }

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

    let status = '';

    return {
      label: `the ${payload.originalKind} reversal for case ${payload.caseId}`,
      outcome: 'reverted',

      perform: async () => {
        const result = await this.#deps.executor.execute(request);
        status = result.status;

        return result.status === 'failed_precheck' || result.status === 'failed_api'
          ? (result.failure?.humanReason ?? `the executor returned ${result.status}`)
          : null;
      },

      // two writes, not a txn: markReverted skips an already-stamped case, so a crash can't restamp
      settle: () =>
        this.#deps.cases.markReverted({
          caseId: payload.caseId,
          revertedAt: now,
          revertedBy: AUTO_REVERSAL_ACTOR,
        }),

      logSuccess: () => {
        this.#deps.logger.info(`reverted a temporary ${payload.originalKind}`, {
          guildId: row.guildId,
          caseId: payload.caseId,
          kind: row.kind,
          status,
          attempts: row.attempts,
        });
      },
    };
  }

  #lease(row: ScheduledActionRecord, label: string, lockUntil: Date): Lease {
    const meta = { guildId: row.guildId, scheduledActionId: row.id };

    let deadline = lockUntil.getTime();
    let lost = false;
    let stopped = false;
    let pending: Promise<void> = Promise.resolve();

    const beat = async (): Promise<void> => {
      if (stopped || lost) return;

      const until = new Date(this.#deps.now().getTime() + this.#lockMs);
      try {
        if (await this.#deps.store.renew(row.id, row.lockToken, until)) {
          deadline = until.getTime();
          return;
        }

        lost = true;
        this.#deps.logger.error(
          `${label} lost the lease on the row it is running — the row was cancelled, replaced or ` +
            'claimed by another sweep while the handler was working, so this run may not retire ' +
            'it and the job will run a second time.',
          meta,
        );
      } catch (error) {
        if (this.#deps.now().getTime() < deadline) {
          this.#deps.logger.warn(
            `could not extend the lease on the row running ${label}: ${reasonFor(error)}. The ` +
              `lease still runs to ${new Date(deadline).toISOString()}; if every renewal until ` +
              'then fails, another sweep claims the row.',
            meta,
          );
          return;
        }

        lost = true;
        this.#deps.logger.error(
          `${label} lost the lease on the row it is running: no renewal has succeeded since ` +
            `${new Date(deadline).toISOString()} (${reasonFor(error)}), so the lock has lapsed ` +
            'and another sweep may already hold the row.',
          meta,
        );
      }
    };

    const timer = setInterval(() => {
      pending = pending.then(beat);
    }, this.#renewMs);

    return {
      lost: () => lost || this.#deps.now().getTime() >= deadline,
      markLost: () => {
        lost = true;
      },
      stop: async (): Promise<void> => {
        clearInterval(timer);
        stopped = true;
        await pending;
      },
    };
  }

  #aborted(row: ScheduledActionRecord, label: string, failure: string | null): 'aborted' {
    const meta = {
      guildId: row.guildId,
      scheduledActionId: row.id,
      kind: row.kind,
      attempts: row.attempts,
    };

    this.#deps.logger.error(
      failure === null
        ? `${label} finished, but this sweep no longer holds the lease on its row, so it left the ` +
            'row untouched rather than retiring a row it does not own. Whoever holds it now will ' +
            "run the job again. Raise the sweeper's lockMs past this job's worst-case runtime, or " +
            'look for clock skew between the workers and the database.'
        : `${label} failed (${failure}) and this sweep no longer holds the lease on its row, so ` +
            'it left the row untouched rather than unlocking a row it does not own. Whoever holds ' +
            'it now will retry it.',
      meta,
    );

    return 'aborted';
  }

  async #failed(row: ScheduledActionRecord, reason: string): Promise<'retrying' | 'abandoned'> {
    const meta = {
      guildId: row.guildId,
      scheduledActionId: row.id,
      kind: row.kind,
      attempts: row.attempts,
      reason,
    };

    // released even when abandoned: a lock nobody holds hides the row from every later repair
    await this.#deps.store.release(row.id, row.lockToken);

    if (row.attempts >= this.#maxAttempts) {
      this.#deps.logger.error(
        `giving up on a scheduled ${row.kind} after ${row.attempts} attempts — ` +
          `it must be performed by hand: ${reason}`,
        meta,
      );
      return 'abandoned';
    }

    this.#deps.logger.warn(`scheduled ${row.kind} failed, will retry: ${reason}`, meta);
    return 'retrying';
  }
}
