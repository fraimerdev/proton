import {
  type ActionResult,
  type EventListener,
  type GuildState,
  type ModuleContext,
  moderationReportSubmittedSchema,
  tryParseDuration,
} from '@proton/core';
import { describeError } from '@proton/db';
import type { ModerationConfig } from '../config.ts';
import type { ModerationDeps } from '../deps.ts';
import { MODULE_ID } from '../perform.ts';
import {
  buildReportCard,
  type CardTarget,
  cardPings,
  type ReportCardView,
  STATS_WINDOW_DAYS,
  toReportCardMessage,
} from './card.ts';
import { REPORTS_ACTOR } from './direct.ts';
import { canReadHistory } from './evidence.ts';
import { notifyReporter } from './notify.ts';
import { CARD_ATTEMPTS_MAX, type ReportStore } from './store.ts';
import { reportMethodName } from './surfaces.ts';
import {
  type CloseAction,
  isActiveStatus,
  type ReportEventKind,
  type ReportEventSource,
  type ReportRecord,
  type ResolvedReportStatus,
} from './types.ts';

export { CLOSE_ATTEMPTS_MAX } from './store.ts';

type Ctx = ModuleContext<ModerationConfig>;

export const REPORT_CLOSE_JOB = 'moderation.report-close';
export const PATROL_BATCH = 10;
export const CLOSE_STALE_MS = 10 * 60_000;

export const CARD_LOCK_TTL_MS = 15_000;
const CARD_LOCK_TRIES = 8;
const CARD_LOCK_WAIT_MS = 150;
const CARD_RENDERS_MAX = 3;

const DAY_MS = 24 * 60 * 60 * 1000;

export const RATE_LIMITED =
  'Discord is rate-limiting Proton right now, so nothing was changed. Try again in a minute.';

export const NO_REPORT_CHANNEL =
  'No report channel is set, so Proton had nowhere to post the report. Pick one in the Proton ' +
  'dashboard under Moderation → User reports.';

export type DeliveryResult =
  | { status: 'posted'; channelId: string; messageId: string; report: ReportRecord }
  | { status: 'pending'; reason: string }
  | { status: 'failed'; reason: string }
  | { status: 'skipped'; reason: string };

export interface DeliveryOptions {
  source: ReportEventSource;
  actorId?: string | null;
  now: number;
  firstPost?: boolean;
  key?: string;
  expectFirst?: boolean;
}

export function cardKey(reportId: string, suffix: string | number): string {
  return `moderation:report:${reportId}:card:${suffix}`;
}

export function idOf(result: ActionResult): string | null {
  const id = (result.body as { id?: unknown } | undefined)?.id;
  return typeof id === 'string' ? id : null;
}

export async function readState(deps: ModerationDeps, guildId: string): Promise<GuildState | null> {
  try {
    return (await deps.guildState?.get(guildId)) ?? null;
  } catch {
    return null;
  }
}

export async function recordReportEvent(
  store: ReportStore,
  report: Pick<ReportRecord, 'id' | 'guildId'>,
  kind: ReportEventKind,
  input: {
    key: string | number;
    actorId?: string | null;
    source: ReportEventSource;
    data?: Record<string, unknown>;
    at: number;
  },
): Promise<void> {
  await store.recordEvent({
    id: `${report.id}:${kind}:${input.key}`,
    reportId: report.id,
    guildId: report.guildId,
    kind,
    actorId: input.actorId ?? null,
    source: input.source,
    ...(input.data ? { data: input.data } : {}),
    at: input.at,
  });
}

async function targetOf(deps: ModerationDeps, guildId: string, targetId: string) {
  const target: CardTarget = { username: null, membership: 'unknown', joinedAt: null };

  try {
    target.username =
      (await deps.users?.resolve(targetId))?.username ??
      (await deps.placeholders?.user(targetId))?.username ??
      null;
  } catch {
    target.username = null;
  }

  try {
    const found = await deps.lookupMember?.(guildId, targetId);
    if (found?.state === 'member') {
      target.membership = 'member';
      target.joinedAt = found.joinedAt;
    }
    if (found?.state === 'absent') target.membership = 'absent';
  } catch {
    target.membership = 'unknown';
  }

  return target;
}

export async function cardViewFor(
  ctx: Ctx,
  deps: ModerationDeps,
  report: ReportRecord,
  firstPost: boolean,
  now: number,
): Promise<ReportCardView> {
  let stats: ReportCardView['stats'] = null;
  try {
    stats =
      (await deps.reports?.targetStats(
        report.guildId,
        report.targetId,
        now - STATS_WINDOW_DAYS * DAY_MS,
      )) ?? null;
  } catch {
    stats = null;
  }

  return {
    report,
    target: await targetOf(deps, report.guildId, report.targetId),
    stats,
    statsWindowDays: STATS_WINDOW_DAYS,
    notifyRoleIds: ctx.config.reports.notifyRoleIds,
    firstPost,
    methodName: reportMethodName(ctx, report.method),
  };
}

function logContext(ctx: Ctx, report: ReportRecord) {
  return { guildId: ctx.guildId, moduleId: MODULE_ID, reportId: report.id };
}

async function forwardCopy(
  ctx: Ctx,
  deps: ModerationDeps,
  report: ReportRecord,
  channelId: string,
): Promise<boolean> {
  const store = deps.reports;
  const sourceChannel = report.sourceChannelId;
  const sourceMessage = report.sourceMessageId;
  if (!store || !ctx.config.reports.copyReportedMessage || !sourceChannel || !sourceMessage) {
    return false;
  }
  if (report.evidence.copy && 'messageId' in report.evidence.copy) return false;

  const refuse = async (failed: string): Promise<boolean> => {
    await store.rememberEvidenceCopy(ctx.guildId, report.id, { failed });
    return true;
  };

  const message = report.evidence.message;
  if (message?.status === 'unavailable' && message.reason === 'deleted') {
    return refuse(
      'The message was already deleted when it was reported, so there was nothing to forward.',
    );
  }

  const state = await readState(deps, ctx.guildId);
  if (
    state?.channels.has(sourceChannel) &&
    !canReadHistory(state, deps.botUserId ?? '', state.botRoleIds, sourceChannel, { bot: true })
  ) {
    return refuse(
      `Proton needs View Channel and Read Message History in <#${sourceChannel}> to forward the ` +
        'reported message here.',
    );
  }

  const result = await ctx.executor.execute({
    guildId: ctx.guildId,
    moduleId: MODULE_ID,
    kind: 'send',
    actorId: REPORTS_ACTOR,
    idempotencyKey: `moderation:report:${report.id}:copy`,
    dryRun: false,
    record: false,
    payload: { channelId, forward: { channelId: sourceChannel, messageId: sourceMessage } },
  });

  const copyId = idOf(result);
  if (copyId) {
    await store.rememberEvidenceCopy(ctx.guildId, report.id, { channelId, messageId: copyId });
    return true;
  }
  if (result.status === 'skipped_duplicate') return false;

  return refuse(
    `Discord refused to forward it: ${result.failure?.humanReason ?? 'Discord gave no reason.'}`,
  );
}

export async function deliverCard(
  ctx: Ctx,
  deps: ModerationDeps,
  report: ReportRecord,
  options: DeliveryOptions,
): Promise<DeliveryResult> {
  const store = deps.reports;
  if (!store) return { status: 'skipped', reason: 'User reports aren’t available right now.' };

  const { now, source } = options;
  const channelId = ctx.config.reports.channelId;

  if (!channelId) {
    await store.markCard(ctx.guildId, report.id, 'failed', { error: NO_REPORT_CHANNEL });
    await recordReportEvent(store, report, 'delivery_failed', {
      key: `no-channel:${report.card.attempts}`,
      actorId: options.actorId ?? null,
      source,
      data: { code: 'no_channel' },
      at: now,
    });
    return { status: 'failed', reason: NO_REPORT_CHANNEL };
  }

  const attempt = await store.noteCardAttempt(ctx.guildId, report.id);
  if (options.expectFirst && attempt !== 1) {
    return { status: 'skipped', reason: 'Another delivery of this card is under way.' };
  }

  const pinging = (options.firstPost ?? true) && isActiveStatus(report.status);
  const view = await cardViewFor(ctx, deps, report, pinging, now);
  const body = toReportCardMessage(
    buildReportCard(view),
    report.id,
    cardPings(view),
    new Date(now),
  );

  const result = await ctx.executor.execute({
    guildId: ctx.guildId,
    moduleId: MODULE_ID,
    kind: 'send',
    actorId: REPORTS_ACTOR,
    idempotencyKey: options.key ?? cardKey(report.id, attempt),
    dryRun: false,
    record: false,
    payload: { channelId, ...body },
  });

  const messageId = idOf(result);

  if (messageId) {
    const posted =
      (await store.rememberCard(ctx.guildId, report.id, { channelId, messageId })) ?? report;
    await store.markCardVersion(ctx.guildId, report.id, report.version);
    await recordReportEvent(store, report, 'delivered', {
      key: messageId,
      actorId: options.actorId ?? null,
      source,
      data: { channelId, messageId, attempt },
      at: now,
    });

    if (await forwardCopy(ctx, deps, posted, channelId)) {
      await store.bumpVersion(ctx.guildId, report.id);
    }

    const current = await store.get(ctx.guildId, report.id);
    if (current) await refreshCard(ctx, deps, current, now);

    return {
      status: 'posted',
      channelId,
      messageId,
      report: (await store.get(ctx.guildId, report.id)) ?? posted,
    };
  }

  if (result.status === 'skipped_duplicate') {
    return { status: 'skipped', reason: 'This card is already being posted.' };
  }

  const code = result.failure?.code ?? result.status;
  const reason = result.failure?.humanReason ?? 'Discord gave no reason.';
  const limited = code === 'discord_429';
  const waiting = limited && attempt < CARD_ATTEMPTS_MAX;

  await store.markCard(ctx.guildId, report.id, waiting ? 'pending' : 'failed', { error: reason });
  await recordReportEvent(store, report, 'delivery_failed', {
    key: attempt,
    actorId: options.actorId ?? null,
    source,
    data: { code, attempt },
    at: now,
  });

  ctx.logger.warn(
    `report ${report.id}: the staff card could not be posted in <#${channelId}>: ${reason}`,
    { ...logContext(ctx, report), code },
  );

  return limited ? { status: 'pending', reason: RATE_LIMITED } : { status: 'failed', reason };
}

export type RefreshResult = 'edited' | 'current' | 'skipped' | 'missing' | 'failed';

export function cardLockKey(guildId: string, reportId: string): string {
  return `report:${guildId}:${reportId}:card-lock`;
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function lockCard(
  ctx: Ctx,
  deps: ModerationDeps,
  report: ReportRecord,
): Promise<{ held: boolean; release: () => Promise<void> }> {
  const drafts = deps.drafts;
  const unlocked = { held: true, release: async () => undefined };
  if (!drafts) return unlocked;

  const key = cardLockKey(ctx.guildId, report.id);
  const token = crypto.randomUUID();

  try {
    for (let attempt = 0; attempt < CARD_LOCK_TRIES; attempt += 1) {
      if (await drafts.lock(key, token, CARD_LOCK_TTL_MS)) {
        return { held: true, release: () => drafts.unlock(key, token).catch(() => undefined) };
      }
      await pause(CARD_LOCK_WAIT_MS);
    }
  } catch (error) {
    ctx.logger.warn(
      `report ${report.id}: the staff card lock could not be read, so the card is updated ` +
        `without it: ${describeError(error)}`,
      logContext(ctx, report),
    );
    return unlocked;
  }

  return { held: false, release: async () => undefined };
}

export async function refreshCard(
  ctx: Ctx,
  deps: ModerationDeps,
  report: ReportRecord,
  now: number,
): Promise<RefreshResult> {
  const store = deps.reports;
  const { channelId, messageId, state } = report.card;
  if (!store || state !== 'posted' || !channelId || !messageId) return 'skipped';
  if (report.card.version >= report.version) return 'current';

  // The holder re-reads after editing, so a caller that finds the lock taken leaves it the edit.
  const lock = await lockCard(ctx, deps, report);
  if (!lock.held) return 'skipped';

  try {
    let result: RefreshResult = 'current';

    for (let pass = 0; pass < CARD_RENDERS_MAX; pass += 1) {
      const current = await store.get(ctx.guildId, report.id);
      if (!current) return 'skipped';

      const outcome = await editCard(ctx, deps, store, current, now);
      if (outcome !== 'edited') return outcome === 'current' ? result : outcome;
      result = 'edited';
    }

    return result;
  } finally {
    await lock.release();
  }
}

async function editCard(
  ctx: Ctx,
  deps: ModerationDeps,
  store: ReportStore,
  report: ReportRecord,
  now: number,
): Promise<RefreshResult> {
  const { channelId, messageId, state } = report.card;
  if (state !== 'posted' || !channelId || !messageId) return 'skipped';
  if (report.card.version >= report.version) return 'current';

  const view = await cardViewFor(ctx, deps, report, false, now);
  const { content: _kept, ...body } = toReportCardMessage(
    buildReportCard(view),
    report.id,
    [],
    new Date(now),
  );

  const result = await ctx.executor.execute({
    guildId: ctx.guildId,
    moduleId: MODULE_ID,
    kind: 'edit_message',
    actorId: REPORTS_ACTOR,
    idempotencyKey: cardKey(report.id, `v${report.version}`),
    dryRun: false,
    record: false,
    payload: { channelId, messageId, ...body, allowedMentions: { parse: [] } },
  });

  if (result.status === 'executed' || result.status === 'skipped_duplicate') {
    await store.markCardVersion(ctx.guildId, report.id, report.version);
    return 'edited';
  }

  if (result.failure?.code === 'discord_404') {
    const missing = await store.markCard(ctx.guildId, report.id, 'missing', { messageId });
    if (missing) {
      await recordReportEvent(store, report, 'card_missing', {
        key: messageId,
        source: 'system',
        data: { channelId, messageId },
        at: now,
      });
    }
    return 'missing';
  }

  await store.noteCardEditFailure(ctx.guildId, report.id);
  ctx.logger.warn(
    `report ${report.id}: the staff card in <#${channelId}> could not be updated: ` +
      `${result.failure?.humanReason ?? 'Discord gave no reason.'}`,
    { ...logContext(ctx, report), code: result.failure?.code },
  );
  return 'failed';
}

export async function handleCardDeleted(
  store: ReportStore,
  guildId: string,
  channelId: string,
  messageId: string,
  now: number,
): Promise<ReportRecord | null> {
  const report = await store.byCardMessage(guildId, messageId);
  if (!report || report.card.channelId !== channelId) return null;

  const missing = await store.markCard(guildId, report.id, 'missing', { messageId });
  if (!missing) return null;

  await recordReportEvent(store, report, 'card_missing', {
    key: messageId,
    source: 'system',
    data: { channelId, messageId },
    at: now,
  });

  return missing;
}

export function closeFor(
  config: ModerationConfig,
  status: ResolvedReportStatus,
  now: number,
): { action: CloseAction | null; dueAt: number | null } {
  const closing = config.reports.closing[status];
  if (closing.mode === 'keep') return { action: null, dueAt: null };

  const delay = closing.delay === null ? 0 : (tryParseDuration(closing.delay) ?? 0);
  return { action: closing.mode, dueAt: now + Math.max(0, delay) };
}

export async function armClose(ctx: Ctx, report: ReportRecord, replace: boolean): Promise<void> {
  const { action, closedAt, dueAt } = report.close;
  if (action === null || closedAt !== null || dueAt === null) return;

  if (!ctx.schedule) {
    ctx.logger.warn(
      `report ${report.id}: closing could not be booked from here; the reports patrol will book it.`,
      logContext(ctx, report),
    );
    return;
  }

  await ctx.schedule(
    REPORT_CLOSE_JOB,
    new Date(dueAt),
    report.id,
    { reportId: report.id },
    replace ? { replace: true } : undefined,
  );
}

async function announceResolved(ctx: Ctx, report: ReportRecord): Promise<void> {
  if (report.status !== 'accepted' && report.status !== 'dismissed') return;
  if (!ctx.publish) return;

  await ctx.publish('moderation.report_resolved', report.id, {
    guildId: report.guildId,
    reportId: report.id,
    number: report.number,
    targetId: report.targetId,
    reporterId: report.reporterId,
    status: report.status,
    resolvedBy: report.resolvedBy ?? REPORTS_ACTOR,
    actionKind: report.actionKind,
    caseIds: report.caseIds,
    resolvedAt: report.resolvedAt ?? report.updatedAt,
  });
}

export async function runResolutionTail(
  ctx: Ctx,
  deps: ModerationDeps,
  report: ReportRecord,
  input: { source: ReportEventSource; now: number; announce?: boolean },
): Promise<void> {
  if (report.status !== 'accepted' && report.status !== 'dismissed') return;
  const status = report.status;
  const told = { source: input.source, now: input.now };

  const steps: Array<[string, () => Promise<unknown>]> = [
    ['update the staff card', () => refreshCard(ctx, deps, report, input.now)],
    ['tell the reporter', () => notifyReporter(ctx, deps, report, status, told)],
    ['book closing', () => armClose(ctx, report, true)],
  ];
  if (input.announce !== false) {
    steps.push(['announce the decision', () => announceResolved(ctx, report)]);
  }

  for (const [what, step] of steps) {
    try {
      await step();
    } catch (error) {
      ctx.logger.error(
        `report ${report.id} was ${status}, but Proton could not ${what} yet: ` +
          `${describeError(error)}. The reports patrol retries.`,
        logContext(ctx, report),
      );
    }
  }
}

export async function runDeliveryPatrol(ctx: Ctx, deps: ModerationDeps, now: number) {
  const store = deps.reports;
  if (!ctx.config.enabled || !store) return;

  for (const report of await store.deliveryBacklog(ctx.guildId, now, PATROL_BATCH)) {
    await deliverCard(ctx, deps, report, { source: 'system', now, firstPost: true });
  }

  for (const report of await store.unfinishedResolutions(ctx.guildId, PATROL_BATCH)) {
    // Only an unrecorded notification means the tail never ran; re-announcing logs it twice.
    const status =
      report.status === 'accepted' || report.status === 'dismissed' ? report.status : null;
    await runResolutionTail(ctx, deps, report, {
      source: 'system',
      now,
      announce: status !== null && report.notifications[status] === undefined,
    });
  }

  for (const report of await store.dueCloses(ctx.guildId, now, PATROL_BATCH)) {
    const stale = report.updatedAt < now - CLOSE_STALE_MS;
    await armClose(ctx, { ...report, close: { ...report.close, dueAt: now } }, stale);
  }
}

export function createReportSubmittedListener(
  deps: ModerationDeps,
): EventListener<ModerationConfig> {
  return {
    types: ['moderation.report_submitted'],
    async handler(event, ctx) {
      if (!ctx.config.enabled) return;

      const parsed = moderationReportSubmittedSchema.safeParse(event.payload);
      if (!parsed.success || parsed.data.guildId !== ctx.guildId) return;

      const store = deps.reports;
      if (!store) {
        ctx.logger.error(
          `report ${parsed.data.reportId} was filed but report storage is not connected here, ` +
            'so its staff card could not be posted.',
          { guildId: ctx.guildId, moduleId: MODULE_ID },
        );
        return;
      }

      const report = await store.get(ctx.guildId, parsed.data.reportId);
      if (!report) return;

      const now = deps.now?.() ?? Date.now();

      if (report.card.state === 'pending' && report.card.attempts === 0) {
        await deliverCard(ctx, deps, report, {
          source: 'system',
          now,
          firstPost: true,
          expectFirst: true,
        });
      }

      const current = (await store.get(ctx.guildId, report.id)) ?? report;
      await notifyReporter(ctx, deps, current, 'submitted', { source: 'system', now });
    },
  };
}
