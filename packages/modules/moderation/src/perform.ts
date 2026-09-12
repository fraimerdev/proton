import {
  type ActionKind,
  type ActionRequest,
  type ActionResult,
  type CommandContext,
  isScopedActionExecutor,
  parseDuration,
} from '@proton/core';
import type { ModerationConfig } from './config.ts';

export const MODULE_ID = 'moderation';

export function everyoneRoleId(guildId: string): string {
  return guildId;
}

export interface Refusal {
  refusal: string;
}

export interface ActionPlan {
  kind: ActionKind;
  targetId?: string;
  payload: Record<string, unknown>;
  reason?: string;
  expiresAt?: Date;

  success: string;

  // What to say instead when the action landed but its automatic reversal never got scheduled.
  // `success` promises the ban or timeout lifts on its own, and appending the failure underneath
  // that promise told the moderator both that it lifts and that it does not.
  successWithoutReversal?: string;

  onRecorded?(): Promise<void>;

  // What to say instead when onRecorded threw. Without one the throw is only logged, which is
  // right for a follow-up event nobody typed a command to get and wrong for a follow-up that is
  // the point of the command — a withdrawal that never landed must not be reported as one.
  successWithoutFollowUp?: string;

  // The target's roles, when the handler already had to read them. Handed to the executor so its
  // hierarchy precheck ranks them from this rather than fetching the same member a second time.
  targetRoleIds?: string[];
}

export type PlanResult = ActionPlan | Refusal;

export function isRefusal<T extends object>(value: T | Refusal): value is Refusal {
  return 'refusal' in value;
}

export function readSpan(raw: string): { ms: number } | Refusal {
  try {
    return { ms: parseDuration(raw) };
  } catch (error) {
    return { refusal: error instanceof Error ? error.message : `'${raw}' is not a duration.` };
  }
}

const REASON_REQUIRED =
  'This server requires a reason for moderation actions. Run the command again with ' +
  'the `reason` option filled in.';

// Exported for the paths that do not go through perform — a mass role run is a scheduled job, not
// one action with one reply, so it has to fail this gate for itself.
export function reasonRefusal(
  ctx: CommandContext<ModerationConfig>,
  reason: string | null | undefined,
): Refusal | null {
  return ctx.config.requireReason && !reason ? { refusal: REASON_REQUIRED } : null;
}

export function readDuration(raw: string, label: string): { ms: number } | Refusal {
  const span = readSpan(raw);
  if (isRefusal(span)) return span;

  if (span.ms <= 0) {
    return { refusal: `${label} needs to be longer than zero — '${raw}' expires immediately.` };
  }

  return span;
}

export async function perform(
  ctx: CommandContext<ModerationConfig>,
  plan: PlanResult,
): Promise<void> {
  if (isRefusal(plan)) {
    await reply(ctx, plan.refusal);
    return;
  }

  const missingReason = reasonRefusal(ctx, plan.reason);
  if (missingReason) {
    await reply(ctx, missingReason.refusal);
    return;
  }

  const request: ActionRequest = {
    guildId: ctx.guildId,
    moduleId: MODULE_ID,
    kind: plan.kind,
    actorId: ctx.userId,
    ...(plan.targetId ? { targetId: plan.targetId } : {}),
    ...(plan.reason ? { reason: plan.reason } : {}),
    payload: plan.payload,
    ...(plan.expiresAt ? { expiresAt: plan.expiresAt } : {}),
    dryRun: false,

    idempotencyKey: `${ctx.idempotencyKey}:${plan.kind}`,
  };

  const executor =
    plan.targetRoleIds && isScopedActionExecutor(ctx.executor)
      ? ctx.executor.scoped({ targetRoleIds: plan.targetRoleIds })
      : ctx.executor;

  const result = await executor.execute(request);

  if (result.status === 'failed_precheck' || result.status === 'failed_api') {
    ctx.logger.warn(`${plan.kind} refused: ${result.failure?.humanReason ?? 'unknown reason'}`, {
      guildId: ctx.guildId,
      moduleId: MODULE_ID,
      kind: plan.kind,
      code: result.failure?.code,
    });
  }

  let followUpFailed = false;

  if (result.status === 'executed' && plan.onRecorded) {
    try {
      await plan.onRecorded();
    } catch (error) {
      followUpFailed = true;
      ctx.logger.error(
        `${plan.kind} was recorded, but its follow-up did not run, so any rule triggered on it ` +
          `will not fire for this action: ${
            error instanceof Error ? error.message : String(error)
          }`,
        { guildId: ctx.guildId, moduleId: MODULE_ID, kind: plan.kind },
      );
    }
  }

  await reply(ctx, describe(plan, result, followUpFailed));
}

function stamped(text: string, result: ActionResult): string {
  return result.caseId ? `${text}\n-# Case \`${result.caseId}\`` : text;
}

function describe(plan: ActionPlan, result: ActionResult, followUpFailed = false): string {
  switch (result.status) {
    case 'executed': {
      if (followUpFailed && plan.successWithoutFollowUp) {
        return stamped(plan.successWithoutFollowUp, result);
      }

      if (!result.failure) return stamped(plan.success, result);

      const landed = plan.successWithoutReversal ?? plan.success;
      return stamped(`${landed}\n\n${result.failure.humanReason}`, result);
    }

    case 'dry_run':
      return stamped(
        `${plan.success}\n\nDiscord was not called — the case was recorded as a rehearsal.`,
        result,
      );

    case 'skipped_duplicate':
      return 'I had already handled this command, so I did nothing a second time.';

    case 'failed_precheck':
    case 'failed_api':
      return result.failure?.humanReason ?? "That didn't go through, and I wasn't told why.";
  }
}

export async function reply(ctx: CommandContext<ModerationConfig>, content: string): Promise<void> {
  const result = await ctx.executor.execute({
    guildId: ctx.guildId,
    moduleId: MODULE_ID,
    kind: 'interaction_reply',
    actorId: ctx.userId,
    idempotencyKey: `${ctx.idempotencyKey}:reply`,
    dryRun: false,
    payload: {
      interactionId: ctx.interaction.id,
      interactionToken: ctx.interaction.token,

      content: content.slice(0, 2000),
      ephemeral: !ctx.config.publicReplies,

      // Rendered, but notifying nobody. These replies name the member acted on and the role
      // handed out, and under publicReplies they are ordinary channel messages — /role add
      // announcing a mentionable role would otherwise ping everybody already in it.
      allowedMentions: { parse: [] },
    },
  });

  if (result.status === 'failed_precheck' || result.status === 'failed_api') {
    ctx.logger.warn(
      `moderation could not answer the invoker: ${result.failure?.humanReason ?? 'unknown reason'}`,
      { guildId: ctx.guildId, moduleId: MODULE_ID, code: result.failure?.code },
    );
  }
}
