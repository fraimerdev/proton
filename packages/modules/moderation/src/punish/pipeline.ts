import {
  type ActionExecutor,
  type ActionRequest,
  type ActionResult,
  computeChannelPermissions,
  formatDuration,
  type GuildState,
  hasWithAdmin,
  isScopedActionExecutor,
  type ModuleContext,
  Permissions,
  permissionLabels,
  type ResolveContextHints,
  reversalIdempotencyKey,
  tryParseDuration,
} from '@proton/core';
import { clipGraphemes } from '@proton/core/placeholders';
import { describeError } from '@proton/db';
import type { ModerationConfig } from '../config.ts';
import type { MemberLookup, ModerationDeps } from '../deps.ts';
import { isRefusal, MODULE_ID, readSpan } from '../perform.ts';
import { PUNISHMENT_ACTIONS } from '../placeholders.ts';
import { auditReasonFor } from './audit-reason.ts';
import {
  PUNISH_DURATION_MAX_MS,
  type PunishConfig,
  type PunishDirection,
  type PunishKind,
  TIMEOUT_CAP_MS,
} from './config.ts';
import { type NoticeInput, sendCorrectionDm, sendPunishDm } from './dm.ts';
import { runPunishExtras } from './extras.ts';
import { guardPunishTarget, immuneRole } from './guard.ts';
import { deleteProof } from './proof.ts';
import { expandReason } from './reasons.ts';
import { snapshotCaseHistory } from './snapshot.ts';
import type { CaseStamp, LedgerCase } from './store.ts';
import { applyTimeout, planTimeoutUntil } from './timeouts.ts';
import {
  DIRECTION_NOUN,
  DIRECTION_VERB,
  type DmOutcome,
  type ExtraOutcome,
  KIND_COMMAND,
  KIND_PERMISSION,
  type NotifyMode,
  type PunishActor,
  type PunishOutcome,
  type PunishRefusal,
  type PunishRequest,
} from './types.ts';

type Ctx = ModuleContext<ModerationConfig>;

export const REASON_MAX = 512;

export const DUPLICATE_MESSAGE =
  'That punishment is still being carried out. Check again in a moment.';

const UNKNOWN_FAILURE = "That didn't go through, and I wasn't told why.";

export const BAN_TOO_LONG =
  'A temporary ban can last at most 365 days. For longer, ban permanently.';

export type PresentMember = Exclude<MemberLookup, { state: 'unavailable' }>;

export interface Prepared {
  status: 'prepared';
  request: PunishRequest;
  reason: string;
  durationMs: number | null;
  endsAt: number | null;
  deleteMessageDays: number;
  member: PresentMember;
  notify: boolean;
  deleteProof: boolean;
  now: number;
}

export type Unprepared = Extract<
  PunishOutcome,
  { status: 'refused' | 'needs_confirmation' | 'executed' }
>;

export function actionKeyOf(request: Pick<PunishRequest, 'idempotencyRoot'>): string {
  return `${request.idempotencyRoot}:action`;
}

export function refused(
  code: PunishRefusal,
  message: string,
): { status: 'refused'; code: PunishRefusal; message: string } {
  return { status: 'refused', code, message };
}

export function resolveReason(
  punish: PunishConfig,
  direction: PunishDirection,
  actor: PunishActor,
  raw: string | undefined,
): { reason: string } | { refusal: string } {
  const typed = (raw ?? '').trim();
  const settings = punish.types[direction];

  if (typed === '' && settings.forceReason && actor.kind === 'member') {
    return {
      refusal:
        `This server requires a reason to ${DIRECTION_VERB[direction]} members, so nothing was ` +
        'done. Add one and try again.',
    };
  }

  const reason = typed === '' ? settings.defaultReason.trim() : expandReason(punish, typed);
  return { reason: clipGraphemes(reason, REASON_MAX) };
}

const PERMANENT = /^(permanent|perm|forever)$/i;

export function isPermanent(raw: string): boolean {
  return PERMANENT.test(raw.trim());
}

export function banDurationOf(raw: string | null | undefined): string | null | undefined {
  const typed = raw?.trim() ?? '';
  if (typed === '') return undefined;
  return isPermanent(typed) ? null : typed;
}

export function resolveNotify(mode: NotifyMode | undefined, inherited: boolean): boolean {
  if (mode === 'send') return true;
  if (mode === 'skip') return false;
  return inherited;
}

function durationFor(
  punish: PunishConfig,
  request: PunishRequest,
): { ms: number | null } | { code: PunishRefusal; refusal: string } {
  if (request.kind === 'timeout') {
    const raw = request.duration ?? punish.types.timeout.defaultDuration;
    const span = readSpan(raw);
    if (isRefusal(span)) return { code: 'invalid_duration', refusal: span.refusal };

    if (span.ms <= 0) {
      return {
        code: 'invalid_duration',
        refusal: `A timeout needs to be longer than zero, but '${raw}' ends immediately.`,
      };
    }
    if (span.ms > PUNISH_DURATION_MAX_MS) {
      return { code: 'duration_too_long', refusal: 'A timeout can last at most 365 days.' };
    }
    if (span.ms > TIMEOUT_CAP_MS && !punish.extendTimeouts) {
      return {
        code: 'duration_too_long',
        refusal:
          'Discord ends a timeout after 28 days. Turn on Extend timeouts under Moderation → ' +
          'Punish settings to go longer, or pick a shorter duration.',
      };
    }

    return { ms: span.ms };
  }

  if (request.kind === 'ban') {
    const raw =
      request.duration === undefined ? punish.types.ban.defaultDuration : request.duration;
    if (raw === null || isPermanent(raw)) return { ms: null };

    const span = readSpan(raw);
    if (isRefusal(span)) return { code: 'invalid_duration', refusal: span.refusal };
    if (span.ms <= 0) {
      return {
        code: 'invalid_duration',
        refusal: `A temporary ban needs to be longer than zero, but '${raw}' ends immediately.`,
      };
    }
    if (span.ms > PUNISH_DURATION_MAX_MS) {
      return { code: 'duration_too_long', refusal: BAN_TOO_LONG };
    }

    return { ms: span.ms };
  }

  return { ms: null };
}

function ownsGuild(state: GuildState | null, actorId: string): boolean {
  return state !== null && state.ownerId === actorId;
}

export function canDeleteIn(state: GuildState, actor: PunishActor, channelId: string): boolean {
  if (state.ownerId === actor.id) return true;
  if (actor.roleIds === null) return false;

  const channel = state.channels.get(channelId);
  const permissions = computeChannelPermissions(
    {
      guildOwnerId: state.ownerId,
      everyoneRoleId: state.everyoneRoleId,
      memberId: actor.id,
      memberRoleIds: actor.roleIds,
      roles: state.roles,
    },
    channel?.overwrites ?? [],
    state.channels.get(channel?.parentId ?? '')?.overwrites ?? [],
  );

  return hasWithAdmin(permissions, Permissions.ManageMessages);
}

async function readState(deps: ModerationDeps, guildId: string): Promise<GuildState | null> {
  try {
    return (await deps.guildState?.get(guildId)) ?? null;
  } catch {
    return null;
  }
}

async function lookup(
  deps: ModerationDeps,
  guildId: string,
  userId: string,
): Promise<MemberLookup | null> {
  if (!deps.lookupMember) return null;

  try {
    return await deps.lookupMember(guildId, userId);
  } catch {
    return { state: 'unavailable', status: 0 };
  }
}

const STATE_UNAVAILABLE =
  "I don't have this server's roles and channels yet, so I can't check that this is allowed. " +
  'Nothing was done. Try again in a moment.';

const WINDOW_FALLBACK_MS = 5 * 60_000;

export async function preparePunishment(
  ctx: Ctx,
  deps: ModerationDeps,
  request: PunishRequest,
): Promise<Prepared | Unprepared> {
  const punish = ctx.config.punish;
  const { kind, actor, targetId } = request;
  const verb = DIRECTION_VERB[kind];
  const now = deps.now?.() ?? Date.now();
  const byMember = actor.kind === 'member';
  const reviewed = request.origin.type === 'report' || request.origin.type === 'message';

  if (request.guildId !== ctx.guildId) {
    return refused(
      'wrong_guild',
      'That punishment belongs to another server, so nothing was done.',
    );
  }

  let state: GuildState | null | undefined;
  const guildState = async (): Promise<GuildState | null> => {
    if (state === undefined) state = await readState(deps, ctx.guildId);
    return state;
  };

  if (byMember && reviewed) {
    const required = KIND_PERMISSION[kind];
    if (
      !hasWithAdmin(actor.permissions ?? 0n, required) &&
      !ownsGuild(await guildState(), actor.id)
    ) {
      const label = permissionLabels(required).join(', ');
      return refused(
        'missing_permission',
        `You need the ${label} permission in this server to ${verb} members, so nothing was done.`,
      );
    }

    if (deps.commandGate) {
      const gate = await deps.commandGate(ctx.guildId, KIND_COMMAND[kind], actor.roleIds ?? []);
      if (!gate.allowed) return refused('command_gated', gate.message);
    }
  }

  const deletesProof =
    request.proof !== undefined && (request.deleteProof ?? punish.types[kind].deleteProof);

  if (deletesProof && byMember && request.proof) {
    const current = await guildState();
    if (!current) return refused('guild_state_unavailable', STATE_UNAVAILABLE);

    if (!canDeleteIn(current, actor, request.proof.channelId)) {
      return refused(
        'proof_permission',
        `You need Manage Messages in <#${request.proof.channelId}> to delete that message, so ` +
          'nothing was done. Keep the message instead, or ask someone who can delete it.',
      );
    }
  }

  const resolved = resolveReason(punish, kind, actor, request.reason);
  if ('refusal' in resolved) return refused('reason_required', resolved.refusal);

  const duration = durationFor(punish, request);
  if ('refusal' in duration) return refused(duration.code, duration.refusal);

  // Ahead of the member lookup: a kick or ban that already landed leaves nobody to look up.
  const earlier = await deps.ledger?.byIdempotencyKey(ctx.guildId, actionKeyOf(request));
  if (earlier) {
    return replayOf(ctx, deps, request, { reason: resolved.reason, expiresAt: null, now }, earlier);
  }

  const member = await lookup(deps, ctx.guildId, targetId);
  if (member === null) {
    return refused(
      'unbound',
      "I can't look up members in this server right now, so nothing was done. This is a problem " +
        'on my end, not a setting in this server.',
    );
  }

  if (member.state === 'unavailable') {
    const answered =
      member.status > 0 ? `Discord answered ${member.status}` : "Discord didn't answer";
    return refused(
      'lookup_unavailable',
      `I couldn't look up <@${targetId}> right now (${answered}), so nothing was done. Try again.`,
    );
  }

  if (member.state === 'absent' && kind !== 'ban') {
    return refused(
      'not_member',
      `<@${targetId}> isn't in the server, so there's nobody to ${verb}. Nothing was done.`,
    );
  }

  const targetRoleIds = member.state === 'member' ? member.roleIds : [];

  if (byMember && punish.immunity.useHierarchy) {
    if (member.state === 'member') {
      const current = await guildState();
      if (!current) return refused('guild_state_unavailable', STATE_UNAVAILABLE);

      const guarded = guardPunishTarget({
        state: current,
        actorId: actor.id,
        actorRoleIds: actor.roleIds,
        targetId,
        targetRoleIds,
        kind,
      });
      if (guarded) return refused('hierarchy', guarded.refusal);
    }
  } else {
    const immune = immuneRole(punish, kind, targetRoleIds);
    if (immune) {
      return refused(
        'immune_role',
        `<@${targetId}> has <@&${immune}>, which is immune to ${DIRECTION_NOUN[kind]}s in ` +
          'this server (Moderation → Immunity). Nothing was done.',
      );
    }
  }

  if (punish.confirmRecentCase.enabled && !request.confirmedRecentCase) {
    if (!deps.ledger) {
      return refused(
        'unbound',
        "This server asks me to check a member's recent cases first, but I can't read them " +
          'right now. Nothing was done. This is a problem on my end, not a setting in this server.',
      );
    }

    const window = tryParseDuration(punish.confirmRecentCase.window) ?? WINDOW_FALLBACK_MS;
    const recent = await deps.ledger.recent(ctx.guildId, targetId, kind, new Date(now - window));

    if (recent) {
      return {
        status: 'needs_confirmation',
        code: 'recent_case',
        recentCaseId: recent.caseId,
        message:
          `<@${targetId}> was already ${PUNISHMENT_ACTIONS[kind]} ` +
          `<t:${Math.floor(recent.createdAt / 1000)}:R> ` +
          `(case \`${recent.caseId}\`). ${capitalised(verb)} them again?`,
      };
    }
  }

  const durationMs = duration.ms;

  return {
    status: 'prepared',
    request,
    reason: resolved.reason,
    durationMs,
    endsAt: durationMs === null ? null : now + durationMs,
    deleteMessageDays:
      kind === 'ban'
        ? Math.min(
            7,
            Math.max(
              0,
              Math.trunc(request.deleteMessageDays ?? punish.types.ban.deleteMessageDays),
            ),
          )
        : 0,
    member,
    notify: resolveNotify(request.notify, punish.notifications.onPunish),
    deleteProof: deletesProof,
    now,
  };
}

function capitalised(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function executorFor(executor: ActionExecutor, member: PresentMember): ActionExecutor {
  if (!isScopedActionExecutor(executor)) return executor;

  const hints: ResolveContextHints =
    member.state === 'absent'
      ? { targetAbsent: true, targetRoleIds: [] }
      : { targetRoleIds: member.roleIds };

  return executor.scoped(hints);
}

function payloadFor(prepared: Prepared, until: number | null): Record<string, unknown> {
  const { kind, targetId } = prepared.request;

  switch (kind) {
    case 'ban':
      return { userId: targetId, deleteMessageSeconds: prepared.deleteMessageDays * 86_400 };
    case 'kick':
      return { userId: targetId };
    case 'timeout':
      return {
        userId: targetId,
        until: new Date(until ?? prepared.now),
        ...(prepared.endsAt !== null ? { endsAt: new Date(prepared.endsAt) } : {}),
      };
    case 'warn':
      return { userId: targetId, ...(prepared.reason ? { note: prepared.reason } : {}) };
  }
}

type Executed = Extract<PunishOutcome, { status: 'executed' }>;

function replayed(
  kind: PunishKind,
  reason: string,
  expiresAt: number | null,
  caseId: string,
): Executed {
  return {
    status: 'executed',
    kind,
    caseId,
    reason,
    expiresAt,
    dm: 'not_sent',
    extras: [],
    proofDeleted: null,
    summary: `That ${DIRECTION_NOUN[kind]} already went through (case \`${caseId}\`).`,
  };
}

export async function closeBanCases(
  ctx: Ctx,
  deps: ModerationDeps,
  match: { targetId: string; exceptCaseIds?: readonly string[] },
  stamp: CaseStamp,
): Promise<{ closed: LedgerCase[]; uncancelled: string[] }> {
  const { targetId } = match;
  const closed =
    (await deps.ledger?.closeOpen(
      ctx.guildId,
      {
        targetId,
        kind: 'ban',
        ...(match.exceptCaseIds ? { exceptCaseIds: match.exceptCaseIds } : {}),
      },
      stamp,
    )) ?? [];
  const uncancelled: string[] = [];

  for (const ban of closed) {
    try {
      await deps.reversals?.cancel(reversalIdempotencyKey(ban.idempotencyKey));
    } catch (error) {
      uncancelled.push(ban.caseId);
      ctx.logger.warn(
        `moderation closed ban case ${ban.caseId} of ${targetId} but could not cancel its ` +
          `automatic unban: ${describeError(error)}`,
        { guildId: ctx.guildId, moduleId: MODULE_ID, userId: targetId },
      );
    }
  }

  return { closed, uncancelled };
}

async function supersedeBans(
  ctx: Ctx,
  deps: ModerationDeps,
  request: PunishRequest,
  caseId: string,
  now: number,
): Promise<string[]> {
  try {
    const { uncancelled } = await closeBanCases(
      ctx,
      deps,
      { targetId: request.targetId, exceptCaseIds: [caseId] },
      { at: new Date(now), by: request.actor.id },
    );
    return uncancelled.map(
      (earlier) =>
        `Couldn't cancel the automatic unban of earlier ban \`${earlier}\`, so it may still ` +
        'lift this ban when that one would have ended.',
    );
  } catch (error) {
    ctx.logger.error(
      `moderation banned ${request.targetId} but could not close their earlier ban cases: ` +
        describeError(error),
      { guildId: ctx.guildId, moduleId: MODULE_ID, userId: request.targetId },
    );
    return [
      "Couldn't check for an earlier temporary ban, so one may still lift this ban when it ends.",
    ];
  }
}

async function replayOf(
  ctx: Ctx,
  deps: ModerationDeps,
  request: PunishRequest,
  replay: { reason: string; expiresAt: number | null; now: number },
  found: { caseId: string; revertedAt: number | null },
): Promise<Executed> {
  const outcome = replayed(request.kind, replay.reason, replay.expiresAt, found.caseId);
  if (request.kind !== 'ban' || found.revertedAt !== null) return outcome;

  const notes = await supersedeBans(ctx, deps, request, found.caseId, replay.now);
  return notes.length === 0
    ? outcome
    : { ...outcome, summary: [outcome.summary, ...notes].join('\n') };
}

export function dmLine(dm: DmOutcome): string | null {
  switch (dm) {
    case 'skipped':
      return null;
    case 'sent':
      return 'They were told by DM.';
    case 'closed':
      return "They weren't told because their DMs are closed.";
    case 'no_mutual_server':
      return "They weren't told because they no longer share a server with Proton.";
    default:
      return "They weren't told because the DM didn't go through.";
  }
}

function timestamp(ms: number): string {
  return `<t:${Math.floor(ms / 1000)}:f>`;
}

function headline(prepared: Prepared, result: ActionResult, until: number | null): string {
  const { kind, targetId } = prepared.request;
  const who = `<@${targetId}>`;
  const { durationMs, endsAt } = prepared;

  switch (kind) {
    case 'ban': {
      const absent = prepared.member.state === 'absent' ? ", who wasn't in the server" : '';
      if (durationMs === null || result.failure) {
        return `Banned ${who}${absent}.${result.failure ? `\n\n${result.failure.humanReason}` : ''}`;
      }
      return `Banned ${who}${absent} for ${formatDuration(durationMs)}. The ban lifts automatically.`;
    }
    case 'kick':
      return `Kicked ${who}. They can rejoin with a new invite.`;
    case 'timeout': {
      const span = durationMs === null ? '' : ` for ${formatDuration(durationMs)}`;
      const lines = [`Timed out ${who}${span}.`];
      if (endsAt !== null && until !== null && endsAt > until) {
        lines.push(
          `Discord ends a timeout after 28 days, so it will be renewed until ${timestamp(endsAt)}.`,
        );
      }
      if (endsAt !== null && until !== null && until > endsAt) {
        lines.push(`They stay timed out until ${timestamp(until)} because of an earlier timeout.`);
      }
      return lines.join(' ');
    }
    case 'warn':
      return `Warned ${who}.`;
  }
}

function summaryOf(
  prepared: Prepared,
  result: ActionResult,
  until: number | null,
  dm: DmOutcome,
  extras: readonly ExtraOutcome[],
  notes: readonly string[],
): string {
  const lines = [headline(prepared, result, until)];
  const told = dmLine(dm);
  if (told) lines.push(told);
  lines.push(...notes);
  for (const extra of extras) {
    if (extra.status === 'failed') lines.push(extra.message);
  }
  return lines.join('\n');
}

function dmRootOf(request: PunishRequest): string {
  return request.dmRoot ?? request.idempotencyRoot;
}

function noticeOf(prepared: Prepared, caseId: string | null): NoticeInput {
  const { request } = prepared;

  return {
    direction: request.kind,
    userId: request.targetId,
    root: dmRootOf(request),
    duplicate: 'not_sent',
    actor: request.actor,
    reason: prepared.reason,
    durationMs: prepared.durationMs,
    expiresAt: prepared.endsAt,
    caseId,
  };
}

export async function executePunishment(
  ctx: Ctx,
  deps: ModerationDeps,
  prepared: Prepared,
): Promise<PunishOutcome> {
  const { request, now, reason } = prepared;
  const { kind, targetId, actor } = request;
  const punish = ctx.config.punish;
  const root = request.idempotencyRoot;
  const actionKey = actionKeyOf(request);

  const replay = { reason, expiresAt: prepared.endsAt, now };
  const existing = await deps.ledger?.byIdempotencyKey(ctx.guildId, actionKey);
  if (existing) return replayOf(ctx, deps, request, replay, existing);

  const executor = executorFor(ctx.executor, prepared.member);
  const auditReason = await auditReasonFor(
    ctx.config,
    deps,
    kind,
    { actor, reason, durationMs: prepared.durationMs },
    now,
  );

  const until =
    kind === 'timeout' && prepared.endsAt !== null
      ? await planTimeoutUntil(ctx, deps, {
          userId: targetId,
          endsAt: prepared.endsAt,
          allowMultiple: punish.types.timeout.allowMultiple,
          timeoutUntil: prepared.member.state === 'member' ? prepared.member.timeoutUntil : null,
          now,
        })
      : null;

  const main: ActionRequest = {
    guildId: ctx.guildId,
    moduleId: MODULE_ID,
    kind,
    targetId,
    actorId: actor.id,
    ...(reason ? { reason } : {}),
    ...(auditReason ? { auditReason } : {}),
    payload: payloadFor(prepared, until),
    ...(kind === 'ban' && prepared.endsAt !== null ? { expiresAt: new Date(prepared.endsAt) } : {}),
    dryRun: false,
    idempotencyKey: actionKey,
  };

  const dmFirst = prepared.notify && (kind === 'ban' || kind === 'kick');
  let dm: DmOutcome = prepared.notify ? 'not_sent' : 'skipped';
  let dmChannel: string | null = null;

  if (dmFirst) {
    const blocked = (await executor.precheck?.(main)) ?? null;
    if (blocked) return { status: 'failed', code: blocked.code, message: blocked.humanReason };

    const sent = await sendPunishDm(ctx, deps, noticeOf(prepared, null));
    dm = sent.outcome;
    dmChannel = sent.channelId;
  }

  const result = await executor.execute(main);

  if (result.status === 'skipped_duplicate') {
    const found = await deps.ledger?.byIdempotencyKey(ctx.guildId, actionKey);
    return found
      ? replayOf(ctx, deps, request, replay, found)
      : { status: 'duplicate', message: DUPLICATE_MESSAGE };
  }

  if (result.status !== 'executed') {
    if (dmFirst && dm === 'sent') {
      await sendCorrectionDm(ctx, deps, {
        userId: targetId,
        root: dmRootOf(request),
        actorId: actor.id,
        direction: kind,
        channelId: dmChannel,
      });
    }

    return {
      status: 'failed',
      code: result.failure?.code ?? result.status,
      message: result.failure?.humanReason ?? UNKNOWN_FAILURE,
    };
  }

  const caseId = result.caseId ?? null;
  const extras: ExtraOutcome[] = [];
  const notes: string[] = [];

  if (kind === 'ban' && caseId !== null) {
    notes.push(...(await supersedeBans(ctx, deps, request, caseId, now)));
  }

  if (kind === 'warn') {
    try {
      await ctx.publish?.('moderation.warned', `${root}:warn`, {
        userId: targetId,
        ...(request.channelId ? { channelId: request.channelId } : {}),
      });
    } catch (error) {
      ctx.logger.error(
        `moderation recorded a warning but could not announce it: ${describeError(error)}`,
        {
          guildId: ctx.guildId,
          moduleId: MODULE_ID,
          userId: targetId,
        },
      );
      notes.push("Warn escalation didn't run for this warning.");
    }
  }

  if (kind === 'timeout' && caseId !== null && until !== null && prepared.endsAt !== null) {
    try {
      await applyTimeout(ctx, deps, {
        caseId,
        userId: targetId,
        actorId: actor.id,
        endsAt: prepared.endsAt,
        appliedUntil: until,
        allowMultiple: punish.types.timeout.allowMultiple,
        now,
      });
    } catch (error) {
      ctx.logger.error(`moderation could not track timeout ${caseId}: ${describeError(error)}`, {
        guildId: ctx.guildId,
        moduleId: MODULE_ID,
        userId: targetId,
      });
      if (prepared.endsAt > until) {
        notes.push("Couldn't schedule the renewal, so Discord will end it after 28 days.");
      }
    }
  }

  if (prepared.notify && !dmFirst) {
    dm = (await sendPunishDm(ctx, deps, noticeOf(prepared, caseId))).outcome;
  }

  if (kind === 'timeout' || kind === 'warn') {
    extras.push(
      ...(await runPunishExtras(ctx, {
        targetId,
        actorId: actor.id,
        root,
        ...(reason ? { reason } : {}),
        actions: punish.types[kind].actions,
        executor,
      })),
    );
  }

  let proofDeleted: boolean | null = null;
  if (prepared.deleteProof && request.proof) {
    const deleted = await deleteProof(ctx, { proof: request.proof, root, actorId: actor.id });
    proofDeleted = deleted.deleted;
    extras.push(deleted.outcome);
  }

  if (caseId !== null) {
    const snapshot = await snapshotCaseHistory(ctx, deps, {
      caseId,
      targetId,
      proof: request.proof,
      now,
    });
    if (snapshot) extras.push(snapshot);
  }

  return {
    status: 'executed',
    kind,
    caseId,
    reason,
    expiresAt: kind === 'ban' || kind === 'timeout' ? prepared.endsAt : null,
    dm,
    extras,
    proofDeleted,
    summary: summaryOf(prepared, result, until, dm, extras, notes),
  };
}

export async function punish(
  ctx: Ctx,
  deps: ModerationDeps,
  request: PunishRequest,
): Promise<PunishOutcome> {
  const prepared = await preparePunishment(ctx, deps, request);
  if (prepared.status !== 'prepared') return prepared;

  return executePunishment(ctx, deps, prepared);
}
