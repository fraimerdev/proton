import {
  type ActionResult,
  dryRunFor,
  INTERACTION_CALLBACK_CHANNEL_MESSAGE,
  INTERACTION_CALLBACK_DEFERRED_MESSAGE,
  type ModuleContext,
} from '@proton/core';
import type { RolemenuConfig } from './config.ts';

export const MODULE_ID = 'rolemenu';

export const REASON_MAX = 512;
export const MESSAGE_MAX = 2000;

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
      dryRun: dryRunFor(step.kind),
      idempotencyKey: `${MODULE_ID}:${input.idempotencyRoot}:${step.kind}:${step.roleId}`,
    });

    if (succeeded(result)) {
      (step.kind === 'add_role' ? report.added : report.removed).push(step.roleId);
    } else {
      const what = step.kind === 'add_role' ? 'giving you' : 'taking away';
      report.failures.push(
        `${what} <@&${step.roleId}>: ${result.failure?.humanReason ?? 'no reason was reported'}`,
      );
    }
  }

  return report;
}

export interface InteractionRef {
  id: string;
  token: string;
}

export async function deferEphemeral(
  ctx: ModuleContext<RolemenuConfig>,
  interaction: InteractionRef,
  actorId: string,
  idempotencyRoot: string,
): Promise<ActionResult> {
  return acknowledge(ctx, interaction, actorId, idempotencyRoot, {
    callbackType: INTERACTION_CALLBACK_DEFERRED_MESSAGE,
  });
}

export async function replyEphemeral(
  ctx: ModuleContext<RolemenuConfig>,
  interaction: InteractionRef,
  actorId: string,
  idempotencyRoot: string,
  content: string,
): Promise<ActionResult> {
  return acknowledge(ctx, interaction, actorId, idempotencyRoot, {
    callbackType: INTERACTION_CALLBACK_CHANNEL_MESSAGE,
    content: content.slice(0, MESSAGE_MAX),
  });
}

async function acknowledge(
  ctx: ModuleContext<RolemenuConfig>,
  interaction: InteractionRef,
  actorId: string,
  idempotencyRoot: string,
  data: { callbackType: number; content?: string },
): Promise<ActionResult> {
  const result = await ctx.executor.execute({
    guildId: ctx.guildId,
    moduleId: MODULE_ID,
    kind: 'interaction_reply',
    actorId,

    dryRun: false,

    idempotencyKey: `${MODULE_ID}:${idempotencyRoot}:ack`,
    payload: {
      interactionId: interaction.id,
      interactionToken: interaction.token,
      ephemeral: true,
      ...data,
    },
  });

  if (!succeeded(result)) {
    ctx.logger.warn(
      `rolemenu could not acknowledge an interaction: ${result.failure?.humanReason ?? 'unknown reason'}`,
      { guildId: ctx.guildId, moduleId: MODULE_ID, code: result.failure?.code },
    );
  }

  return result;
}

export async function followUp(
  ctx: ModuleContext<RolemenuConfig>,
  target: { applicationId: string; interactionToken: string },
  actorId: string,
  idempotencyRoot: string,
  content: string,
): Promise<ActionResult> {
  const result = await ctx.executor.execute({
    guildId: ctx.guildId,
    moduleId: MODULE_ID,
    kind: 'interaction_followup',
    actorId,
    dryRun: false,
    idempotencyKey: `${MODULE_ID}:${idempotencyRoot}:followup`,
    payload: {
      applicationId: target.applicationId,
      interactionToken: target.interactionToken,

      content: content.slice(0, MESSAGE_MAX),
      ephemeral: true,
    },
  });

  if (!succeeded(result)) {
    ctx.logger.warn(
      `rolemenu could not tell the member what happened: ${result.failure?.humanReason ?? 'unknown reason'}`,
      { guildId: ctx.guildId, moduleId: MODULE_ID, code: result.failure?.code },
    );
  }

  return result;
}

export function describeReport(report: RoleChangeReport): string {
  const parts: string[] = [];

  if (report.added.length > 0) {
    parts.push(`Gave you ${report.added.map((id) => `<@&${id}>`).join(', ')}.`);
  }
  if (report.removed.length > 0) {
    parts.push(`Took away ${report.removed.map((id) => `<@&${id}>`).join(', ')}.`);
  }
  if (report.failures.length > 0) {
    parts.push(`I couldn't finish: ${report.failures.join(' | ')}`);
  }

  if (parts.length === 0) {
    return 'Nothing changed — you already had exactly the roles you asked for.';
  }

  return parts.join(' ');
}
