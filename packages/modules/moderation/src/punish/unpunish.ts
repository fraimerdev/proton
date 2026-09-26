import { type ActionRequest, caseIdSchema, type ModuleContext } from '@proton/core';
import { describeError } from '@proton/db';
import type { ModerationConfig } from '../config.ts';
import type { ModerationDeps } from '../deps.ts';
import { MODULE_ID } from '../perform.ts';
import { auditReasonFor } from './audit-reason.ts';
import { TIMEOUT_CAP_MS, type UnpunishKind } from './config.ts';
import { sendPunishDm } from './dm.ts';
import { runLiftExtras } from './extras.ts';
import {
  actionKeyOf,
  closeBanCases,
  DUPLICATE_MESSAGE,
  dmLine,
  refused,
  resolveNotify,
  resolveReason,
} from './pipeline.ts';
import type { CaseStamp, LedgerCase } from './store.ts';
import { TIMEOUT_JOB } from './timeouts.ts';
import {
  DIRECTION_NOUN,
  type DmOutcome,
  type ExtraOutcome,
  type UnpunishOutcome,
  type UnpunishRequest,
} from './types.ts';

type Ctx = ModuleContext<ModerationConfig>;

const NO_LEDGER =
  "I can't read this server's cases right now, so I can't withdraw a warning. Nothing has " +
  'changed. This is a problem on my end, not a setting in this server.';

interface Target {
  targetId: string;
  caseId?: string;
}

async function targetOf(
  deps: ModerationDeps,
  guildId: string,
  request: UnpunishRequest,
): Promise<Target | Extract<UnpunishOutcome, { status: 'refused' }>> {
  if (request.kind !== 'unwarn') {
    return request.targetId
      ? { targetId: request.targetId }
      : refused('not_member', 'I need to know who this is for, so nothing was done.');
  }

  const caseId = request.caseId?.trim() ?? '';
  if (!caseIdSchema.safeParse(caseId).success) {
    return refused(
      'case_not_found',
      "That isn't a case ID. It's the code shown under the warning, like `K7f3M2q`. You can " +
        'also find it on the Cases page in the dashboard.',
    );
  }

  if (!deps.ledger) return refused('unbound', NO_LEDGER);

  const warning = await deps.ledger.find(guildId, caseId);
  if (warning?.kind !== 'warn') {
    return refused(
      'case_not_found',
      `No warning in this server has case ID \`${caseId}\`. Check it on the Cases page in the ` +
        'dashboard. Bans and kicks have case IDs too, but only a warning can be withdrawn this ' +
        'way.',
    );
  }

  if (warning.revertedAt !== null) {
    const by = warning.revertedBy ? ` by <@${warning.revertedBy}>` : '';
    return refused(
      'already_reverted',
      `Warning \`${caseId}\` was already withdrawn${by}. Nothing has changed.`,
    );
  }

  if (!warning.targetId) {
    return refused(
      'case_not_found',
      `Warning \`${caseId}\` isn't linked to a member, so there's nothing to clear. This is a ` +
        'problem on my end, not a setting in this server.',
    );
  }

  return { targetId: warning.targetId, caseId };
}

function payloadOf(kind: UnpunishKind, target: Target): Record<string, unknown> {
  return kind === 'unwarn'
    ? { userId: target.targetId, caseId: target.caseId }
    : { userId: target.targetId };
}

function headline(kind: UnpunishKind, target: Target): string {
  const who = `<@${target.targetId}>`;

  switch (kind) {
    case 'unban':
      return `Unbanned ${who}.`;
    case 'untimeout':
      return `${who} can talk again.`;
    case 'unwarn':
      return (
        `Withdrew warning \`${target.caseId}\` from ${who}. It no longer counts against them, ` +
        'but any escalation it already triggered stands.'
      );
  }
}

function replayed(kind: UnpunishKind, reason: string, caseId: string): UnpunishOutcome {
  return {
    status: 'executed',
    kind,
    caseId,
    reason,
    dm: 'not_sent',
    extras: [],
    revertedCaseIds: [],
    summary: `That ${DIRECTION_NOUN[kind]} already went through (case \`${caseId}\`).`,
  };
}

async function closeTimeouts(
  ctx: Ctx,
  deps: ModerationDeps,
  targetId: string,
  stamp: CaseStamp,
): Promise<LedgerCase[]> {
  const rows =
    (await deps.timeouts?.closeOpen(ctx.guildId, targetId, { ...stamp, reason: 'removed' })) ?? [];
  const tracked = (await deps.timeouts?.trackedCaseIds(ctx.guildId, targetId)) ?? [];
  const ledger = deps.ledger;

  const reverted = ledger
    ? [
        ...(await ledger.closeOpen(
          ctx.guildId,
          { targetId, kind: 'timeout', caseIds: rows.map((row) => row.caseId) },
          stamp,
        )),
        ...(await ledger.closeOpen(
          ctx.guildId,
          {
            targetId,
            kind: 'timeout',
            exceptCaseIds: tracked,
            createdAfter: new Date(stamp.at.getTime() - TIMEOUT_CAP_MS),
          },
          stamp,
        )),
      ]
    : [];

  await ctx.cancel?.(TIMEOUT_JOB, targetId);
  return reverted;
}

export async function unpunish(
  ctx: Ctx,
  deps: ModerationDeps,
  request: UnpunishRequest,
): Promise<UnpunishOutcome> {
  const punish = ctx.config.punish;
  const { kind, actor } = request;
  const now = deps.now?.() ?? Date.now();
  const root = request.idempotencyRoot;
  const actionKey = actionKeyOf(request);

  if (request.guildId !== ctx.guildId) {
    return refused('wrong_guild', 'That belongs to another server, so nothing was done.');
  }

  const resolved = resolveReason(punish, kind, actor, request.reason);
  if ('refusal' in resolved) return refused('reason_required', resolved.refusal);
  const { reason } = resolved;

  // Ahead of reading the warning: a withdrawal that already landed would read as already withdrawn.
  const existing = await deps.ledger?.byIdempotencyKey(ctx.guildId, actionKey);
  if (existing) return replayed(kind, reason, existing.caseId);

  const target = await targetOf(deps, ctx.guildId, request);
  if ('status' in target) return target;
  const { targetId } = target;

  const auditReason = await auditReasonFor(
    ctx.config,
    deps,
    kind,
    { actor, reason, durationMs: null },
    now,
  );

  const main: ActionRequest = {
    guildId: ctx.guildId,
    moduleId: MODULE_ID,
    kind,
    targetId,
    actorId: actor.id,
    ...(reason ? { reason } : {}),
    ...(auditReason ? { auditReason } : {}),
    payload: payloadOf(kind, target),
    dryRun: false,
    idempotencyKey: actionKey,
  };

  const result = await ctx.executor.execute(main);

  if (result.status === 'skipped_duplicate') {
    const found = await deps.ledger?.byIdempotencyKey(ctx.guildId, actionKey);
    return found
      ? replayed(kind, reason, found.caseId)
      : { status: 'duplicate', message: DUPLICATE_MESSAGE };
  }

  if (result.status !== 'executed') {
    return {
      status: 'failed',
      code: result.failure?.code ?? result.status,
      message: result.failure?.humanReason ?? "That didn't go through, and I wasn't told why.",
    };
  }

  const stamp = { at: new Date(now), by: actor.id };
  let reverted: LedgerCase[] = [];

  try {
    if (kind === 'untimeout') reverted = await closeTimeouts(ctx, deps, targetId, stamp);
    if (kind === 'unban') reverted = (await closeBanCases(ctx, deps, { targetId }, stamp)).closed;
    if (kind === 'unwarn' && deps.ledger && target.caseId) {
      reverted = await deps.ledger.closeOpen(
        ctx.guildId,
        { targetId, kind: 'warn', caseIds: [target.caseId] },
        stamp,
      );
    }
  } catch (error) {
    ctx.logger.error(
      `moderation carried out ${kind} on ${targetId} but could not close the cases it lifts: ` +
        describeError(error),
      { guildId: ctx.guildId, moduleId: MODULE_ID, userId: targetId },
    );
  }

  if (kind === 'unwarn' && reverted.length === 0) {
    return {
      status: 'failed',
      code: 'not_withdrawn',
      message:
        `Warning \`${target.caseId}\` still stands against <@${targetId}>. I recorded the ` +
        "withdrawal but couldn't clear the warning itself, so nothing has changed for them. Run " +
        'the command again.',
    };
  }

  const extras: ExtraOutcome[] =
    kind === 'unban'
      ? []
      : await runLiftExtras(ctx, {
          targetId,
          actorId: actor.id,
          root,
          ...(reason ? { reason } : {}),
          actions: punish.types[kind].actions,
        });

  const notify = resolveNotify(request.notify, punish.notifications.onUnpunish);
  const dm: DmOutcome = notify
    ? (
        await sendPunishDm(ctx, deps, {
          direction: kind,
          userId: targetId,
          root,
          actor,
          reason,
          durationMs: null,
          expiresAt: null,
          expired: false,
          caseId: result.caseId ?? null,
        })
      ).outcome
    : 'skipped';

  const lines = [headline(kind, target)];
  const told = dmLine(dm);
  if (told) lines.push(told);
  for (const extra of extras) {
    if (extra.status === 'failed') lines.push(extra.message);
  }

  return {
    status: 'executed',
    kind,
    caseId: result.caseId ?? null,
    reason,
    dm,
    extras,
    revertedCaseIds: reverted.map((entry) => entry.caseId),
    summary: lines.join('\n'),
  };
}
