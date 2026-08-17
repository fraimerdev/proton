import { type ActionKind, type ActionResult, dryRunFor, type ModuleContext } from '@proton/core';
import { CLASS_LABELS, type NukeClass } from './classes.ts';
import type { AntinukeConfig } from './config.ts';
import type { BoundAntinukeDeps } from './deps.ts';

export const MODULE_ID = 'antinuke';

export const ANTINUKE_ACTOR = 'proton:antinuke';

const REASON_MAX = 512;
const MESSAGE_MAX = 2000;

export interface BreakerInput {
  actorId: string;
  nukeClass: NukeClass;
  count: number;
  limit: number;
  window: string;
  eventId: string;
}

export interface BreakerReport {
  strippedRoleIds: string[];
  attempted: ActionKind[];
  failures: string[];
  ownerExempt: boolean;
  summary: string;
}

function describe(input: BreakerInput): string {
  return `${input.count} ${CLASS_LABELS[input.nukeClass]} within ${input.window} by ${input.actorId}`;
}

export async function tripBreaker(
  ctx: ModuleContext<AntinukeConfig>,
  deps: BoundAntinukeDeps,
  input: BreakerInput,
): Promise<BreakerReport> {
  const detected = describe(input);
  const state = await deps.guildState.get(ctx.guildId);

  if (state?.ownerId === input.actorId) {
    const summary =
      `Anti-nuke detected ${detected}, and that member owns this server. Discord does not let ` +
      "any bot remove the owner's roles, ban them or kick them, so Proton has done nothing and " +
      'cannot. Recover the account, then transfer ownership or enable server-wide 2FA.';
    ctx.logger.warn(summary, { guildId: ctx.guildId, moduleId: MODULE_ID, actorId: input.actorId });
    await announce(ctx, input.eventId, summary);

    const ownerReport: BreakerReport = {
      strippedRoleIds: [],
      attempted: [],
      failures: [],
      ownerExempt: true,
      summary,
    };
    await publishTrip(ctx, input, ownerReport);

    return ownerReport;
  }

  const reason = `Anti-nuke: ${detected}`.slice(0, REASON_MAX);
  const failures: string[] = [];
  const attempted: ActionKind[] = [];

  const roleIds = await deps.fetchMemberRoles(ctx.guildId, input.actorId);

  if (roleIds === null) {
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

      payload: { userId: input.actorId, roleId, strippedRoleIds: strippable },
      dryRun: dryRunFor('remove_role'),

      idempotencyKey: `${MODULE_ID}:${input.eventId}:strip:${roleId}`,
    });

    attempted.push('remove_role');
    collect(failures, result, `removing role ${roleId}`);
    if (result.status === 'executed' || result.status === 'dry_run') stripped.push(roleId);
  }

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

  const report: BreakerReport = {
    strippedRoleIds: stripped,
    attempted,
    failures,
    ownerExempt: false,
    summary,
  };
  await publishTrip(ctx, input, report);

  return report;
}

function collect(failures: string[], result: ActionResult, what: string): void {
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

export async function publishTrip(
  ctx: ModuleContext<AntinukeConfig>,
  input: BreakerInput,
  report: BreakerReport,
): Promise<void> {
  if (!ctx.publish) return;

  try {
    await ctx.publish('proton.security_tripped', input.eventId, {
      guildId: ctx.guildId,
      moduleId: MODULE_ID,
      trigger: input.nukeClass,
      actorId: input.actorId,
      summary: report.summary.slice(0, 1024),
      actionsTaken: [
        ...report.strippedRoleIds.map((roleId) => `stripped role ${roleId}`),
        ...report.attempted,
      ].slice(0, 20),
      ownerExempt: report.ownerExempt,
    });
  } catch (error) {
    ctx.logger.error(
      `Anti-nuke acted but could not publish the trip, so no Proton log was posted: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { guildId: ctx.guildId, moduleId: MODULE_ID },
    );
  }
}

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
    ctx.logger.error(
      `Anti-nuke could not post to its alert channel ${channelId}: ${result.failure.humanReason}`,
      { guildId: ctx.guildId, moduleId: MODULE_ID, code: result.failure.code },
    );
  }

  return result;
}
