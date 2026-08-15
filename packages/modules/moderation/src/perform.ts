import {
  type ActionKind,
  type ActionRequest,
  type ActionResult,
  type CommandContext,
  dryRunFor,
  parseDuration,
} from '@proton/core';
import type { ModerationConfig } from './config.ts';

export const MODULE_ID = 'moderation';

/** Discord's `@everyone` role id is the guild id. */
export function everyoneRoleId(guildId: string): string {
  return guildId;
}

/**
 * A command that declined before Discord was involved at all — an unreadable
 * duration, a missing reason. Never a silent return: the invoker is always told.
 */
export interface Refusal {
  refusal: string;
}

/**
 * What a command decided to do, in the terms the executor understands plus the
 * one sentence a human wants back.
 *
 * Commands produce this and nothing else. They build no REST call, resolve no
 * permission and decide no dry-run policy (I1) — those belong to `perform` and,
 * beneath it, to the ActionExecutor.
 */
export interface ActionPlan {
  kind: ActionKind;
  targetId?: string;
  payload: Record<string, unknown>;
  reason?: string;
  expiresAt?: Date;
  /** Past tense, as the moderator should read it once it has happened. */
  success: string;
  /**
   * Run after the executor genuinely recorded the action, and never otherwise.
   *
   * Exists for `/warn`, which has to publish `moderation.warned` so the
   * escalation ladder can trigger on it. Deliberately gated on `executed`: a
   * warn refused by a precheck, or discarded as a duplicate, must not advance a
   * ladder that could time somebody out. A dry run does not fire it either —
   * the case row is a record of what *would* have happened, and cascading from
   * it would make development runs escalate for real.
   *
   * Failures here are logged, never surfaced as the command failing: by this
   * point the action has happened, and telling the moderator it did not would
   * be worse than the missed event.
   */
  onRecorded?(): Promise<void>;
}

export type PlanResult = ActionPlan | Refusal;

/** Generic so it narrows a parsed option as readily as it narrows a plan. */
export function isRefusal<T extends object>(value: T | Refusal): value is Refusal {
  return 'refusal' in value;
}

/**
 * Read a duration option.
 *
 * `InvalidDurationError`'s own message is surfaced verbatim: it already names
 * the accepted units and gives examples, and a second phrasing here would drift
 * from the one the dashboard shows for the same input.
 */
export function readSpan(raw: string): { ms: number } | Refusal {
  try {
    return { ms: parseDuration(raw) };
  } catch (error) {
    return { refusal: error instanceof Error ? error.message : `'${raw}' is not a duration.` };
  }
}

/** As `readSpan`, for the options where zero has no meaning — a temp ban, a timeout. */
export function readDuration(raw: string, label: string): { ms: number } | Refusal {
  const span = readSpan(raw);
  if (isRefusal(span)) return span;

  if (span.ms <= 0) {
    return { refusal: `${label} needs to be longer than zero — '${raw}' expires immediately.` };
  }

  return span;
}

/**
 * Run a plan and tell the invoker what happened, whatever happened.
 *
 * The reply is not conditional on success. Surfacing `failure.humanReason`
 * verbatim is the entire point of I8: the executor already knows which
 * permission is missing and where, and paraphrasing it here would throw that
 * away and leave "the bot did nothing" as the visible outcome (§1).
 */
export async function perform(
  ctx: CommandContext<ModerationConfig>,
  plan: PlanResult,
): Promise<void> {
  // A disabled module still answers. Returning silently would leave Discord
  // showing "This interaction failed" — indistinguishable from a crash, and the
  // moderator would have no idea a human switched it off.
  if (!ctx.config.enabled) {
    await reply(
      ctx,
      'Moderation commands are switched off in this server. An admin can turn the ' +
        'Moderation module back on from the Proton dashboard.',
    );
    return;
  }

  if (isRefusal(plan)) {
    await reply(ctx, plan.refusal);
    return;
  }

  if (ctx.config.requireReason && !plan.reason) {
    await reply(
      ctx,
      'This server requires a reason for moderation actions. Run the command again with ' +
        'the `reason` option filled in.',
    );
    return;
  }

  const dryRun = dryRunFor(plan.kind);

  const request: ActionRequest = {
    guildId: ctx.guildId,
    moduleId: MODULE_ID,
    kind: plan.kind,
    actorId: ctx.userId,
    ...(plan.targetId ? { targetId: plan.targetId } : {}),
    ...(plan.reason ? { reason: plan.reason } : {}),
    payload: plan.payload,
    ...(plan.expiresAt ? { expiresAt: plan.expiresAt } : {}),
    dryRun,
    // Derived from the event id, so a redelivered interaction reuses it and the
    // executor discards the second attempt (I4). Suffixed with the kind because
    // the outcome reply below is a second action from the same interaction.
    idempotencyKey: `${ctx.idempotencyKey}:${plan.kind}`,
  };

  const result = await ctx.executor.execute(request);

  if (result.status === 'failed_precheck' || result.status === 'failed_api') {
    ctx.logger.warn(`${plan.kind} refused: ${result.failure?.humanReason ?? 'unknown reason'}`, {
      guildId: ctx.guildId,
      moduleId: MODULE_ID,
      kind: plan.kind,
      code: result.failure?.code,
    });
  }

  if (result.status === 'executed' && plan.onRecorded) {
    try {
      await plan.onRecorded();
    } catch (error) {
      // The action already happened. Failing the command now would tell the
      // moderator their warn did not land when it did; the missed event is the
      // smaller loss, and it is the one worth a log line naming it.
      ctx.logger.error(
        `${plan.kind} was recorded, but the follow-up event could not be published, so any ` +
          `rule triggered on it will not fire for this action: ${
            error instanceof Error ? error.message : String(error)
          }`,
        { guildId: ctx.guildId, moduleId: MODULE_ID, kind: plan.kind },
      );
    }
  }

  await reply(ctx, describe(plan, result));
}

/** The sentence the moderator gets back. */
function describe(plan: ActionPlan, result: ActionResult): string {
  switch (result.status) {
    case 'executed':
      // An `executed` result can still carry a failure — a temp action whose
      // reversal could not be scheduled. Appending it is what stops a "temp" ban
      // from quietly becoming permanent with nobody told.
      return result.failure ? `${plan.success}\n\n${result.failure.humanReason}` : plan.success;

    case 'dry_run':
      return (
        `Dry run — Discord was not called, and nothing changed. ${plan.success}\n\n` +
        `Proton refuses destructive actions outside production (NODE_ENV is ` +
        `'${process.env.NODE_ENV ?? 'unset'}', not 'production'). The case was still recorded.`
      );

    case 'skipped_duplicate':
      return 'I had already handled this command, so I did nothing a second time.';

    case 'failed_precheck':
    case 'failed_api':
      return result.failure?.humanReason ?? 'The action failed, but no reason was reported.';
  }
}

/**
 * Acknowledge the interaction.
 *
 * Never dry-run: I12 withholds the destructive effect, not the explanation of
 * why it was withheld.
 */
async function reply(ctx: CommandContext<ModerationConfig>, content: string): Promise<void> {
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
      // Discord rejects a message body over 2000 characters outright, which
      // would turn a long failure explanation into no reply at all.
      content: content.slice(0, 2000),
      ephemeral: !ctx.config.publicReplies,
    },
  });

  if (result.status === 'failed_precheck' || result.status === 'failed_api') {
    // Nothing left to reply *with* — the log is the only channel remaining.
    ctx.logger.warn(
      `moderation could not answer the invoker: ${result.failure?.humanReason ?? 'unknown reason'}`,
      { guildId: ctx.guildId, moduleId: MODULE_ID, code: result.failure?.code },
    );
  }
}
