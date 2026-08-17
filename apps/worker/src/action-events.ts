import type { CaseInput, CaseRecorder, EventBus, Logger } from '@proton/core';

export interface PublishingCaseRecorderDeps {
  inner: CaseRecorder;
  bus: EventBus;
  logger: Logger;

  publishFor?(input: CaseInput): boolean;

  now?(): number;
}

// The recorder, not the executor: #record() runs on exactly the paths that produced a durable
// state change, it already carries every field a log needs, and it hands back the case id that
// becomes the event's natural key. packages/core stays untouched.
export class PublishingCaseRecorder implements CaseRecorder {
  readonly #deps: PublishingCaseRecorderDeps;

  constructor(deps: PublishingCaseRecorderDeps) {
    this.#deps = deps;
  }

  async record(input: CaseInput): Promise<{ caseId: string }> {
    const result = await this.#deps.inner.record(input);

    if (this.#deps.publishFor?.(input) ?? true) {
      try {
        await this.#publish(input, result.caseId);
      } catch (error) {
        this.#deps.logger.error(
          `the ${input.kind} was recorded as case ${result.caseId} but could not be published, ` +
            `so no Proton log was posted for it: ${
              error instanceof Error ? error.message : String(error)
            }`,
          { guildId: input.guildId, moduleId: input.moduleId },
        );
      }
    }

    return result;
  }

  async #publish(input: CaseInput, caseId: string): Promise<void> {
    await this.#deps.bus.publish({
      id: `proton.action_executed:${input.guildId}:${caseId}`,
      type: 'proton.action_executed',
      guildId: input.guildId,
      occurredAt: this.#deps.now?.() ?? Date.now(),
      payload: {
        caseId,
        guildId: input.guildId,
        moduleId: input.moduleId,
        kind: input.kind,
        actorId: input.actorId,
        targetId: input.targetId ?? null,
        reason: input.reason ?? null,
        dryRun: input.dryRun,
        expiresAt: input.expiresAt ? input.expiresAt.getTime() : null,
      },
    });
  }
}

export const SERVERLOG_MODULE = 'serverlog';

export function publishableCase(input: CaseInput): boolean {
  return input.moduleId !== SERVERLOG_MODULE && !input.dryRun;
}
