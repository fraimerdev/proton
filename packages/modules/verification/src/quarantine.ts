import type { CommandContext, GuildState } from '@proton/core';
import type { VerificationConfig } from './config.ts';
import {
  type BoundQuarantineDeps,
  bindQuarantineDeps,
  describeUnbound,
  type VerificationDeps,
} from './deps.ts';
import { MODULE_ID, REASON_MAX, reply, runSteps } from './perform.ts';
import { checkGrantable, planQuarantine, planRelease } from './roles.ts';
import type { QuarantineRecord } from './store.ts';

interface Ready {
  deps: BoundQuarantineDeps;
  quarantineRoleId: string;
  state: GuildState;
}

async function prepare(
  ctx: CommandContext<VerificationConfig>,
  rawDeps: VerificationDeps,
  verb: string,
): Promise<Ready | null> {
  if (!ctx.config.enabled) {
    await reply(
      ctx,
      'Verification is switched off in this server, so quarantine is unavailable. An admin can ' +
        'turn it on from the Proton dashboard.',
    );
    return null;
  }

  const quarantineRoleId = ctx.config.quarantineRoleId;
  if (!quarantineRoleId) {
    await reply(
      ctx,
      'No quarantine role is set for this server, so there is nothing to swap in. An admin can ' +
        'choose one in the Proton dashboard under Verification → Quarantine role.',
    );
    return null;
  }

  const bound = bindQuarantineDeps(rawDeps);
  if ('unbound' in bound) {
    const detail = describeUnbound(`I could not ${verb} that member`, bound.unbound);
    ctx.logger.error(detail, { guildId: ctx.guildId, moduleId: MODULE_ID });
    await reply(
      ctx,
      `I couldn't ${verb} that member because Proton isn't fully wired up in this deployment. ` +
        'Nothing was changed. The Proton logs name the exact missing piece.',
    );
    return null;
  }

  const state = await bound.deps.guildState.get(ctx.guildId);
  if (!state) {
    await reply(
      ctx,
      "I don't have this server's role list yet, so I can't work out which roles to move. " +
        'Nothing was changed — try again shortly.',
    );
    return null;
  }

  const grantable = checkGrantable(state, quarantineRoleId, 'quarantine');
  if (!grantable.ok) {
    ctx.logger.warn(`/quarantine (${verb}) refused: ${grantable.reason}`, {
      guildId: ctx.guildId,
      moduleId: MODULE_ID,
    });
    await reply(ctx, `${grantable.reason} Nothing was changed.`);
    return null;
  }

  return { deps: bound.deps, quarantineRoleId, state };
}

export async function runQuarantine(
  ctx: CommandContext<VerificationConfig>,
  rawDeps: VerificationDeps,
  input: { targetId: string; reason?: string | undefined },
): Promise<void> {
  const ready = await prepare(ctx, rawDeps, 'quarantine');
  if (!ready) return;

  const { deps, quarantineRoleId, state } = ready;

  const existing = await deps.quarantine.get(ctx.guildId, input.targetId);
  if (existing) {
    await reply(
      ctx,
      `<@${input.targetId}> is already quarantined — <@${existing.quarantinedBy}> did it on ` +
        `${new Date(existing.quarantinedAt).toISOString()}, and Proton is holding ` +
        `${existing.priorRoleIds.length} role${existing.priorRoleIds.length === 1 ? '' : 's'} ` +
        'to give back. Run /unquarantine to restore them.',
    );
    return;
  }

  const memberRoleIds = await deps.fetchMemberRoles(ctx.guildId, input.targetId);
  if (memberRoleIds === null) {
    await reply(
      ctx,
      `I couldn't read <@${input.targetId}>'s roles, so I have done nothing. Quarantining ` +
        'without knowing what to give back is not something I will do. They may have just ' +
        'left the server — check and try again.',
    );
    return;
  }

  const plan = planQuarantine({ state, memberRoleIds, quarantineRoleId });

  const record: QuarantineRecord = {
    guildId: ctx.guildId,
    userId: input.targetId,
    priorRoleIds: plan.priorRoleIds,
    quarantinedBy: ctx.userId,
    reason: input.reason?.slice(0, REASON_MAX) ?? null,
    quarantinedAt: deps.now(),
  };

  await deps.quarantine.put(record);

  const report = await runSteps(ctx, {
    targetId: input.targetId,
    actorId: ctx.userId,
    reason: input.reason ?? 'Quarantined.',
    steps: plan.steps,
    idempotencyRoot: ctx.idempotencyKey,

    payloadExtra: { priorRoleIds: plan.priorRoleIds },
  });

  ctx.logger.info(`quarantined ${input.targetId}`, {
    guildId: ctx.guildId,
    moduleId: MODULE_ID,
    userId: input.targetId,
    priorRoleIds: plan.priorRoleIds,
    failures: report.failures.length,
  });

  const held =
    plan.priorRoleIds.length === 0
      ? 'They held no roles beyond @everyone, so there was nothing to take away — /unquarantine ' +
        'will simply lift the quarantine role.'
      : `Proton is holding ${plan.priorRoleIds.length} role` +
        `${plan.priorRoleIds.length === 1 ? '' : 's'} to give back: ` +
        `${plan.priorRoleIds.map((id) => `<@&${id}>`).join(', ')}. Run /unquarantine to restore them ` +
        'exactly.';

  await reply(
    ctx,
    report.failures.length === 0
      ? `Quarantined <@${input.targetId}>. ${held}`
      : `Quarantined <@${input.targetId}>, but not cleanly. ${held}\n\nWhat did NOT work — ` +
          `${report.failures.join(' | ')}\n\nThe record is saved either way, so /unquarantine still ` +
          'knows what they had.',
  );
}

export async function runRelease(
  ctx: CommandContext<VerificationConfig>,
  rawDeps: VerificationDeps,
  input: { targetId: string; reason?: string | undefined },
): Promise<void> {
  const ready = await prepare(ctx, rawDeps, 'release');
  if (!ready) return;

  const { deps, quarantineRoleId, state } = ready;

  const record = await deps.quarantine.get(ctx.guildId, input.targetId);
  if (!record) {
    await reply(
      ctx,
      `Proton has no quarantine record for <@${input.targetId}>, so it does not know what they ` +
        'had before. If they are still holding the quarantine role, take it off by hand and ' +
        'restore their roles from the Discord audit log — guessing here would be Proton ' +
        'rewriting their access.',
    );
    return;
  }

  const plan = planRelease({ state, record, quarantineRoleId });

  const report = await runSteps(ctx, {
    targetId: input.targetId,
    actorId: ctx.userId,
    reason: input.reason ?? 'Released from quarantine.',
    steps: plan.steps,
    idempotencyRoot: ctx.idempotencyKey,
    payloadExtra: { restoredRoleIds: record.priorRoleIds },
  });

  const unrestorable = [...plan.vanishedRoleIds, ...plan.ungrantableRoleIds];
  const clean = report.failures.length === 0 && unrestorable.length === 0;

  if (clean) await deps.quarantine.clear(ctx.guildId, input.targetId);

  ctx.logger.info(`released ${input.targetId}`, {
    guildId: ctx.guildId,
    moduleId: MODULE_ID,
    userId: input.targetId,
    restored: report.applied.length,
    recorded: record.priorRoleIds.length,
    failures: report.failures.length,
  });

  await reply(ctx, describeRelease(input.targetId, record, plan, report.failures, clean));
}

function describeRelease(
  targetId: string,
  record: QuarantineRecord,
  plan: ReturnType<typeof planRelease>,
  failures: readonly string[],
  clean: boolean,
): string {
  const lines: string[] = [];

  lines.push(
    record.priorRoleIds.length === 0
      ? `Released <@${targetId}>. They had no roles when they were quarantined, so the ` +
          'quarantine role is all that came off — they are exactly as they were.'
      : `Released <@${targetId}> and restored ${record.priorRoleIds.length} role` +
          `${record.priorRoleIds.length === 1 ? '' : 's'}: ` +
          `${record.priorRoleIds.map((id) => `<@&${id}>`).join(', ')}.`,
  );

  if (plan.vanishedRoleIds.length > 0) {
    lines.push(
      `${plan.vanishedRoleIds.length} recorded role${plan.vanishedRoleIds.length === 1 ? '' : 's'} ` +
        `no longer exist in this server and could not be given back: ` +
        `${plan.vanishedRoleIds.join(', ')}. They were deleted while the member was quarantined.`,
    );
  }

  if (plan.ungrantableRoleIds.length > 0) {
    lines.push(
      `${plan.ungrantableRoleIds.length} recorded role` +
        `${plan.ungrantableRoleIds.length === 1 ? '' : 's'} now sit above Proton's own role, so ` +
        `I am not allowed to grant ${plan.ungrantableRoleIds.length === 1 ? 'it' : 'them'}: ` +
        `${plan.ungrantableRoleIds.map((id) => `<@&${id}>`).join(', ')}. Move Proton's role ` +
        'higher in Server Settings → Roles and run /unquarantine again, or add them by hand.',
    );
  }

  if (failures.length > 0) lines.push(`What did NOT work — ${failures.join(' | ')}`);

  lines.push(
    clean
      ? 'The quarantine record has been cleared.'
      : 'The quarantine record has been KEPT so nothing is lost — fix the above and run ' +
          '/unquarantine again; the roles that already went back will be skipped.',
  );

  return lines.join('\n\n');
}
