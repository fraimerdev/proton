import {
  type ActionKind,
  type ActionRequest,
  type ActionResult,
  type CommandContext,
  type CommandReplyPolicy,
  errorStatus,
  isScopedActionExecutor,
  parseDuration,
  type StatusBody,
  successStatus,
} from '@proton/core';
import type { ModerationConfig } from './config.ts';

export const MODULE_ID = 'moderation';

export function moderationReply(
  toggleable: readonly string[],
): CommandReplyPolicy<ModerationConfig> {
  return {
    default: (config) => (config.publicReplies ? 'public' : 'private'),
    toggleable,
    inheritsFrom: { label: 'Moderation → Reply publicly', moduleId: MODULE_ID },
  };
}

export function repliesPrivately(
  ctx: Pick<CommandContext<ModerationConfig>, 'config' | 'privateReply'>,
): boolean {
  return ctx.privateReply ?? !ctx.config.publicReplies;
}

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
    return { refusal: error instanceof Error ? error.message : `'${raw}' isn't a duration.` };
  }
}

const REASON_REQUIRED =
  'This server requires a reason for moderation actions. Run the command again with ' +
  'the `reason` option filled in.';

export function refusalOf(config: ModerationConfig, plan: PlanResult): string | null {
  if (isRefusal(plan)) return plan.refusal;

  const types: Partial<Record<ActionKind, { forceReason: boolean }>> = config.punish.types;
  return types[plan.kind]?.forceReason && !plan.reason ? REASON_REQUIRED : null;
}

export function readDuration(raw: string, label: string): { ms: number } | Refusal {
  const span = readSpan(raw);
  if (isRefusal(span)) return span;

  if (span.ms <= 0) {
    return { refusal: `${label} needs to be longer than zero, but '${raw}' ends immediately.` };
  }

  return span;
}

export type Answer = (body: StatusBody) => Promise<void>;

export async function perform(
  ctx: CommandContext<ModerationConfig>,
  plan: PlanResult,
  answer: Answer = (body) => reply(ctx, body),
): Promise<void> {
  if (isRefusal(plan)) return answer(errorStatus(plan.refusal));

  const refusal = refusalOf(ctx.config, plan);
  if (refusal !== null) return answer(errorStatus(refusal));

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

  await answer(describe(plan, result, followUpFailed));
}

function stamped(text: string, result: ActionResult): string {
  return result.caseId ? `${text}\n-# Case \`${result.caseId}\`` : text;
}

function describe(plan: ActionPlan, result: ActionResult, followUpFailed = false): StatusBody {
  switch (result.status) {
    case 'executed': {
      // Red although the action itself landed: successWithoutFollowUp is only set where the
      // follow-up *is* the command, so the thing the invoker asked for did not happen.
      if (followUpFailed && plan.successWithoutFollowUp) {
        return errorStatus(stamped(plan.successWithoutFollowUp, result));
      }

      if (!result.failure) return successStatus(stamped(plan.success, result));

      const landed = plan.successWithoutReversal ?? plan.success;
      return successStatus(stamped(`${landed}\n\n${result.failure.humanReason}`, result));
    }

    // Red because nobody was actually banned: a rehearsal records a case and calls no one. Kept
    // for exhaustiveness only — perform() hard-codes dryRun:false, so nothing reaches this today.
    case 'dry_run':
      return errorStatus(
        stamped(
          `${plan.success}\n\nDiscord wasn't called. The case was recorded as a rehearsal.`,
          result,
        ),
      );

    case 'skipped_duplicate':
      return errorStatus("I already handled this command, so I didn't run it again.");

    case 'failed_precheck':
    case 'failed_api':
      return errorStatus(
        result.failure?.humanReason ?? "That didn't go through, and I wasn't told why.",
      );
  }
}

export async function reply(
  ctx: CommandContext<ModerationConfig>,
  message: string | StatusBody,
): Promise<void> {
  const body = typeof message === 'string' ? { content: message.slice(0, 2000) } : message;

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

      ...body,
      ephemeral: repliesPrivately(ctx),

      // A public text reply naming a mentionable role would ping everyone in it.
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
