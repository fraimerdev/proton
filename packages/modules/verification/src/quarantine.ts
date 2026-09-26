import {
  type CommandContext,
  errorStatus,
  type GuildState,
  labelOf,
  successStatus,
} from '@proton/core';
import type { VerificationConfig } from './config.ts';
import {
  type BoundQuarantineDeps,
  bindQuarantineDeps,
  describeUnbound,
  type VerificationDeps,
} from './deps.ts';
import { type Answer, MODULE_ID, REASON_MAX, runSteps } from './perform.ts';
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
  answer: Answer,
): Promise<Ready | null> {
  if (!ctx.config.enabled) {
    await answer(
      errorStatus(
        'Verification is off in this server, so quarantine isn’t available. An admin can turn ' +
          'it on in the Proton dashboard.',
      ),
    );
    return null;
  }

  const quarantineRoleId = ctx.config.quarantineRoleId;
  if (!quarantineRoleId) {
    await answer(
      errorStatus(
        'No quarantine role is set. An admin can choose one in the Proton dashboard under ' +
          'Verification → Quarantine role.',
      ),
    );
    return null;
  }

  const bound = bindQuarantineDeps(rawDeps);
  if ('unbound' in bound) {
    const detail = describeUnbound(`I could not ${verb} that member`, bound.unbound);
    ctx.logger.error(detail, { guildId: ctx.guildId, moduleId: MODULE_ID });
    await answer(
      errorStatus(
        `I couldn’t ${verb} that member. Nothing was changed. This is a problem on my end, not ` +
          'a setting in this server.',
      ),
    );
    return null;
  }

  const state = await bound.deps.guildState.get(ctx.guildId);
  if (!state) {
    await answer(
      errorStatus(
        "I haven't loaded this server's roles yet, so nothing was changed. Try again in a " +
          'moment.',
      ),
    );
    return null;
  }

  const grantable = checkGrantable(state, quarantineRoleId, 'quarantine');
  if (!grantable.ok) {
    ctx.logger.warn(`/quarantine (${verb}) refused: ${grantable.reason}`, {
      guildId: ctx.guildId,
      moduleId: MODULE_ID,
    });
    await answer(errorStatus(`${grantable.reason} Nothing was changed.`));
    return null;
  }

  return { deps: bound.deps, quarantineRoleId, state };
}

export async function runQuarantine(
  ctx: CommandContext<VerificationConfig>,
  rawDeps: VerificationDeps,
  input: { targetId: string; reason?: string | undefined },
  answer: Answer,
): Promise<void> {
  const ready = await prepare(ctx, rawDeps, 'quarantine', answer);
  if (!ready) return;

  const { deps, quarantineRoleId, state } = ready;
  const release = labelOf(ctx, 'quarantine', 'remove');

  const existing = await deps.quarantine.get(ctx.guildId, input.targetId);
  if (existing) {
    await answer(
      errorStatus(
        `<@${input.targetId}> is already quarantined. <@${existing.quarantinedBy}> quarantined ` +
          `them <t:${Math.floor(existing.quarantinedAt / 1000)}:R>, and I'm keeping ` +
          `${existing.priorRoleIds.length} role${existing.priorRoleIds.length === 1 ? '' : 's'} ` +
          `to give back. Run ${release} to restore them.`,
      ),
    );
    return;
  }

  const memberRoleIds = await deps.fetchMemberRoles(ctx.guildId, input.targetId);
  if (memberRoleIds === null) {
    await answer(
      errorStatus(
        `I couldn't read <@${input.targetId}>'s roles, so I didn't quarantine them. I won't ` +
          'quarantine a member without knowing which roles to give back. They may have left ' +
          'the server.',
      ),
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
      ? `They had no other roles, so ${release} will only remove the quarantine role.`
      : `I'm keeping ${plan.priorRoleIds.length} role` +
        `${plan.priorRoleIds.length === 1 ? '' : 's'} to give back: ` +
        `${plan.priorRoleIds.map((id) => `<@&${id}>`).join(', ')}. Run ${release} to restore them.`;

  await answer(
    report.failures.length === 0
      ? successStatus(`Quarantined <@${input.targetId}>. ${held}`)
      : errorStatus(
          `Quarantined <@${input.targetId}>, but some steps failed. ${held}\n\nWhat failed: ` +
            `${report.failures.join(' | ')}\n\nThe record is saved, so ${release} still knows ` +
            'which roles to give back.',
        ),
  );
}

export async function runRelease(
  ctx: CommandContext<VerificationConfig>,
  rawDeps: VerificationDeps,
  input: { targetId: string; reason?: string | undefined },
  answer: Answer,
): Promise<void> {
  const ready = await prepare(ctx, rawDeps, 'release', answer);
  if (!ready) return;

  const { deps, quarantineRoleId, state } = ready;

  const record = await deps.quarantine.get(ctx.guildId, input.targetId);
  if (!record) {
    await answer(
      errorStatus(
        `I have no quarantine record for <@${input.targetId}>, so I don't know which roles they ` +
          'had. If they still have the quarantine role, remove it by hand and restore their roles ' +
          'using the audit log.',
      ),
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

  const told = describeRelease(
    input.targetId,
    record,
    plan,
    report.failures,
    clean,
    labelOf(ctx, 'quarantine', 'remove'),
  );
  await answer(clean ? successStatus(told) : errorStatus(told));
}

function describeRelease(
  targetId: string,
  record: QuarantineRecord,
  plan: ReturnType<typeof planRelease>,
  failures: readonly string[],
  clean: boolean,
  release: string,
): string {
  const lines: string[] = [];
  const roles = record.priorRoleIds.map((id) => `<@&${id}>`).join(', ');
  const count = `${record.priorRoleIds.length} role${record.priorRoleIds.length === 1 ? '' : 's'}`;

  lines.push(
    record.priorRoleIds.length === 0
      ? `Released <@${targetId}> from quarantine. They had no other roles, so only the ` +
          'quarantine role was removed.'
      : clean
        ? `Released <@${targetId}> from quarantine and gave back ${count}: ${roles}.`
        : `Released <@${targetId}> from quarantine. They had ${count}: ${roles}.`,
  );

  if (plan.vanishedRoleIds.length > 0) {
    const one = plan.vanishedRoleIds.length === 1;
    lines.push(
      `${plan.vanishedRoleIds.length} of their roles ${one ? 'no longer exists' : 'no longer exist'} ` +
        `and couldn't be given back: ${plan.vanishedRoleIds.join(', ')}.`,
    );
  }

  if (plan.ungrantableRoleIds.length > 0) {
    const one = plan.ungrantableRoleIds.length === 1;
    lines.push(
      `${plan.ungrantableRoleIds.length} of their roles ${one ? 'is' : 'are'} at or above my ` +
        `highest role, so I can't give ${one ? 'it' : 'them'} back: ` +
        `${plan.ungrantableRoleIds.map((id) => `<@&${id}>`).join(', ')}. Move my role above ` +
        `${one ? 'it' : 'them'} in Server Settings → Roles and run ${release} again, or add ` +
        `${one ? 'it' : 'them'} by hand.`,
    );
  }

  if (failures.length > 0) lines.push(`What failed: ${failures.join(' | ')}`);

  lines.push(
    clean
      ? 'The quarantine record was cleared.'
      : `I kept the quarantine record so nothing is lost. Fix the problems above and run ` +
          `${release} again. Roles they already have are skipped.`,
  );

  return lines.join('\n\n');
}
