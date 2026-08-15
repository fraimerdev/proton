import { type ActionKind, type ActionResult, dryRunFor, type ModuleContext } from '@proton/core';
import { CLASS_LABELS, type NukeClass } from './classes.ts';
import type { AntinukeConfig } from './config.ts';
import type { BoundAntinukeDeps } from './deps.ts';

export const MODULE_ID = 'antinuke';

/**
 * `ActionRequest.actorId` for anything the breaker did.
 *
 * Not a snowflake, on the same reasoning as `RULE_ENGINE_ACTOR`: nobody pressed
 * a button. Attributing an automatic role strip to the member who triggered it,
 * or to whoever last edited the config, would read in the case ledger as a
 * person having done it by hand.
 */
export const ANTINUKE_ACTOR = 'proton:antinuke';

const REASON_MAX = 512;
const MESSAGE_MAX = 2000;

export interface BreakerInput {
  /** Whose burst crossed the threshold. */
  actorId: string;
  nukeClass: NukeClass;
  count: number;
  limit: number;
  /** The window as configured, e.g. `'30s'` — for the sentence a human reads. */
  window: string;
  /** The audit event that crossed the threshold: the idempotency root (I4). */
  eventId: string;
}

export interface BreakerReport {
  /** Roles taken off the actor, highest first. Empty if none could be. */
  strippedRoleIds: string[];
  /**
   * Kinds sent to the executor, in the order they were sent — attempted, not
   * necessarily done. What failed is in `failures`, because "we tried and
   * Discord refused" and "we never tried" are different facts about an attack.
   */
  attempted: ActionKind[];
  /** Everything that did not happen, in the executor's own words (I8). */
  failures: string[];
  /** True when the actor owns the guild, which Proton cannot act on (§15). */
  ownerExempt: boolean;
  /** What was said in the alert channel and in the log. */
  summary: string;
}

function describe(input: BreakerInput): string {
  return `${input.count} ${CLASS_LABELS[input.nukeClass]} within ${input.window} by ${input.actorId}`;
}

/**
 * Trip the circuit breaker (PLAN.md §8: "circuit breaker strips roles first,
 * investigates after").
 *
 * The order is the design. Stripping roles is instant and exactly reversible —
 * the ids come back off the case ledger — so it is what stands between the
 * attacker and the next deletion. Anything irreversible waits until after that,
 * and by default waits for a human. §15 is blunt about why the ambition stops
 * there: audit-log delivery is eventually consistent and unordered, so this is a
 * race that can be lost, and the value is speed plus restore quality rather than
 * perfect prevention.
 */
export async function tripBreaker(
  ctx: ModuleContext<AntinukeConfig>,
  deps: BoundAntinukeDeps,
  input: BreakerInput,
): Promise<BreakerReport> {
  const detected = describe(input);
  const state = await deps.guildState.get(ctx.guildId);

  // §15: you cannot stop the guild owner; don't try. `runPrechecks` would refuse
  // every one of these actions anyway, but it would do so one failed role
  // removal at a time — this says it once, in a sentence that tells the guild
  // what to do about it.
  if (state?.ownerId === input.actorId) {
    const summary =
      `Anti-nuke detected ${detected}, and that member owns this server. Discord does not let ` +
      "any bot remove the owner's roles, ban them or kick them, so Proton has done nothing and " +
      'cannot. Recover the account, then transfer ownership or enable server-wide 2FA.';
    ctx.logger.warn(summary, { guildId: ctx.guildId, moduleId: MODULE_ID, actorId: input.actorId });
    await announce(ctx, input.eventId, summary);
    return {
      strippedRoleIds: [],
      attempted: [],
      failures: [],
      ownerExempt: true,
      summary,
    };
  }

  const reason = `Anti-nuke: ${detected}`.slice(0, REASON_MAX);
  const failures: string[] = [];
  const attempted: ActionKind[] = [];

  const roleIds = await deps.fetchMemberRoles(ctx.guildId, input.actorId);

  if (roleIds === null) {
    // Fail closed, and stop. Unknown roles means the reversible half of the
    // response is unavailable, and performing the irreversible half on its own
    // inverts the whole point of the ordering.
    const summary =
      `Anti-nuke detected ${detected}, but I could not read that member's roles, so I have ` +
      'stripped nothing and taken no further action. They may have already left the server. ' +
      'Check the audit log and act by hand — this one needs a person.';
    ctx.logger.error(summary, {
      guildId: ctx.guildId,
      moduleId: MODULE_ID,
      actorId: input.actorId,
    });
    await announce(ctx, input.eventId, summary);
    return { strippedRoleIds: [], attempted: [], failures: [], ownerExempt: false, summary };
  }

  // @everyone cannot be removed — its id is the guild id, and Discord rejects
  // the call. Highest position first, so if we are rate-limited partway through
  // the roles that carry the dangerous permissions are already gone.
  const strippable = roleIds
    .filter((roleId) => roleId !== ctx.guildId)
    .sort((a, b) => (state?.roles.get(b)?.position ?? 0) - (state?.roles.get(a)?.position ?? 0));

  const stripped: string[] = [];
  for (const roleId of strippable) {
    const result = await ctx.executor.execute({
      guildId: ctx.guildId,
      moduleId: MODULE_ID,
      kind: 'remove_role',
      actorId: ANTINUKE_ACTOR,
      targetId: input.actorId,
      reason,
      /**
       * `strippedRoleIds` is not part of `roleChangePayloadSchema` and never
       * reaches Discord — the REST mapping parses the payload and builds the
       * path from `userId` and `roleId` alone. It is here because the case
       * ledger records `request.payload` verbatim, so one case is enough to
       * restore the member exactly, the same discipline that has lockdown
       * record `previousAllow`/`previousDeny` rather than guess on unlock.
       */
      payload: { userId: input.actorId, roleId, strippedRoleIds: strippable },
      dryRun: dryRunFor('remove_role'),
      // Derived from the audit event, so a RESUME redelivery reuses the key and
      // the executor discards the second attempt (I4).
      idempotencyKey: `${MODULE_ID}:${input.eventId}:strip:${roleId}`,
    });

    attempted.push('remove_role');
    collect(failures, result, `removing role ${roleId}`);
    if (result.status === 'executed' || result.status === 'dry_run') stripped.push(roleId);
  }

  // Only now, with the roles off, does anything irreversible happen — and only
  // if the guild asked for it.
  if (ctx.config.afterStrip !== 'none') {
    const kind: ActionKind = ctx.config.afterStrip;
    const result = await ctx.executor.execute({
      guildId: ctx.guildId,
      moduleId: MODULE_ID,
      kind,
      actorId: ANTINUKE_ACTOR,
      targetId: input.actorId,
      reason,
      payload: { userId: input.actorId },
      dryRun: dryRunFor(kind),
      idempotencyKey: `${MODULE_ID}:${input.eventId}:${kind}`,
    });

    attempted.push(kind);
    collect(failures, result, `${kind === 'ban' ? 'banning' : 'kicking'} that member`);
  }

  const summary = summarise(ctx.config, input, detected, stripped, strippable, failures);

  ctx.logger.warn(summary, {
    guildId: ctx.guildId,
    moduleId: MODULE_ID,
    actorId: input.actorId,
    nukeClass: input.nukeClass,
    stripped: stripped.length,
  });

  await announce(ctx, input.eventId, summary);

  return { strippedRoleIds: stripped, attempted, failures, ownerExempt: false, summary };
}

function collect(failures: string[], result: ActionResult, what: string): void {
  // `skipped_duplicate` is not a failure: it is this event arriving twice, which
  // the gateway guarantees will happen (I4).
  if (result.status === 'skipped_duplicate') return;
  if (result.failure) failures.push(`${what}: ${result.failure.humanReason}`);
}

function summarise(
  config: AntinukeConfig,
  input: BreakerInput,
  detected: string,
  stripped: readonly string[],
  attempted: readonly string[],
  failures: readonly string[],
): string {
  const lines = [`Anti-nuke tripped: ${detected} (limit ${input.limit} per ${input.window}).`];

  if (attempted.length === 0) {
    lines.push('They held no removable roles, so there was nothing to strip.');
  } else {
    lines.push(
      `Removed ${stripped.length} of ${attempted.length} roles from them first: ` +
        `${attempted.join(', ')}. Every removal is recorded as a Proton case carrying the full ` +
        'set, so their roles can be restored exactly.',
    );
  }

  if (config.afterStrip === 'none') {
    lines.push(
      'Nothing else was done — this server has "After stripping roles" set to none. Review the ' +
        'audit log and decide.',
    );
  } else {
    lines.push(`Then: ${config.afterStrip}.`);
  }

  if (failures.length > 0) {
    lines.push(`What did NOT work — ${failures.join(' | ')}`);
  }

  return lines.join('\n').slice(0, MESSAGE_MAX);
}

/**
 * Post the breaker's findings where a human will see them.
 *
 * Never dry-run. I12 withholds destructive effects, not the explanation of what
 * just happened — a server whose channels are being deleted needs the message
 * most in the environment where the response was held back.
 *
 * The precheck for this send is computed at guild level, not for the alert
 * channel: only the worker can bind channel hints to the executor (`scoped`),
 * and a listener has no interaction to take them from. A channel overwrite that
 * denies the bot SEND_MESSAGES therefore surfaces as Discord's 403 rather than
 * as a precheck — reported either way, which is what matters here.
 */
export async function announce(
  ctx: ModuleContext<AntinukeConfig>,
  eventId: string,
  content: string,
  keySuffix = 'alert',
): Promise<ActionResult | null> {
  const channelId = ctx.config.alertChannelId;
  if (!channelId) return null;

  const result = await ctx.executor.execute({
    guildId: ctx.guildId,
    moduleId: MODULE_ID,
    kind: 'send',
    actorId: ANTINUKE_ACTOR,
    payload: { channelId, content: content.slice(0, MESSAGE_MAX) },
    dryRun: false,
    idempotencyKey: `${MODULE_ID}:${eventId}:${keySuffix}`,
  });

  if (result.failure) {
    // The alert channel is the only way this reaches a human, so its failure is
    // itself an admin-facing problem: name the permission and where.
    ctx.logger.error(
      `Anti-nuke could not post to its alert channel ${channelId}: ${result.failure.humanReason}`,
      { guildId: ctx.guildId, moduleId: MODULE_ID, code: result.failure.code },
    );
  }

  return result;
}
