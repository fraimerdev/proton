import type { CommandContext, ModuleContext, ProtonEvent } from '@proton/core';
import type { VerificationConfig } from './config.ts';
import { bindGateDeps, describeUnbound, type VerificationDeps } from './deps.ts';
import { MODULE_ID, reply, runSteps, VERIFICATION_ACTOR } from './perform.ts';
import { checkGrantable, type RoleStep } from './roles.ts';

export interface JoinFacts {
  userId: string;

  roleIds: string[];
  isBot: boolean;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

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
  | { action: 'invite_granted'; roleId: string }
  | { action: 'applied'; roleId: string }
  | { action: 'refused'; reason: string }
  | { action: 'ungated'; reason: string };

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

  if (join.isBot) return { action: 'ignored', reason: 'the member is a bot' };

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
      'I can’t verify you right now. Nothing was changed. This is a fault on my side, not ' +
        'anything you did.',
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

  await reply(
    ctx,
    (await runVerification(ctx, plan, ctx.userId, ctx.idempotencyKey, rawDeps)).message,
  );
}

export interface VerifyResult {
  verified: boolean;
  message: string;
  blocked?: boolean;
}

const BLOCKED_MESSAGE =
  'You are on this server’s blocked list, so I can’t verify you. Nothing has changed. A ' +
  'moderator can lift it from the Proton dashboard.';

// Fail-open, and loudly. Refusing everybody when the port is unwired would turn one wiring
// mistake into a total gate outage, and the list is a second line behind a ban that already ran.
async function blockedFor(
  ctx: ModuleContext<VerificationConfig>,
  deps: VerificationDeps,
  userId: string,
): Promise<boolean> {
  if (!deps.blocked) {
    ctx.logger.error(describeUnbound('the blocked list was not consulted', ['blocked']), {
      guildId: ctx.guildId,
      moduleId: MODULE_ID,
      userId,
    });
    return false;
  }

  const block = await deps.blocked.find(ctx.guildId, userId);
  if (!block) return false;

  ctx.logger.warn(
    `verification refused ${userId}: they are on this server’s blocked list, added by ` +
      `${block.moduleId} — ${block.reason}`,
    { guildId: ctx.guildId, moduleId: MODULE_ID, userId },
  );

  return true;
}

export async function runVerification(
  ctx: ModuleContext<VerificationConfig>,
  plan: { grant: RoleStep[]; clear: RoleStep[] },
  userId: string,
  idempotencyRoot: string,
  deps: VerificationDeps,
): Promise<VerifyResult> {
  // Before the first grant, so a blocked member is never briefly ungated.
  if (await blockedFor(ctx, deps, userId)) {
    return { verified: false, blocked: true, message: BLOCKED_MESSAGE };
  }

  const reason = 'Verification gate: passed.';

  // Granting before clearing means a refused grant leaves the member exactly where they were,
  // rather than ungated with nothing to show for it.
  const granted = await runSteps(ctx, {
    targetId: userId,
    actorId: VERIFICATION_ACTOR,
    reason,
    steps: plan.grant,
    idempotencyRoot,
  });

  if (granted.failures.length > 0) {
    const detail = granted.failures.join(' | ');
    ctx.logger.warn(`verification could not grant: ${detail}`, {
      guildId: ctx.guildId,
      moduleId: MODULE_ID,
      userId,
    });

    return {
      verified: false,
      message:
        `I couldn't finish verifying you, so nothing has changed — you still have the same ` +
        `roles you had. ${detail}`,
    };
  }

  const cleared = await runSteps(ctx, {
    targetId: userId,
    actorId: VERIFICATION_ACTOR,
    reason,
    steps: plan.clear,
    idempotencyRoot,
  });

  if (cleared.failures.length > 0) {
    return {
      verified: true,
      message:
        "You're verified. One thing did not finish — " +
        `${cleared.failures.join(' | ')} — so if you still can't see the server, tell a moderator.`,
    };
  }

  return { verified: true, message: "You're verified. Welcome in." };
}
