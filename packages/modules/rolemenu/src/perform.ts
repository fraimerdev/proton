import {
  type ActionRequest,
  type ActionResult,
  deferEphemeral as buildDeferEphemeral,
  followUp as buildFollowUp,
  replyEphemeral as buildReplyEphemeral,
  type InteractionRef,
  MESSAGE_CONTENT_MAX,
  type ModuleContext,
  type RespondTo,
  type StatusBody,
} from '@proton/core';
import { MODULE_ID, type RolemenuConfig } from './config.ts';

export { MODULE_ID } from './config.ts';

export const REASON_MAX = 512;
export const MESSAGE_MAX = MESSAGE_CONTENT_MAX;

export function succeeded(result: ActionResult): boolean {
  return (
    result.status === 'executed' ||
    result.status === 'dry_run' ||
    result.status === 'skipped_duplicate'
  );
}

export interface RoleChangeReport {
  added: string[];
  removed: string[];

  failures: string[];
}

export interface RunRoleChangesInput {
  userId: string;
  menuId: string;
  add: readonly string[];
  remove: readonly string[];

  idempotencyRoot: string;
}

export async function runRoleChanges(
  ctx: ModuleContext<RolemenuConfig>,
  input: RunRoleChangesInput,
): Promise<RoleChangeReport> {
  const report: RoleChangeReport = { added: [], removed: [], failures: [] };

  const steps = [
    ...input.remove.map((roleId) => ({ kind: 'remove_role' as const, roleId })),
    ...input.add.map((roleId) => ({ kind: 'add_role' as const, roleId })),
  ];

  for (const step of steps) {
    const result = await ctx.executor.execute({
      guildId: ctx.guildId,
      moduleId: MODULE_ID,
      kind: step.kind,
      actorId: input.userId,
      targetId: input.userId,
      reason: `Role menu '${input.menuId}': the member chose this themselves.`.slice(0, REASON_MAX),
      payload: { userId: input.userId, roleId: step.roleId, menuId: input.menuId },
      dryRun: false,
      idempotencyKey: `${MODULE_ID}:${input.idempotencyRoot}:${step.kind}:${step.roleId}`,
    });

    if (succeeded(result)) {
      (step.kind === 'add_role' ? report.added : report.removed).push(step.roleId);
    } else {
      const what = step.kind === 'add_role' ? "Couldn't give you" : "Couldn't take away";
      report.failures.push(
        `${what} <@&${step.roleId}>. ${result.failure?.humanReason ?? 'No reason was given.'}`,
      );
    }
  }

  return report;
}

function respondTo(
  ctx: ModuleContext<RolemenuConfig>,
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

async function run(
  ctx: ModuleContext<RolemenuConfig>,
  request: ActionRequest,
  failed: string,
): Promise<ActionResult> {
  const result = await ctx.executor.execute(request);

  if (!succeeded(result)) {
    ctx.logger.warn(
      `rolemenu could not ${failed}: ${result.failure?.humanReason ?? 'unknown reason'}`,
      {
        guildId: ctx.guildId,
        moduleId: MODULE_ID,
        code: result.failure?.code,
      },
    );
  }

  return result;
}

export async function deferEphemeral(
  ctx: ModuleContext<RolemenuConfig>,
  interaction: InteractionRef,
  actorId: string,
  idempotencyRoot: string,
): Promise<ActionResult> {
  return run(
    ctx,
    buildDeferEphemeral(respondTo(ctx, interaction, actorId, idempotencyRoot)),
    'acknowledge an interaction',
  );
}

export async function replyEphemeral(
  ctx: ModuleContext<RolemenuConfig>,
  interaction: InteractionRef,
  actorId: string,
  idempotencyRoot: string,
  message: string | StatusBody,
): Promise<ActionResult> {
  return run(
    ctx,
    buildReplyEphemeral(respondTo(ctx, interaction, actorId, idempotencyRoot), message),
    'acknowledge an interaction',
  );
}

export async function followUp(
  ctx: ModuleContext<RolemenuConfig>,
  target: { applicationId: string; interaction: InteractionRef },
  actorId: string,
  idempotencyRoot: string,
  message: string | StatusBody,
): Promise<ActionResult> {
  return run(
    ctx,
    buildFollowUp(
      {
        ...respondTo(ctx, target.interaction, actorId, idempotencyRoot),
        applicationId: target.applicationId,
      },
      message,
    ),
    'tell the member what happened',
  );
}

export function describeReport(report: RoleChangeReport): string {
  const parts: string[] = [];

  if (report.added.length > 0) {
    parts.push(`Gave you ${report.added.map((id) => `<@&${id}>`).join(', ')}.`);
  }
  if (report.removed.length > 0) {
    parts.push(`Took away ${report.removed.map((id) => `<@&${id}>`).join(', ')}.`);
  }
  parts.push(...report.failures);

  if (parts.length === 0) {
    return 'Nothing changed. You already have the roles you picked.';
  }

  return parts.join(' ');
}
