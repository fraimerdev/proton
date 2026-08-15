import {
  type ActionResult,
  type CommandContext,
  dryRunFor,
  type ModuleContext,
} from '@proton/core';
import type { VerificationConfig } from './config.ts';
import type { RoleStep } from './roles.ts';

export const MODULE_ID = 'verification';

/**
 * `ActionRequest.actorId` for anything the join gate did on its own.
 *
 * Not a snowflake, on the same reasoning as `RULE_ENGINE_ACTOR`: nobody pressed
 * a button. Attributing an automatic role application to the member who joined
 * would read in the case ledger as them having granted it to themselves.
 */
export const VERIFICATION_ACTOR = 'proton:verification';

export const REASON_MAX = 512;
export const MESSAGE_MAX = 2000;

export interface StepReport {
  /** Role ids that reached the desired state, including deduped redeliveries. */
  applied: string[];
  /** Everything that did not happen, in the executor's own words (I8). */
  failures: string[];
}

export interface RunStepsInput {
  /** The member the roles move on. */
  targetId: string;
  actorId: string;
  reason?: string | undefined;
  steps: readonly RoleStep[];
  /**
   * Root of every idempotency key in this run — the originating event or
   * interaction id, so a redelivery reuses the same keys and the executor
   * discards the second attempt (I4).
   */
  idempotencyRoot: string;
  /**
   * Extra fields merged into every payload.
   *
   * `roleChangePayloadSchema` ignores them and the REST mapping builds its path
   * from `userId` and `roleId` alone, so nothing here reaches Discord. It exists
   * because the case ledger records `request.payload` verbatim: putting the full
   * prior-role set on each removal means one case is enough for a human to put a
   * member back by hand, the same discipline that has lockdown record
   * `previousAllow`/`previousDeny` rather than guess on unlock.
   */
  payloadExtra?: Record<string, unknown>;
}

/**
 * Run an ordered role swap through the executor (I1).
 *
 * Never aborts on the first failure. A swap that stopped halfway would leave the
 * member in a state nobody planned — some roles gone, no marker applied — and
 * would report one problem while hiding the rest. Every step is attempted and
 * every refusal is collected verbatim, because the caller's job is to tell a
 * moderator exactly which roles moved and which did not.
 */
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
      dryRun: dryRunFor(step.kind),
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

/**
 * Did this step end in the state the plan wanted?
 *
 * `skipped_duplicate` counts. It means this exact role move was already claimed
 * — the gateway redelivering an event, which I4 says will happen — so the role is
 * where it should be and reporting it as a failure would have `/unquarantine` refuse
 * to clear a record it has fully honoured.
 */
export function succeeded(result: ActionResult): boolean {
  return (
    result.status === 'executed' ||
    result.status === 'dry_run' ||
    result.status === 'skipped_duplicate'
  );
}

/**
 * Answer the invoker, whatever happened.
 *
 * Always ephemeral. Verification and quarantine are about one member, and
 * announcing either in the channel is noise at best and an invitation to argue
 * with the bot at worst. Never dry-run: I12 withholds a destructive effect, not
 * the explanation of one.
 */
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
      // Discord rejects a body over 2000 characters outright, which would turn a
      // long "here is what did not restore" into no reply at all.
      content: content.slice(0, MESSAGE_MAX),
      ephemeral: true,
    },
  });

  if (result.status === 'failed_precheck' || result.status === 'failed_api') {
    // Nothing left to reply *with* — the log is the only channel remaining.
    ctx.logger.warn(
      `verification could not answer the invoker: ${result.failure?.humanReason ?? 'unknown reason'}`,
      { guildId: ctx.guildId, moduleId: MODULE_ID, code: result.failure?.code },
    );
  }
}
