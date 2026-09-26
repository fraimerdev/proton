import type { ModuleContext, ScheduledHandler } from '@proton/core';
import { z } from 'zod';
import type { ModerationConfig } from '../config.ts';
import type { ModerationDeps } from '../deps.ts';
import { MODULE_ID } from '../perform.ts';
import { buildReportCard, toReportCardMessage } from './card.ts';
import { armClose, cardViewFor, idOf, recordReportEvent } from './delivery.ts';
import { REPORTS_ACTOR } from './direct.ts';
import { type CardRefs, CLOSE_ATTEMPTS_MAX, closeBackoffMs, type ReportStore } from './store.ts';
import type { ReportRecord } from './types.ts';

type Ctx = ModuleContext<ModerationConfig>;

export const reportCloseSchema = z.object({ reportId: z.string().min(1).max(32) });

const TRANSIENT = /^(discord_(429|5\d\d)|transport_failure|skipped_duplicate)$/;

function closeKey(reportId: string, step: string): string {
  return `moderation:report:${reportId}:${step}`;
}

type Target = { channelId: string; messageId: string };

type Deleted = { ok: true } | { ok: false; code: string; reason: string; partial: boolean };

async function failClose(
  ctx: Ctx,
  store: ReportStore,
  report: ReportRecord,
  input: { attempt: number; code: string; reason: string; now: number; retry: boolean },
): Promise<void> {
  await store.markCloseFailed(ctx.guildId, report.id, input.reason);
  await recordReportEvent(store, report, 'close_failed', {
    key: input.attempt,
    source: 'system',
    data: { code: input.code, attempt: input.attempt, message: input.reason },
    at: input.now,
  });

  ctx.logger.warn(`report ${report.id} could not be closed: ${input.reason}`, {
    guildId: ctx.guildId,
    moduleId: MODULE_ID,
    reportId: report.id,
    code: input.code,
  });

  const action = report.close.action;
  if (!input.retry || action === null) return;

  const dueAt = input.now + closeBackoffMs(input.attempt);
  await store.scheduleClose(ctx.guildId, report.id, action, dueAt);
  await armClose(ctx, { ...report, close: { ...report.close, dueAt } }, true);
}

async function deleteMessage(
  ctx: Ctx,
  input: Target & { key: string },
): Promise<{ ok: true } | { ok: false; code: string; reason: string }> {
  const result = await ctx.executor.execute({
    guildId: ctx.guildId,
    moduleId: MODULE_ID,
    kind: 'delete_message',
    actorId: REPORTS_ACTOR,
    idempotencyKey: input.key,
    dryRun: false,
    record: false,
    payload: { channelId: input.channelId, messageId: input.messageId },
  });

  const code = result.failure?.code ?? result.status;
  if (result.status === 'executed' || result.status === 'skipped_duplicate') return { ok: true };
  if (code === 'discord_404') return { ok: true };

  return {
    ok: false,
    code,
    reason: result.failure?.humanReason ?? 'Discord gave no reason.',
  };
}

function copyOf(report: ReportRecord): Target | null {
  const copy = report.evidence.copy;
  return copy && 'messageId' in copy
    ? { channelId: copy.channelId, messageId: copy.messageId }
    : null;
}

async function deleteOriginals(
  ctx: Ctx,
  report: ReportRecord,
  options: { keepCopy?: boolean } = {},
): Promise<Deleted> {
  const { channelId, messageId } = report.card;
  const copy = options.keepCopy ? null : copyOf(report);

  const targets = [
    ...(channelId && messageId && report.card.state !== 'missing'
      ? [{ channelId, messageId, key: closeKey(report.id, 'close:card') }]
      : []),
    ...(copy ? [{ ...copy, key: closeKey(report.id, 'close:copy') }] : []),
  ];

  for (const [index, target] of targets.entries()) {
    const deleted = await deleteMessage(ctx, target);
    if (!deleted.ok) return { ...deleted, partial: index > 0 };
  }

  return { ok: true };
}

async function undoArchive(
  ctx: Ctx,
  report: ReportRecord,
  attempt: number,
  posted: { card: Target; copy: Target | null },
): Promise<void> {
  const undone = [
    { ...posted.card, key: closeKey(report.id, `archive-undo:${attempt}`) },
    ...(posted.copy
      ? [{ ...posted.copy, key: closeKey(report.id, `archive-copy-undo:${attempt}`) }]
      : []),
  ];

  for (const target of undone) {
    const deleted = await deleteMessage(ctx, target);
    if (!deleted.ok) {
      ctx.logger.warn(
        `report ${report.id}: the card Proton just posted in <#${target.channelId}> could not be ` +
          `taken back, so the next closing attempt may post it twice: ${deleted.reason}`,
        { guildId: ctx.guildId, moduleId: MODULE_ID, reportId: report.id, code: deleted.code },
      );
    }
  }
}

async function restoreCard(ctx: Ctx, store: ReportStore, report: ReportRecord): Promise<void> {
  const before = report.card.state === 'closing' ? 'posted' : report.card.state;
  if (before === 'missing') return;
  await store.markCard(ctx.guildId, report.id, before);
}

async function closeByDelete(
  ctx: Ctx,
  store: ReportStore,
  report: ReportRecord,
  attempt: number,
  now: number,
): Promise<void> {
  await store.markCard(ctx.guildId, report.id, 'closing');

  const deleted = await deleteOriginals(ctx, report);
  if (!deleted.ok) {
    await restoreCard(ctx, store, report);
    return failClose(ctx, store, report, {
      attempt,
      code: deleted.code,
      reason: deleted.reason,
      now,
      retry: true,
    });
  }

  await store.markClosed(ctx.guildId, report.id, 'deleted', now);
  await recordReportEvent(store, report, 'deleted', { key: 'close', source: 'system', at: now });
}

async function finishInterruptedMove(
  ctx: Ctx,
  store: ReportStore,
  report: ReportRecord,
  archive: string,
  now: number,
): Promise<void> {
  await store.markClosed(ctx.guildId, report.id, 'moved', now);
  await recordReportEvent(store, report, 'moved', {
    key: 'close',
    source: 'system',
    data: { channelId: archive, messageId: report.card.messageId, originalKept: true },
    at: now,
  });

  ctx.logger.warn(
    `report ${report.id} was already copied to <#${archive}> when closing was interrupted; the ` +
      'original card may still be in the report channel.',
    { guildId: ctx.guildId, moduleId: MODULE_ID, reportId: report.id },
  );
}

async function closeByMove(
  ctx: Ctx,
  deps: ModerationDeps,
  store: ReportStore,
  report: ReportRecord,
  attempt: number,
  now: number,
): Promise<void> {
  if (report.status !== 'accepted' && report.status !== 'dismissed') return;

  const archive = ctx.config.reports.closing[report.status].channelId;
  if (!archive) {
    return failClose(ctx, store, report, {
      attempt,
      code: 'no_archive_channel',
      reason:
        `No archive channel is set for ${report.status} reports, so the card stays where it is. ` +
        'Pick one in the Proton dashboard under Moderation → User reports → Settings.',
      now,
      retry: false,
    });
  }

  if (report.card.state === 'closing' && report.card.channelId === archive) {
    return finishInterruptedMove(ctx, store, report, archive, now);
  }

  const view = await cardViewFor(ctx, deps, report, false, now);
  const body = toReportCardMessage(buildReportCard(view), report.id, [], new Date(now));

  const posted = await ctx.executor.execute({
    guildId: ctx.guildId,
    moduleId: MODULE_ID,
    kind: 'send',
    actorId: REPORTS_ACTOR,
    idempotencyKey: closeKey(report.id, `archive:${attempt}`),
    dryRun: false,
    record: false,
    payload: { channelId: archive, ...body, allowedMentions: { parse: [] } },
  });

  const archiveId = idOf(posted);
  if (!archiveId) {
    const code = posted.failure?.code ?? posted.status;
    return failClose(ctx, store, report, {
      attempt,
      code,
      reason:
        `The report card couldn’t be posted in <#${archive}>, so the original stays: ` +
        `${posted.failure?.humanReason ?? 'Discord gave no reason.'}`,
      now,
      retry: TRANSIENT.test(code),
    });
  }

  const card: Target = { channelId: archive, messageId: archiveId };
  const original = copyOf(report);
  let archiveCopy: Target | null = null;
  let copyError: string | null = null;

  if (original) {
    const forwarded = await ctx.executor.execute({
      guildId: ctx.guildId,
      moduleId: MODULE_ID,
      kind: 'send',
      actorId: REPORTS_ACTOR,
      idempotencyKey: closeKey(report.id, `archive-copy:${attempt}`),
      dryRun: false,
      record: false,
      payload: { channelId: archive, forward: original },
    });

    const copyId = idOf(forwarded);
    const code = forwarded.failure?.code ?? forwarded.status;
    const reason = forwarded.failure?.humanReason ?? 'Discord gave no reason.';

    if (copyId) {
      archiveCopy = { channelId: archive, messageId: copyId };
    } else if (TRANSIENT.test(code)) {
      await undoArchive(ctx, report, attempt, { card, copy: null });
      return failClose(ctx, store, report, {
        attempt,
        code,
        reason:
          `The evidence copy couldn’t be forwarded to <#${archive}> yet, so the report stays ` +
          `where it is: ${reason}`,
        now,
        retry: true,
      });
    } else {
      copyError = reason;
      ctx.logger.warn(
        `report ${report.id}: the evidence copy could not be forwarded to <#${archive}>, so it ` +
          `stays in the report channel: ${reason}`,
        { guildId: ctx.guildId, moduleId: MODULE_ID, reportId: report.id, code },
      );
    }
  }

  const keepCopy = original !== null && archiveCopy === null;
  const moved: CardRefs = { ...card, copy: archiveCopy ?? original };
  await store.moveCard(ctx.guildId, report.id, moved, 'closing');

  const kept = keepCopy ? { copyKept: true, copyError } : {};
  const deleted = await deleteOriginals(ctx, report, { keepCopy });

  if (!deleted.ok) {
    if (TRANSIENT.test(deleted.code) && !deleted.partial) {
      await undoArchive(ctx, report, attempt, { card, copy: archiveCopy });
      await store.moveCard(
        ctx.guildId,
        report.id,
        { channelId: report.card.channelId, messageId: report.card.messageId, copy: original },
        report.card.state === 'closing' ? 'posted' : report.card.state,
      );
      return failClose(ctx, store, report, {
        attempt,
        code: deleted.code,
        reason: `The original card couldn’t be removed from the report channel yet: ${deleted.reason}`,
        now,
        retry: true,
      });
    }

    await store.markClosed(ctx.guildId, report.id, 'moved', now);
    await recordReportEvent(store, report, 'moved', {
      key: 'close',
      source: 'system',
      data: { channelId: archive, messageId: archiveId, originalKept: true, ...kept },
      at: now,
    });

    return failClose(ctx, store, report, {
      attempt,
      code: deleted.code,
      reason: `The report was copied to <#${archive}>, but the original stayed: ${deleted.reason}`,
      now,
      retry: false,
    });
  }

  await store.markClosed(ctx.guildId, report.id, 'moved', now);
  await recordReportEvent(store, report, 'moved', {
    key: 'close',
    source: 'system',
    data: { channelId: archive, messageId: archiveId, copied: archiveCopy !== null, ...kept },
    at: now,
  });
}

export async function closeReport(ctx: Ctx, deps: ModerationDeps, reportId: string): Promise<void> {
  const store = deps.reports;
  if (!store) {
    ctx.logger.error(
      `report ${reportId} is due to close but report storage is not connected here.`,
      { guildId: ctx.guildId, moduleId: MODULE_ID, reportId },
    );
    return;
  }

  const report = await store.get(ctx.guildId, reportId);
  if (!report || report.close.closedAt !== null || report.close.action === null) return;

  const now = deps.now?.() ?? Date.now();
  if (report.close.dueAt !== null && report.close.dueAt > now) {
    await armClose(ctx, report, true);
    return;
  }

  const attempt = await store.noteCloseAttempt(ctx.guildId, report.id);
  if (attempt > CLOSE_ATTEMPTS_MAX) {
    return failClose(ctx, store, report, {
      attempt,
      code: 'gave_up',
      reason: `Proton gave up closing the report after ${CLOSE_ATTEMPTS_MAX} attempts.`,
      now,
      retry: false,
    });
  }

  if (report.close.action === 'delete') return closeByDelete(ctx, store, report, attempt, now);
  return closeByMove(ctx, deps, store, report, attempt, now);
}

export function createReportCloseHandler(deps: ModerationDeps): ScheduledHandler<ModerationConfig> {
  return async (data, ctx) => {
    const parsed = reportCloseSchema.safeParse(data);
    if (!parsed.success) {
      ctx.logger.error('a report closing job carried no usable report id.', {
        guildId: ctx.guildId,
        moduleId: MODULE_ID,
      });
      return;
    }

    await closeReport(ctx, deps, parsed.data.reportId);
  };
}
