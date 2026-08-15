import {
  type ActionResult,
  dryRunFor,
  INTERACTION_CALLBACK_CHANNEL_MESSAGE,
  INTERACTION_CALLBACK_DEFERRED_MESSAGE,
  type ModuleContext,
} from '@proton/core';
import type { RolemenuConfig } from './config.ts';

export const MODULE_ID = 'rolemenu';

/** `actionRequestSchema` caps `reason` here; Discord caps its audit header at the same. */
export const REASON_MAX = 512;
export const MESSAGE_MAX = 2000;

/**
 * Did this action end in the state the caller wanted?
 *
 * `skipped_duplicate` counts. It means this exact role move was already claimed —
 * the gateway redelivering an event, which I4 says will happen — so the role is
 * where it should be, and reporting it as a failure would tell a member their
 * choice failed at the exact moment it took effect.
 */
export function succeeded(result: ActionResult): boolean {
  return (
    result.status === 'executed' ||
    result.status === 'dry_run' ||
    result.status === 'skipped_duplicate'
  );
}

export interface RoleChangeReport {
  /** Role ids that reached the desired state, including deduped redeliveries. */
  added: string[];
  removed: string[];
  /** Everything that did not happen, in the executor's own words (I8). */
  failures: string[];
}

export interface RunRoleChangesInput {
  /** The member the roles move on — also the actor, because they chose this themselves. */
  userId: string;
  menuId: string;
  add: readonly string[];
  remove: readonly string[];
  /**
   * Root of every idempotency key in this run — the originating event id, so a
   * redelivery reuses the same keys and the executor discards the second attempt
   * (I4). Reaction events in particular have no id of their own beyond
   * `(channel, message, user, emoji)`, so redelivery here is routine.
   */
  idempotencyRoot: string;
}

/**
 * Move roles through the executor (I1).
 *
 * Removals run before grants, for the same reason a quarantine strips before it
 * marks: in `unique` mode the removals are the old answer and the grant is the
 * new one, and a member interrupted halfway through should be left holding
 * nothing rather than two contradictory roles.
 *
 * Never aborts on the first failure. A member who asked for one thing and was
 * refused for a different reason on each role needs to hear all of them — one
 * refusal reported while the rest are hidden is how somebody ends up fixing the
 * first problem and pressing the button again to the same silence.
 *
 * The member is the `actorId`. Unlike the verification gate, which acts on its
 * own initiative and attributes to `proton:verification`, a role menu is
 * self-service: the case ledger should read as this member having given
 * themselves this role, because that is exactly what happened.
 */
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
      // Verbatim. `humanReason` already names the missing permission and where
      // (I8); rewriting it here would lose the one detail that makes it fixable.
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

/**
 * Acknowledge a component interaction inside Discord's three seconds (I9).
 *
 * A deferred *message* (callback type 5) rather than a deferred update (6),
 * because what follows is a private answer to the member and not an edit of the
 * menu message everybody can see. Ephemeral, because "you now have the blue
 * role" is nobody else's business and a public one turns a colour picker into a
 * channel full of bot posts.
 *
 * A deferral carries no body — that is what makes it the fast half of the pair.
 */
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

/**
 * Answer immediately, for the cases where there is nothing to go and do.
 *
 * Cheaper than deferring and following up, and — more to the point — it is the
 * only answer available when the follow-up port is unbound, which is precisely
 * the case that must not end in silence.
 */
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
    // Never dry-run: I12 withholds a destructive effect, not the explanation of one.
    dryRun: false,
    // One acknowledgement per interaction. A second POST to the callback endpoint
    // is a 404, so the dedupe claim is what makes a redelivered interaction
    // harmless rather than noisy.
    idempotencyKey: `${MODULE_ID}:${idempotencyRoot}:ack`,
    payload: {
      interactionId: interaction.id,
      interactionToken: interaction.token,
      ephemeral: true,
      ...data,
    },
  });

  if (!succeeded(result)) {
    // Nothing left to answer *with* — the log is the only channel remaining.
    ctx.logger.warn(
      `rolemenu could not acknowledge an interaction: ${result.failure?.humanReason ?? 'unknown reason'}`,
      { guildId: ctx.guildId, moduleId: MODULE_ID, code: result.failure?.code },
    );
  }

  return result;
}

/**
 * Tell the member what happened, after the acknowledgement.
 *
 * The token lasts fifteen minutes from the deferral, so this is under no time
 * pressure — the three-second rule was spent on `deferEphemeral`. It hits
 * `/webhooks/{applicationId}/{token}`, which is why this is the one path that
 * needs the application id.
 */
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
      // Discord rejects a body over 2000 characters outright, which would turn a
      // long list of refusals into no answer at all.
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

/**
 * Turn a report into the sentence the member reads.
 *
 * Every refusal is carried through verbatim, because the executor's
 * `humanReason` is the only thing in the chain that names the missing permission
 * and where it is missing (§1, I8). "Something went wrong" here would throw away
 * the one piece of information that lets an admin fix it.
 */
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
