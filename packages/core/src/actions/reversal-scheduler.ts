import type { Logger } from '../modules/manifest.ts';
import { planReversal, reversalIdempotencyKey } from './reversal.ts';
import type { ScheduledActionStore } from './scheduled-actions.ts';
import type { ActionRequest } from './types.ts';

export interface ReversalSchedulerDeps {
  store: ScheduledActionStore;
  logger: Logger;
}

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
      this.#deps.logger.info('reversal was already scheduled for this action', {
        guildId: request.guildId,
        caseId,
        kind: request.kind,
      });
    }
  }
}
