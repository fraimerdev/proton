import {
  hasWithAdmin,
  type ModuleContext,
  messageUrl,
  Permissions,
  type ResolvedAttachment,
} from '@proton/core';
import { describeError } from '@proton/db';
import type { ModerationConfig } from '../config.ts';
import type { ModerationDeps, ReportAcceptRequest } from '../deps.ts';
import type { PunishKind } from '../punish/config.ts';
import { canDeleteIn, punish } from '../punish/pipeline.ts';
import { deleteProof } from '../punish/proof.ts';
import { DIRECTION_NOUN, type ProofMessage } from '../punish/types.ts';
import { mayReview, mayUnclaim, type ReviewAction, type ReviewActor } from './authorize.ts';
import { actorMention } from './card.ts';
import {
  cardKey,
  closeFor,
  deliverCard,
  RATE_LIMITED,
  readState,
  recordReportEvent,
  refreshCard,
  runResolutionTail,
} from './delivery.ts';
import type { ReportStore } from './store.ts';
import {
  EVIDENCE_RESOLVED_TTL_MS,
  isActiveStatus,
  type NotificationKind,
  type ReportRecord,
} from './types.ts';

type Ctx = ModuleContext<ModerationConfig>;

export type ReviewResult =
  | { ok: true; message: string; report: ReportRecord; caseId?: string }
  | { ok: false; code: string; message: string; needsConfirmation?: 'recent_case' };

type Refusal = Extract<ReviewResult, { ok: false }>;

export const DECISION_STALE_MS = 2 * 60 * 1000;

export const REVIEW_MODERATION_OFF = 'Moderation is off in this server, so nothing was done.';

export const REVIEW_STORE_UNBOUND =
  'User reports aren’t available right now, so nothing was done. This isn’t caused by a setting ' +
  'in this server.';

const PUNISHED: Readonly<Record<PunishKind, string>> = {
  ban: 'banned',
  kick: 'kicked',
  timeout: 'timed out',
  warn: 'warned',
};

function isPunishKind(kind: string | null): kind is PunishKind {
  return kind !== null && Object.hasOwn(PUNISHED, kind);
}

export function deciding(kind: string | null): string {
  const what =
    kind === 'dismiss'
      ? 'being dismissed'
      : kind === 'none'
        ? 'being accepted'
        : isPunishKind(kind)
          ? `being accepted with a ${DIRECTION_NOUN[kind]}`
          : 'being decided';

  return `This report is already ${what}. Try again in 2 minutes.`;
}

export function stillSettling(reportId: string, kind: PunishKind, targetId: string): string {
  return (
    `A ${DIRECTION_NOUN[kind]} for report \`${reportId}\` is already under way. The report stays ` +
    `locked for up to 2 minutes while it finishes. If <@${targetId}> hasn’t been ` +
    `${PUNISHED[kind]} by then, accept the report without a punishment or use the slash command.`
  );
}

export const STILL_OPEN =
  'The report is still open. Try again, choose another action, or accept it without a punishment.';

export function acceptRoot(reportId: string): string {
  return `moderation:report:${reportId}:accept`;
}

export function refusal(code: string, message: string): Refusal {
  return { ok: false, code, message };
}

export function notFound(reportId: string): Refusal {
  return refusal('not_found', `Report \`${reportId}\` doesn’t exist in this server any more.`);
}

export function alreadyResolved(report: ReportRecord): Refusal {
  return refusal(
    'already_resolved',
    `Report \`${report.id}\` was already ${report.status} by ${actorMention(report.resolvedBy)}.`,
  );
}

export function claimedBy(assigneeId: string | null): Refusal {
  return refusal(
    'claimed',
    assigneeId ? `Already claimed by <@${assigneeId}>.` : 'Someone else claimed it first.',
  );
}

function isAdmin(actor: ReviewActor): boolean {
  return actor.owner === true || hasWithAdmin(actor.permissions, Permissions.ManageGuild);
}

interface Reviewing {
  store: ReportStore;
  report: ReportRecord;
  actor: ReviewActor;
  now: number;
}

async function begin(
  ctx: Ctx,
  deps: ModerationDeps,
  reportId: string,
  actor: ReviewActor,
  action: ReviewAction,
): Promise<Reviewing | Refusal> {
  if (!ctx.config.enabled) return refusal('module_disabled', REVIEW_MODERATION_OFF);

  const store = deps.reports;
  if (!store) return refusal('unavailable', REVIEW_STORE_UNBOUND);

  const report = await store.get(ctx.guildId, reportId);
  if (!report) return notFound(reportId);

  const state = actor.owner === true ? null : await readState(deps, ctx.guildId);
  const reviewer: ReviewActor = {
    ...actor,
    ...(actor.owner === true || state?.ownerId === actor.id ? { owner: true } : {}),
  };

  const allowed = mayReview(ctx.config, reviewer, report, action);
  if (!allowed.ok) return refusal('not_allowed', allowed.message);

  return { store, report, actor: reviewer, now: deps.now?.() ?? Date.now() };
}

function isRefusal(value: Reviewing | Refusal): value is Refusal {
  return 'ok' in value;
}

async function refreshQuietly(ctx: Ctx, deps: ModerationDeps, report: ReportRecord, now: number) {
  try {
    await refreshCard(ctx, deps, report, now);
  } catch (error) {
    ctx.logger.warn(
      `report ${report.id}: the staff card could not be updated: ${describeError(error)}`,
      { guildId: ctx.guildId, reportId: report.id },
    );
  }
}

export async function claimReport(
  ctx: Ctx,
  deps: ModerationDeps,
  reportId: string,
  actor: ReviewActor,
): Promise<ReviewResult> {
  const begun = await begin(ctx, deps, reportId, actor, 'claim');
  if (isRefusal(begun)) return begun;
  const { store, report, now } = begun;

  if (!isActiveStatus(report.status)) return alreadyResolved(report);
  if (report.status === 'in_review' && report.assigneeId !== actor.id) {
    return claimedBy(report.assigneeId);
  }

  const claimed = await store.claim(ctx.guildId, report.id, actor.id, now);
  if (!claimed) {
    const current = await store.get(ctx.guildId, report.id);
    if (!current) return notFound(report.id);
    if (!isActiveStatus(current.status)) return alreadyResolved(current);
    return claimedBy(current.assigneeId);
  }

  if (claimed.version === report.version) {
    return { ok: true, message: `You already claimed report \`${report.id}\`.`, report: claimed };
  }

  await recordReportEvent(store, claimed, 'claimed', {
    key: claimed.version,
    actorId: actor.id,
    source: actor.source,
    at: now,
  });
  await refreshQuietly(ctx, deps, claimed, now);

  return { ok: true, message: `You claimed report \`${report.id}\`.`, report: claimed };
}

export async function assignReport(
  ctx: Ctx,
  deps: ModerationDeps,
  reportId: string,
  actor: ReviewActor,
  assigneeId: string | null,
): Promise<ReviewResult> {
  if (actor.source !== 'dashboard') {
    return refusal(
      'not_allowed',
      'Assigning a report to someone else is done from the Proton dashboard.',
    );
  }

  const begun = await begin(ctx, deps, reportId, actor, 'assign');
  if (isRefusal(begun)) return begun;
  const { store, report, now } = begun;

  if (!isAdmin(begun.actor)) {
    return refusal('not_allowed', 'Assigning reports to someone else needs Manage Server.');
  }
  if (!isActiveStatus(report.status)) return alreadyResolved(report);

  if (assigneeId === report.targetId) {
    return refusal('invalid_request', 'A report can’t be assigned to the member it’s about.');
  }
  if (assigneeId === report.reporterId) {
    return refusal('invalid_request', 'A report can’t be assigned to the member who filed it.');
  }
  if (assigneeId === report.assigneeId) {
    return {
      ok: true,
      message:
        assigneeId === null
          ? `Report \`${report.id}\` isn’t assigned to anyone.`
          : `Report \`${report.id}\` is already assigned to <@${assigneeId}>.`,
      report,
    };
  }

  const assigned = await store.assign(ctx.guildId, report.id, assigneeId, now);
  if (!assigned) {
    const current = await store.get(ctx.guildId, report.id);
    return current ? alreadyResolved(current) : notFound(report.id);
  }

  await recordReportEvent(store, assigned, 'assigned', {
    key: assigned.version,
    actorId: actor.id,
    source: actor.source,
    data: { assigneeId, previousAssigneeId: report.assigneeId },
    at: now,
  });
  await refreshQuietly(ctx, deps, assigned, now);

  return {
    ok: true,
    message:
      assigneeId === null
        ? `Report \`${report.id}\` is unassigned and open again.`
        : `Assigned report \`${report.id}\` to <@${assigneeId}>.`,
    report: assigned,
  };
}

export async function unclaimReport(
  ctx: Ctx,
  deps: ModerationDeps,
  reportId: string,
  actor: ReviewActor,
): Promise<ReviewResult> {
  const begun = await begin(ctx, deps, reportId, actor, 'unclaim');
  if (isRefusal(begun)) return begun;
  const { store, report, now } = begun;

  if (!isActiveStatus(report.status)) return alreadyResolved(report);
  if (report.status !== 'in_review' || report.assigneeId === null) {
    return refusal('not_claimed', `Nobody has claimed report \`${report.id}\`.`);
  }

  const allowed = mayUnclaim(report, begun.actor);
  if (!allowed.ok) return refusal('not_allowed', allowed.message);

  const unclaimed = await store.unclaim(ctx.guildId, report.id, now);
  if (!unclaimed) {
    const current = await store.get(ctx.guildId, report.id);
    if (!current) return notFound(report.id);
    if (!isActiveStatus(current.status)) return alreadyResolved(current);
    return refusal('not_claimed', `Nobody has claimed report \`${report.id}\`.`);
  }

  await recordReportEvent(store, unclaimed, 'unclaimed', {
    key: unclaimed.version,
    actorId: actor.id,
    source: actor.source,
    data: { previousAssigneeId: report.assigneeId },
    at: now,
  });
  await refreshQuietly(ctx, deps, unclaimed, now);

  return {
    ok: true,
    message: `Report \`${report.id}\` is open again for anyone on staff to claim.`,
    report: unclaimed,
  };
}

function toldLine(report: ReportRecord, kind: NotificationKind): string {
  switch (report.notifications[kind]?.outcome) {
    case 'sent':
      return ' The reporter was told.';
    case 'closed':
      return ' The reporter couldn’t be told because their DMs are closed.';
    case 'no_mutual_server':
      return ' The reporter couldn’t be told because they no longer share a server with Proton.';
    case 'failed':
    case 'gave_up':
      return ' The reporter couldn’t be told because the DM didn’t go through.';
    default:
      return '';
  }
}

async function afterTail(
  ctx: Ctx,
  deps: ModerationDeps,
  store: ReportStore,
  report: ReportRecord,
  source: ReviewActor['source'],
  now: number,
): Promise<ReportRecord> {
  await runResolutionTail(ctx, deps, report, { source, now });
  return (await store.get(ctx.guildId, report.id)) ?? report;
}

export interface DismissInput {
  note?: string | null;
  reporterNote?: string | null;
  token: string;
}

function trimmed(value: string | null | undefined): string | null {
  const text = value?.trim() ?? '';
  return text === '' ? null : text;
}

async function earlierPunishment(
  ctx: Ctx,
  deps: ModerationDeps,
  reportId: string,
): Promise<{ caseId: string; kind: string } | null> {
  try {
    return (
      (await deps.ledger?.byIdempotencyKey(ctx.guildId, `${acceptRoot(reportId)}:action`)) ?? null
    );
  } catch {
    return null;
  }
}

function nounOf(kind: string): string {
  return kind in DIRECTION_NOUN ? DIRECTION_NOUN[kind as PunishKind] : kind;
}

export async function dismissReport(
  ctx: Ctx,
  deps: ModerationDeps,
  reportId: string,
  actor: ReviewActor,
  input: DismissInput,
): Promise<ReviewResult> {
  const begun = await begin(ctx, deps, reportId, actor, 'dismiss');
  if (isRefusal(begun)) return begun;
  const { store, report, now } = begun;

  const decision = await store.beginDecision({
    guildId: ctx.guildId,
    id: report.id,
    token: input.token,
    kind: 'dismiss',
    now,
    staleMs: DECISION_STALE_MS,
  });

  if (decision.state === 'missing' || !decision.report) return notFound(report.id);
  if (decision.state === 'held_by_other') {
    return refusal('deciding', deciding(decision.report.decision.kind));
  }

  if (decision.state === 'resolved') {
    if (!decision.mine || decision.report.status !== 'dismissed') {
      return alreadyResolved(decision.report);
    }
    const replayed = await afterTail(ctx, deps, store, decision.report, actor.source, now);
    return {
      ok: true,
      message: `Dismissed report \`${report.id}\`.${toldLine(replayed, 'dismissed')}`,
      report: replayed,
    };
  }

  const earlier = await earlierPunishment(ctx, deps, report.id);
  if (earlier) {
    await store.linkCase(ctx.guildId, report.id, earlier.caseId);
    await recordReportEvent(store, report, 'action_executed', {
      key: earlier.caseId,
      actorId: null,
      source: 'system',
      data: { kind: earlier.kind, caseId: earlier.caseId },
      at: now,
    });
    await store.releaseDecision(ctx.guildId, report.id, input.token);
    return refusal(
      'already_punished',
      `A ${nounOf(earlier.kind)} already went through for this report, so accept it instead.`,
    );
  }

  const resolved = await store.resolve({
    guildId: ctx.guildId,
    id: report.id,
    status: 'dismissed',
    by: actor.id,
    at: now,
    note: trimmed(input.note),
    reporterNote: trimmed(input.reporterNote),
    actionKind: null,
    caseIds: [],
    token: input.token,
    evidenceExpiresAt: now + EVIDENCE_RESOLVED_TTL_MS,
    close: closeFor(ctx.config, 'dismissed', now),
  });

  if (!resolved) {
    const current = await store.get(ctx.guildId, report.id);
    if (!current) return notFound(report.id);
    if (!isActiveStatus(current.status)) return alreadyResolved(current);
    return refusal('deciding', deciding(current.decision.kind));
  }

  await recordReportEvent(store, resolved, 'dismissed', {
    key: 'decision',
    actorId: actor.id,
    source: actor.source,
    data: {
      internalNote: resolved.resolutionNote !== null,
      reporterNote: resolved.reporterNote !== null,
    },
    at: now,
  });

  const after = await afterTail(ctx, deps, store, resolved, actor.source, now);
  return {
    ok: true,
    message: `Dismissed report \`${report.id}\`.${toldLine(after, 'dismissed')}`,
    report: after,
  };
}

function attachmentOf(meta: {
  id: string;
  filename: string;
  contentType: string | null;
  size: number;
  url: string;
  expiresAt: number | null;
}): ResolvedAttachment {
  return {
    id: meta.id,
    filename: meta.filename,
    contentType: meta.contentType,
    size: meta.size,
    url: meta.url,
    proxyUrl: null,
    width: null,
    height: null,
    ephemeral: false,
    expiresAt: meta.expiresAt,
  };
}

export function proofOf(report: ReportRecord): ProofMessage | null {
  const channelId = report.sourceChannelId;
  const messageId = report.sourceMessageId;
  if (!channelId || !messageId) return null;

  const message = report.evidence.message;
  const snapshot = message?.status === 'captured' ? message.snapshot : null;

  return {
    channelId,
    messageId,
    authorId: snapshot?.authorId ?? report.sourceAuthorId ?? report.targetId,
    content: snapshot?.content ?? '',
    createdAt: snapshot?.createdAt ?? null,
    attachments: (snapshot?.attachments ?? []).map(attachmentOf),
    url: messageUrl(report.guildId, channelId, messageId),
  };
}

function hasSnapshot(report: ReportRecord): boolean {
  return report.evidence.message?.status === 'captured';
}

const STATE_UNAVAILABLE =
  'Couldn’t check that you can delete that message, because this server’s roles and channels ' +
  'haven’t loaded yet. Nothing was done. Try again in a moment.';

async function removeReportedMessage(
  ctx: Ctx,
  deps: ModerationDeps,
  store: ReportStore,
  input: {
    report: ReportRecord;
    actor: ReviewActor;
    proof: ProofMessage;
    root: string;
    token: string;
    now: number;
  },
): Promise<{ ok: true; summary: string } | { ok: false; refusal: Refusal }> {
  const { report, actor, proof } = input;

  const failed = async (code: string, message: string) => {
    await recordReportEvent(store, report, 'action_failed', {
      key: input.token,
      actorId: actor.id,
      source: actor.source,
      data: { kind: 'delete_message', code, message },
      at: input.now,
    });
    return { ok: false as const, refusal: refusal(code, `${message}\n\n${STILL_OPEN}`) };
  };

  if (actor.owner !== true) {
    const state = await readState(deps, ctx.guildId);
    if (!state) return failed('guild_state_unavailable', STATE_UNAVAILABLE);

    const deleter = { id: actor.id, roleIds: actor.roleIds, permissions: actor.permissions };
    if (!canDeleteIn(state, { ...deleter, kind: 'member' }, proof.channelId)) {
      return failed(
        'proof_permission',
        `You need Manage Messages in <#${proof.channelId}> to delete that message, so nothing ` +
          'was done. Keep the message instead, or ask someone who can delete it.',
      );
    }
  }

  const deleted = await deleteProof(ctx, { proof, root: `${input.root}:none`, actorId: actor.id });
  if (!deleted.deleted) return failed('delete_failed', deleted.outcome.message);

  await recordReportEvent(store, report, 'action_executed', {
    key: 'delete_message',
    actorId: actor.id,
    source: actor.source,
    data: { kind: 'delete_message' },
    at: input.now,
  });

  return {
    ok: true,
    summary:
      deleted.outcome.status === 'skipped'
        ? `Accepted report \`${report.id}\` without a punishment. The reported message was already gone.`
        : `Accepted report \`${report.id}\` without a punishment and deleted the reported message.`,
  };
}

export async function acceptReport(
  ctx: Ctx,
  deps: ModerationDeps,
  request: ReportAcceptRequest,
): Promise<ReviewResult> {
  const begun = await begin(ctx, deps, request.reportId, request.actor, 'accept');
  if (isRefusal(begun)) return begun;
  const { store, report, now, actor } = begun;
  const root = acceptRoot(report.id);

  const decision = await store.beginDecision({
    guildId: ctx.guildId,
    id: report.id,
    token: request.token,
    kind: request.punishment,
    now,
    staleMs: DECISION_STALE_MS,
  });

  if (decision.state === 'missing' || !decision.report) return notFound(report.id);
  if (decision.state === 'held_by_other') {
    return refusal('deciding', deciding(decision.report.decision.kind));
  }

  if (decision.state === 'resolved') {
    if (!decision.mine || decision.report.status !== 'accepted') {
      return alreadyResolved(decision.report);
    }
    const replayed = await afterTail(ctx, deps, store, decision.report, actor.source, now);
    const caseId = replayed.caseIds[0];
    return {
      ok: true,
      message: `Report \`${report.id}\` was accepted.${toldLine(replayed, 'accepted')}`,
      report: replayed,
      ...(caseId ? { caseId } : {}),
    };
  }

  const finish = async (
    kind: string | null,
    caseId: string | null,
    summary: string,
  ): Promise<ReviewResult> => {
    if (caseId !== null) {
      await recordReportEvent(store, report, 'action_executed', {
        key: caseId,
        actorId: actor.id,
        source: actor.source,
        data: { kind, caseId },
        at: now,
      });
    }

    const resolved = await store.resolve({
      guildId: ctx.guildId,
      id: report.id,
      status: 'accepted',
      by: actor.id,
      at: now,
      note: trimmed(request.note),
      reporterNote: trimmed(request.reporterNote),
      actionKind: kind,
      caseIds: caseId === null ? [] : [caseId],
      token: request.token,
      evidenceExpiresAt: now + EVIDENCE_RESOLVED_TTL_MS,
      close: closeFor(ctx.config, 'accepted', now),
    });

    if (!resolved) {
      const linked = caseId === null ? null : await store.linkCase(ctx.guildId, report.id, caseId);
      const current = linked ?? (await store.get(ctx.guildId, report.id)) ?? report;
      const where = isActiveStatus(current.status)
        ? 'another decision on it is in progress'
        : `it was already ${current.status} by ${actorMention(current.resolvedBy)}`;

      return {
        ok: true,
        message:
          `${summary}\n\nReport \`${report.id}\` wasn’t marked accepted because ${where}` +
          (caseId === null ? '.' : ', but the case was linked to it.'),
        report: current,
        ...(caseId === null ? {} : { caseId }),
      };
    }

    await recordReportEvent(store, resolved, 'accepted', {
      key: 'decision',
      actorId: actor.id,
      source: actor.source,
      data: { kind, caseIds: resolved.caseIds, internalNote: resolved.resolutionNote !== null },
      at: now,
    });

    const after = await afterTail(ctx, deps, store, resolved, actor.source, now);
    return {
      ok: true,
      message: `${summary}\nReport \`${report.id}\` accepted.${toldLine(after, 'accepted')}`,
      report: after,
      ...(caseId === null ? {} : { caseId }),
    };
  };

  // Every entry, not only a stale takeover: a refused dismiss releases the decision it took over.
  const earlier = await earlierPunishment(ctx, deps, report.id);
  if (earlier) {
    return finish(
      earlier.kind,
      earlier.caseId,
      `The earlier ${nounOf(earlier.kind)} already went through.`,
    );
  }

  if (request.punishment === 'none') {
    const proof = request.deleteMessage ? proofOf(report) : null;
    if (proof === null) {
      return finish(null, null, `Accepted report \`${report.id}\` without a punishment.`);
    }

    const removed = await removeReportedMessage(ctx, deps, store, {
      report,
      actor,
      proof,
      root,
      token: request.token,
      now,
    });
    if (!removed.ok) {
      await store.releaseDecision(ctx.guildId, report.id, request.token);
      return removed.refusal;
    }

    return finish(null, null, removed.summary);
  }

  const kind = request.punishment;
  const proof = request.deleteMessage || hasSnapshot(report) ? proofOf(report) : null;

  const outcome = await punish(ctx, deps, {
    guildId: ctx.guildId,
    kind,
    targetId: report.targetId,
    actor: { id: actor.id, roleIds: actor.roleIds, permissions: actor.permissions, kind: 'member' },
    ...(request.reason !== undefined ? { reason: request.reason } : {}),
    ...(request.duration !== undefined ? { duration: request.duration } : {}),
    ...(proof ? { proof, deleteProof: request.deleteMessage } : {}),
    origin: { type: 'report', reportId: report.id },
    ...(request.confirmRecentCase ? { confirmedRecentCase: true } : {}),
    ...(report.sourceChannelId ? { channelId: report.sourceChannelId } : {}),
    idempotencyRoot: root,
    dmRoot: `${root}:${request.token}`,
  });

  switch (outcome.status) {
    case 'executed':
      return finish(kind, outcome.caseId, outcome.summary);

    case 'duplicate':
      return refusal('duplicate', stillSettling(report.id, kind, report.targetId));

    case 'needs_confirmation':
      await store.releaseDecision(ctx.guildId, report.id, request.token);
      return {
        ok: false,
        code: outcome.code,
        message: outcome.message,
        needsConfirmation: 'recent_case',
      };

    case 'refused':
    case 'failed': {
      await store.releaseDecision(ctx.guildId, report.id, request.token);
      const limited = outcome.code === 'discord_429';
      const message = limited ? RATE_LIMITED : outcome.message;

      await recordReportEvent(store, report, 'action_failed', {
        key: request.token,
        actorId: actor.id,
        source: actor.source,
        data: { kind, code: outcome.code, message },
        at: now,
      });

      return refusal(outcome.code, limited ? message : `${message}\n\n${STILL_OPEN}`);
    }
  }
}

type PostAgain = 'retry_delivery' | 'repost';

async function postAgain(
  ctx: Ctx,
  deps: ModerationDeps,
  reportId: string,
  actor: ReviewActor,
  token: string,
  action: PostAgain,
): Promise<ReviewResult> {
  const begun = await begin(ctx, deps, reportId, actor, action);
  if (isRefusal(begun)) return begun;
  const { store, report, now } = begun;
  const card = report.card;

  if (report.close.closedAt !== null || ['closing', 'moved', 'deleted'].includes(card.state)) {
    return refusal(
      'closed',
      `Report \`${report.id}\` was already closed, so its card isn’t posted again.`,
    );
  }
  if (card.state === 'posted') {
    return refusal(
      'already_posted',
      `The card for report \`${report.id}\` is already posted${
        card.channelId ? ` in <#${card.channelId}>` : ''
      }.`,
    );
  }

  const result = await deliverCard(ctx, deps, report, {
    source: actor.source,
    actorId: actor.id,
    now,
    firstPost: card.messageId === null,
    key: cardKey(report.id, `repost:${token}`),
  });

  switch (result.status) {
    case 'posted':
      if (action === 'repost') {
        await recordReportEvent(store, report, 'reposted', {
          key: token,
          actorId: actor.id,
          source: actor.source,
          data: { channelId: result.channelId, messageId: result.messageId },
          at: now,
        });
      }
      return {
        ok: true,
        message: `Posted the card for report \`${report.id}\` in <#${result.channelId}>.`,
        report: result.report,
      };
    case 'pending':
      return refusal('discord_429', RATE_LIMITED);
    case 'failed':
      return refusal(
        'delivery_failed',
        `The card for report \`${report.id}\` couldn’t be posted: ${result.reason}`,
      );
    case 'skipped':
      return refusal('in_progress', result.reason);
  }
}

export function retryDelivery(
  ctx: Ctx,
  deps: ModerationDeps,
  reportId: string,
  actor: ReviewActor,
  token: string,
): Promise<ReviewResult> {
  return postAgain(ctx, deps, reportId, actor, token, 'retry_delivery');
}

export function repostCard(
  ctx: Ctx,
  deps: ModerationDeps,
  reportId: string,
  actor: ReviewActor,
  token: string,
): Promise<ReviewResult> {
  return postAgain(ctx, deps, reportId, actor, token, 'repost');
}
