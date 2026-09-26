import {
  type ActionKind,
  type CaseInput,
  type CaseRecorder,
  type EventBus,
  isReversalIdempotencyKey,
  type Logger,
  lockdownPayloadSchema,
  purgePayloadSchema,
  slowmodePayloadSchema,
  timeoutPayloadSchema,
  unlockPayloadSchema,
} from '@proton/core';
import { z } from 'zod';

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
        ...(input.kind === 'timeout' ? { until: timeoutEnd(input.payload) } : {}),
        ...channelOf(input),
        ...(isReversalIdempotencyKey(input.idempotencyKey) ? { reversal: true } : {}),
      },
    });
  }
}

const renewedTimeoutSchema = timeoutPayloadSchema.extend({ endsAt: z.date().optional() });

// Discord is only ever given 28 days; a longer timeout's real end is the one Proton renews to.
function timeoutEnd(payload: unknown): number | null {
  const parsed = renewedTimeoutSchema.safeParse(payload);
  if (!parsed.success) return null;

  const { until, endsAt } = parsed.data;
  return Math.max(until.getTime(), endsAt?.getTime() ?? 0);
}

const CHANNEL_PAYLOADS: Partial<Record<ActionKind, z.ZodType<{ channelId: string }>>> = {
  purge: purgePayloadSchema,
  lockdown: lockdownPayloadSchema,
  unlock: unlockPayloadSchema,
};

function channelOf(input: CaseInput): { channelId?: string | null; seconds?: number } {
  if (input.kind === 'slowmode') {
    const parsed = slowmodePayloadSchema.safeParse(input.payload);
    return parsed.success ? parsed.data : { channelId: null };
  }

  const schema = CHANNEL_PAYLOADS[input.kind];
  if (!schema) return {};

  const parsed = schema.safeParse(input.payload);
  return { channelId: parsed.success ? parsed.data.channelId : null };
}

export const SERVERLOG_MODULE = 'serverlog';

export function publishableCase(input: CaseInput): boolean {
  return input.moduleId !== SERVERLOG_MODULE && !input.dryRun;
}
