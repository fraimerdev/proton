import type {
  ActionRequest,
  ActionResult,
  CommandContext,
  FollowUpTo,
  InteractionRef,
  ModuleContext,
  RespondTo,
} from '@proton/core';
import type { VerificationConfig } from './config.ts';
import type { RoleStep } from './roles.ts';

export const MODULE_ID = 'verification';

export const VERIFICATION_ACTOR = 'proton:verification';

export const REASON_MAX = 512;
export const MESSAGE_MAX = 2000;

export interface StepReport {
  applied: string[];

  failures: string[];
}

export interface RunStepsInput {
  targetId: string;
  actorId: string;
  reason?: string | undefined;
  steps: readonly RoleStep[];

  idempotencyRoot: string;

  payloadExtra?: Record<string, unknown>;
}

export async function runSteps(
  ctx: ModuleContext<VerificationConfig>,
  input: RunStepsInput,
): Promise<StepReport> {
  const applied: string[] = [];
  const failures: string[] = [];

  for (const step of input.steps) {
    const result = await ctx.executor.execute({
      guildId: ctx.guildId,
      moduleId: MODULE_ID,
      kind: step.kind,
      actorId: input.actorId,
      targetId: input.targetId,
      ...(input.reason ? { reason: input.reason.slice(0, REASON_MAX) } : {}),
      payload: { userId: input.targetId, roleId: step.roleId, ...input.payloadExtra },
      dryRun: false,
      idempotencyKey: `${MODULE_ID}:${input.idempotencyRoot}:${step.kind}:${step.roleId}`,
    });

    if (succeeded(result)) {
      applied.push(step.roleId);
    } else {
      failures.push(`${step.what}: ${result.failure?.humanReason ?? 'no reason was reported'}`);
    }
  }

  return { applied, failures };
}

export function succeeded(result: ActionResult): boolean {
  return (
    result.status === 'executed' ||
    result.status === 'dry_run' ||
    result.status === 'skipped_duplicate'
  );
}

export function respondTo(
  ctx: ModuleContext<VerificationConfig>,
  interaction: InteractionRef,
  actorId: string,
  idempotencyRoot: string,
): RespondTo {
  return {
    guildId: ctx.guildId,
    moduleId: MODULE_ID,
    actorId,
    interaction,
    idempotencyKey: `${MODULE_ID}:${idempotencyRoot}`,
  };
}

export function followUpTo(to: RespondTo, applicationId: string): FollowUpTo {
  return { ...to, applicationId };
}

export async function run(
  ctx: ModuleContext<VerificationConfig>,
  request: ActionRequest,
  attempt: string,
): Promise<ActionResult> {
  const result = await ctx.executor.execute(request);

  if (result.status === 'failed_precheck' || result.status === 'failed_api') {
    ctx.logger.warn(
      `verification could not ${attempt}: ${result.failure?.humanReason ?? 'no reason was reported'}`,
      { guildId: ctx.guildId, moduleId: MODULE_ID, code: result.failure?.code },
    );
  }

  return result;
}

export async function reply(
  ctx: CommandContext<VerificationConfig>,
  content: string,
): Promise<void> {
  const result = await ctx.executor.execute({
    guildId: ctx.guildId,
    moduleId: MODULE_ID,
    kind: 'interaction_reply',
    actorId: ctx.userId,
    idempotencyKey: `${MODULE_ID}:${ctx.idempotencyKey}:reply`,
    dryRun: false,
    payload: {
      interactionId: ctx.interaction.id,
      interactionToken: ctx.interaction.token,

      content: content.slice(0, MESSAGE_MAX),
      ephemeral: true,
    },
  });

  if (result.status === 'failed_precheck' || result.status === 'failed_api') {
    ctx.logger.warn(
      `verification could not answer the invoker: ${result.failure?.humanReason ?? 'unknown reason'}`,
      { guildId: ctx.guildId, moduleId: MODULE_ID, code: result.failure?.code },
    );
  }
}
