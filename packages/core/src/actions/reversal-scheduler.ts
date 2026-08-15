import type { Logger } from '../modules/manifest.ts';
import { planReversal, reversalIdempotencyKey } from './reversal.ts';
import type { ScheduledActionStore } from './scheduled-actions.ts';
import type { ActionRequest } from './types.ts';

export interface ReversalSchedulerDeps {
  store: ScheduledActionStore;
  logger: Logger;
}

/**
 * The executor's `scheduleReversal` dependency (PLAN.md §4-P3, last pipeline step).
 *
 * Writes one `scheduled_actions` row keyed by a derived idempotency key, so the
 * *when* of a temporary action is durable in Postgres rather than held in a
 * process's memory or a queue's delayed set. A worker restart, a deploy or a
 * Redis flush must not be able to turn a temp ban into a permanent one.
 */
export class DatabaseReversalScheduler {
  readonly #deps: ReversalSchedulerDeps;

  constructor(deps: ReversalSchedulerDeps) {
    this.#deps = deps;
  }

  async schedule(request: ActionRequest, caseId: string): Promise<void> {
    const runAt = request.expiresAt;
    if (!runAt) return;

    const planned = planReversal(request);
    if ('error' in planned) {
      // Unreachable in practice: the executor refuses an `expiresAt` on a kind
      // it cannot reverse before it calls Discord. Throwing here would be worse
      // than logging — the action has already happened, and unwinding the
      // executor at this point would free its idempotency key and invite a
      // second ban.
      this.#deps.logger.error(`reversal not scheduled: ${planned.error}`, {
        guildId: request.guildId,
        caseId,
        kind: request.kind,
      });
      return;
    }

    const { scheduled } = await this.#deps.store.schedule({
      guildId: request.guildId,
      runAt,
      kind: planned.plan.kind,
      idempotencyKey: reversalIdempotencyKey(request.idempotencyKey),
      payload: {
        caseId,
        moduleId: request.moduleId,
        actorId: request.actorId,
        originalKind: request.kind,
        action: planned.plan.payload,
        ...(request.targetId ? { targetId: request.targetId } : {}),
        reason: `Temporary ${request.kind} expired.`,
      },
    });

    if (!scheduled) {
      // The same action was executed twice past the dedupe window (a Redis flush
      // between the two deliveries, say). One row, one reversal — as intended.
      this.#deps.logger.info('reversal was already scheduled for this action', {
        guildId: request.guildId,
        caseId,
        kind: request.kind,
      });
    }
  }
}
