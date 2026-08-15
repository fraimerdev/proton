import type { CommandContext, ModuleContext, ProtonEvent } from '@proton/core';
import type { VerificationConfig } from './config.ts';
import { bindGateDeps, describeUnbound, type VerificationDeps } from './deps.ts';
import { MODULE_ID, reply, runSteps, VERIFICATION_ACTOR } from './perform.ts';
import { checkGrantable, type RoleStep } from './roles.ts';

/** What one join told us. */
export interface JoinFacts {
  userId: string;
  /** The roles the member arrived holding — the §10.5 signal. */
  roleIds: string[];
  isBot: boolean;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

/**
 * Read a `member.joined` event.
 *
 * The one place in this module that knows Discord's GUILD_MEMBER_ADD shape.
 * PLAN.md P1 keeps dispatch shapes inside the gateway normaliser, but a listener
 * is handed the raw payload, so the knowledge is confined to this function
 * rather than spread across the handler — the same containment the logging
 * module uses.
 *
 * `roles` is the whole point. Discord includes the roles a role-granting invite
 * applied, in the very dispatch that announces the join, so "did the invite
 * already gate them?" costs no REST call and cannot read a stale cache.
 */
export function readJoin(event: ProtonEvent): JoinFacts | null {
  const d = record(event.payload);
  const user = record(d?.user);
  if (!d || !user) return null;

  const userId = typeof user.id === 'string' ? user.id : null;
  if (!userId) return null;

  return {
    userId,
    roleIds: Array.isArray(d.roles)
      ? d.roles.filter((r): r is string => typeof r === 'string')
      : [],
    isBot: user.bot === true,
  };
}

export type JoinGateOutcome =
  | { action: 'ignored'; reason: string }
  /** §10.5 in action: Discord applied the role at join time, so Proton did not. */
  | { action: 'invite_granted'; roleId: string }
  | { action: 'applied'; roleId: string }
  | { action: 'refused'; reason: string }
  /** The member is in the server and past the gate, because nothing gated them. */
  | { action: 'ungated'; reason: string };

/**
 * Gate a joining member.
 *
 * PLAN.md §10.5 says use, don't rebuild: an invite carrying `role_ids` (Jan
 * 2026) applies the restricted role at the instant of joining, with no bot round
 * trip for a fast script to race. So the first thing this does is check whether
 * that already happened, and if it did, it does nothing at all. Applying the role
 * a second time would be a redundant REST call, and — worse — treating "Proton
 * applied it" as the only valid path would make a correctly configured server
 * look like a broken one.
 *
 * The fallback exists because not every join comes through an invite Proton can
 * see: vanity URLs, server discovery and widgets all produce joins that carry no
 * granted role.
 */
export async function handleJoin(
  event: ProtonEvent,
  ctx: ModuleContext<VerificationConfig>,
  rawDeps: VerificationDeps,
): Promise<JoinGateOutcome> {
  if (!ctx.config.enabled) {
    return { action: 'ignored', reason: 'verification is off in this server' };
  }

  const roleId = ctx.config.unverifiedRoleId;
  if (!roleId) {
    // Not an error: a guild may enable this module only for `/quarantine`.
    return { action: 'ignored', reason: 'no unverified role is configured' };
  }

  const join = readJoin(event);
  if (!join) {
    ctx.logger.error(
      'verification received a member.joined it could not read, so that member was not gated. ' +
        'This is a gateway/normaliser mismatch, not a configuration problem.',
      { guildId: ctx.guildId, moduleId: MODULE_ID, eventId: event.id },
    );
    return { action: 'ignored', reason: 'unreadable join payload' };
  }

  // A bot is added by someone holding MANAGE_GUILD, and gating it would strip
  // the access it was invited for. Whether a hostile bot belongs in the server
  // is anti-nuke's question, not the front door's.
  if (join.isBot) return { action: 'ignored', reason: 'the member is a bot' };

  // §10.5: Discord already did it, at join time, with nothing to race.
  if (join.roleIds.includes(roleId)) {
    ctx.logger.info(
      `${join.userId} arrived already holding the unverified role — the invite granted it, so ` +
        'Proton applied nothing.',
      { guildId: ctx.guildId, moduleId: MODULE_ID, userId: join.userId },
    );
    return { action: 'invite_granted', roleId };
  }

  if (!ctx.config.applyUnverifiedOnJoin) {
    const reason =
      `${join.userId} joined without the unverified role and this server has "Apply the ` +
      'unverified role on join" switched off, so they are NOT gated. The invite they used ' +
      'does not grant the role — add it under Server Settings → Invites, or turn the setting ' +
      'back on.';
    ctx.logger.warn(reason, { guildId: ctx.guildId, moduleId: MODULE_ID, userId: join.userId });
    return { action: 'ungated', reason };
  }

  const bound = bindGateDeps(rawDeps);
  if ('unbound' in bound) {
    const reason = describeUnbound(`${join.userId} joined and was NOT gated`, bound.unbound);
    ctx.logger.error(reason, { guildId: ctx.guildId, moduleId: MODULE_ID });
    return { action: 'ungated', reason };
  }

  const state = await bound.deps.guildState.get(ctx.guildId);
  const grantable = checkGrantable(state, roleId, 'unverified');
  if (!grantable.ok) {
    // Loud, and it names the role and the fix. Every member joining this server
    // is walking straight past the gate until somebody acts on this line.
    ctx.logger.error(
      `${join.userId} was NOT gated: ${grantable.reason} Until this is fixed, everyone who ` +
        'joins this server has full access.',
      { guildId: ctx.guildId, moduleId: MODULE_ID, userId: join.userId },
    );
    return { action: 'refused', reason: grantable.reason };
  }

  const report = await runSteps(ctx, {
    targetId: join.userId,
    actorId: VERIFICATION_ACTOR,
    reason: 'Verification gate: applying the unverified role on join.',
    steps: [{ kind: 'add_role', roleId, what: 'applying the unverified role' }],
    // The event id, derived deterministically from the dispatch, so a RESUME
    // redelivery reuses the key and the executor discards it (I4).
    idempotencyRoot: event.id,
  });

  if (report.failures.length > 0) {
    const reason = report.failures.join(' | ');
    ctx.logger.error(`${join.userId} was NOT gated: ${reason}`, {
      guildId: ctx.guildId,
      moduleId: MODULE_ID,
      userId: join.userId,
    });
    return { action: 'refused', reason };
  }

  return { action: 'applied', roleId };
}

/**
 * The steps that take a member through the gate, or the sentence explaining why
 * there are none.
 *
 * Split out from the handler so the ordering argument below is testable without
 * an interaction: the grant is attempted first, and the unverified role only
 * comes off once it has actually landed.
 */
export function planVerification(
  config: VerificationConfig,
  state: Parameters<typeof checkGrantable>[0],
): { grant: RoleStep[]; clear: RoleStep[] } | { refusal: string } {
  const { verifiedRoleId, unverifiedRoleId } = config;

  if (!verifiedRoleId && !unverifiedRoleId) {
    return {
      refusal:
        "This server hasn't finished setting up verification: neither a member role nor an " +
        'unverified role is chosen, so passing the gate would change nothing. An admin can ' +
        'set them in the Proton dashboard under Verification.',
    };
  }

  for (const [roleId, label] of [
    [verifiedRoleId, 'member'],
    [unverifiedRoleId, 'unverified'],
  ] as const) {
    if (!roleId) continue;
    const check = checkGrantable(state, roleId, label);
    if (!check.ok) return { refusal: check.reason };
  }

  return {
    grant: verifiedRoleId
      ? [{ kind: 'add_role', roleId: verifiedRoleId, what: 'granting the member role' }]
      : [],
    clear: unverifiedRoleId
      ? [{ kind: 'remove_role', roleId: unverifiedRoleId, what: 'removing the unverified role' }]
      : [],
  };
}

/**
 * `/verify` — the member passes the gate.
 *
 * The grant runs before the clear, and the clear only runs if the grant landed.
 * The reverse order fails badly: a removed unverified role plus a member role
 * that never arrived leaves somebody who has done everything asked of them
 * looking at an empty server, with the bot reporting success. This way a failed
 * grant leaves them exactly where they were, holding a refusal that names the
 * role and the fix.
 *
 * Nothing is looked up first. `PUT`/`DELETE` on a member role are idempotent at
 * Discord, so checking whether they already hold either role would buy a race
 * and a REST call for nothing.
 */
export async function runVerify(
  ctx: CommandContext<VerificationConfig>,
  rawDeps: VerificationDeps,
): Promise<void> {
  if (!ctx.config.enabled) {
    await reply(
      ctx,
      'Verification is switched off in this server, so there is nothing to pass. An admin can ' +
        'turn it on from the Proton dashboard.',
    );
    return;
  }

  const bound = bindGateDeps(rawDeps);
  if ('unbound' in bound) {
    const detail = describeUnbound('I could not verify you', bound.unbound);
    ctx.logger.error(detail, { guildId: ctx.guildId, moduleId: MODULE_ID });
    await reply(
      ctx,
      "I couldn't verify you because Proton isn't fully wired up in this deployment. A server " +
        'admin should check the Proton logs — the exact missing piece is named there.',
    );
    return;
  }

  const state = await bound.deps.guildState.get(ctx.guildId);
  const plan = planVerification(ctx.config, state);

  if ('refusal' in plan) {
    ctx.logger.warn(`/verify refused: ${plan.refusal}`, {
      guildId: ctx.guildId,
      moduleId: MODULE_ID,
      userId: ctx.userId,
    });
    await reply(ctx, plan.refusal);
    return;
  }

  await performVerification(ctx, plan, ctx.userId, ctx.idempotencyKey);
}

/** Shared by `/verify` so the ordering rule lives in exactly one place. */
async function performVerification(
  ctx: CommandContext<VerificationConfig>,
  plan: { grant: RoleStep[]; clear: RoleStep[] },
  userId: string,
  idempotencyRoot: string,
): Promise<void> {
  const reason = 'Verification gate: passed.';

  const granted = await runSteps(ctx, {
    targetId: userId,
    actorId: VERIFICATION_ACTOR,
    reason,
    steps: plan.grant,
    idempotencyRoot,
  });

  if (granted.failures.length > 0) {
    const detail = granted.failures.join(' | ');
    ctx.logger.warn(`/verify could not grant: ${detail}`, {
      guildId: ctx.guildId,
      moduleId: MODULE_ID,
      userId,
    });
    await reply(
      ctx,
      `I couldn't finish verifying you, so nothing has changed — you still have the same ` +
        `roles you had. ${detail}`,
    );
    return;
  }

  const cleared = await runSteps(ctx, {
    targetId: userId,
    actorId: VERIFICATION_ACTOR,
    reason,
    steps: plan.clear,
    idempotencyRoot,
  });

  if (cleared.failures.length > 0) {
    // The grant landed, so they are through the gate. Say both halves: they have
    // access, and something still needs an admin.
    await reply(
      ctx,
      "You're verified and your access should be live. One thing did not finish — " +
        `${cleared.failures.join(' | ')} — so tell a moderator; it does not affect your access.`,
    );
    return;
  }

  await reply(ctx, "You're verified. Welcome in.");
}
