import type { ActionKind, ActionResult, ModuleContext } from '@proton/core';
import { CLASS_LABELS, type NukeClass } from './classes.ts';
import type { AfterStripAction, AntinukeConfig } from './config.ts';
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
  afterStripDone: AfterStripAction;
  failures: string[];
  ownerExempt: boolean;
  summary: string;
}

function describe(input: BreakerInput): string {
  return `${input.count} ${CLASS_LABELS[input.nukeClass]} within ${input.window} by ${input.actorId}`;
}

// The audit-log reason and the logs keep the bare id; Discord renders neither <@id> nor <@&id>
// in an audit-log entry, so a mention there reads as literal angle brackets.
function forAlert(input: BreakerInput): string {
  return `${input.count} ${CLASS_LABELS[input.nukeClass]} within ${input.window} by <@${input.actorId}>`;
}

const AFTER_STRIP_PHRASE: Record<Exclude<AfterStripAction, 'none'>, string> = {
  ban: 'They were then banned from this server.',
  kick: 'They were then kicked from this server.',
};

const AFTER_STRIP_TAKEN: Record<Exclude<AfterStripAction, 'none'>, string> = {
  ban: 'Banned',
  kick: 'Kicked',
};

export async function tripBreaker(
  ctx: ModuleContext<AntinukeConfig>,
  deps: BoundAntinukeDeps,
  input: BreakerInput,
): Promise<BreakerReport> {
  const detected = describe(input);
  const state = await deps.guildState.get(ctx.guildId);

  if (state?.ownerId === input.actorId) {
    const summary =
      `Anti-Nuke detected ${forAlert(input)}, and that member owns this server. Discord doesn't ` +
      "let bots remove the owner's roles, ban them or kick them, so nothing was done. Recover " +
      'the account, then transfer ownership or turn on server-wide 2FA.';

    ctx.logger.warn(summary, { guildId: ctx.guildId, moduleId: MODULE_ID, actorId: input.actorId });

    await announce(ctx, input.eventId, summary);

    const ownerReport: BreakerReport = {
      strippedRoleIds: [],
      attempted: [],
      afterStripDone: 'none',
      failures: [],
      ownerExempt: true,
      summary,
    };
    await publishTrip(ctx, input, ownerReport);

    return ownerReport;
  }

  const reason = `Anti-Nuke: ${detected}`.slice(0, REASON_MAX);
  const failures: string[] = [];
  const attempted: ActionKind[] = [];

  const roleIds = await deps.fetchMemberRoles(ctx.guildId, input.actorId);

  if (roleIds === null) {
    const summary =
      `Anti-Nuke detected ${forAlert(input)}, but couldn't read that member's roles, so nothing ` +
      'was done. They may have already left the server. Check the audit log and act by hand.';
    ctx.logger.error(summary, {
      guildId: ctx.guildId,
      moduleId: MODULE_ID,
      actorId: input.actorId,
    });
    await announce(ctx, input.eventId, summary);
    return {
      strippedRoleIds: [],
      attempted: [],
      afterStripDone: 'none',
      failures: [],
      ownerExempt: false,
      summary,
    };
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
      dryRun: false,

      idempotencyKey: `${MODULE_ID}:${input.eventId}:strip:${roleId}`,
    });

    attempted.push('remove_role');
    collect(failures, result, `Couldn't remove <@&${roleId}>`);
    if (result.status === 'executed' || result.status === 'dry_run') stripped.push(roleId);
  }

  let afterStripDone: AfterStripAction = 'none';
  if (ctx.config.afterStrip !== 'none') {
    const kind = ctx.config.afterStrip;
    const result = await ctx.executor.execute({
      guildId: ctx.guildId,
      moduleId: MODULE_ID,
      kind,
      actorId: ANTINUKE_ACTOR,
      targetId: input.actorId,
      reason,
      payload: { userId: input.actorId },
      dryRun: false,
      idempotencyKey: `${MODULE_ID}:${input.eventId}:${kind}`,
    });

    attempted.push(kind);
    if (!collect(failures, result, `Couldn't ${kind} them`)) afterStripDone = kind;
  }

  const summary = summarise(
    ctx.config,
    input,
    forAlert(input),
    stripped,
    strippable,
    failures,
    afterStripDone,
  );

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
    afterStripDone,
    failures,
    ownerExempt: false,
    summary,
  };
  await publishTrip(ctx, input, report);

  return report;
}

function collect(failures: string[], result: ActionResult, what: string): boolean {
  if (result.status === 'skipped_duplicate' || !result.failure) return false;
  failures.push(`${what}: ${result.failure.humanReason}`);
  return true;
}

function summarise(
  config: AntinukeConfig,
  input: BreakerInput,
  detected: string,
  stripped: readonly string[],
  attempted: readonly string[],
  failures: readonly string[],
  afterStripDone: AfterStripAction,
): string {
  const lines = [`Anti-Nuke tripped: ${detected} (limit ${input.limit} per ${input.window}).`];

  if (attempted.length === 0) {
    lines.push('They had no roles to remove.');
  } else {
    lines.push(
      `Removed ${stripped.length} of their ${attempted.length} roles: ` +
        `${attempted.map((roleId) => `<@&${roleId}>`).join(', ')}.` +
        (stripped.length > 0
          ? ' Each removal is recorded as a case with the full role list, so their roles can be ' +
            'restored exactly.'
          : ''),
    );
  }

  if (config.afterStrip === 'none') {
    lines.push(
      'Nothing else was done, as "After stripping roles" is set to Nothing further. Check the ' +
        'audit log and decide what to do next.',
    );
  } else if (afterStripDone !== 'none') {
    lines.push(AFTER_STRIP_PHRASE[afterStripDone]);
  }

  for (const failure of failures) lines.push(`⚠ ${failure}`);

  return lines.join('\n').slice(0, MESSAGE_MAX);
}

export async function publishTrip(
  ctx: ModuleContext<AntinukeConfig>,
  input: BreakerInput,
  report: BreakerReport,
): Promise<void> {
  if (!ctx.publish) return;

  const followUp =
    report.afterStripDone === 'none' ? [] : [AFTER_STRIP_TAKEN[report.afterStripDone]];

  try {
    await ctx.publish('proton.security_tripped', input.eventId, {
      guildId: ctx.guildId,
      moduleId: MODULE_ID,
      trigger: input.nukeClass,
      actorId: input.actorId,
      summary: report.summary.slice(0, 1024),
      actionsTaken: [
        ...report.strippedRoleIds
          .slice(0, 20 - followUp.length)
          .map((roleId) => `Removed <@&${roleId}>`),
        ...followUp,
      ],
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
    // The alert names roles and the member by mention so they are readable, and must not ping
    // a whole server mid-incident.
    payload: {
      channelId,
      content: content.slice(0, MESSAGE_MAX),
      allowedMentions: { parse: [] },
    },
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
