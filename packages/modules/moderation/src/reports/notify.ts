import { type ActionResult, type ModuleContext, messageUrl, toDiscordMessage } from '@proton/core';
import {
  type BotFacts,
  type ServerFacts,
  serverFactsFrom,
  type UserFacts,
} from '@proton/core/placeholders';
import type { ModerationConfig } from '../config.ts';
import type { ModerationDeps } from '../deps.ts';
import { MODULE_ID } from '../perform.ts';
import { actionName } from './card.ts';
import { REPORTS_ACTOR, undelivered } from './direct.ts';
import {
  type ReportNoticeFacts,
  renderReportNotice,
  reportMethodName,
  reportNoticeKeys,
} from './surfaces.ts';
import type {
  NotificationKind,
  NotificationOutcome,
  ReportEventSource,
  ReportRecord,
} from './types.ts';

type Ctx = ModuleContext<ModerationConfig>;

export const DM_ATTEMPTS_MAX = 5;

export function reportDmKey(reportId: string, step: string): string {
  return `moderation:report:${reportId}:dm:${step}`;
}

function idOf(result: ActionResult): string | null {
  const id = (result.body as { id?: unknown } | undefined)?.id;
  return typeof id === 'string' ? id : null;
}

function uses(keys: ReadonlySet<string>, namespace: string, beyond: readonly string[] = []) {
  return [...keys].some((key) => key.startsWith(`${namespace}.`) && !beyond.includes(key));
}

const IDENTITY_ONLY = (namespace: string) => [`${namespace}.id`, `${namespace}.mention`];

async function profileOf(
  deps: ModerationDeps,
  userId: string,
  wanted: boolean,
): Promise<UserFacts> {
  const bare: UserFacts = { id: userId, username: null, globalName: null, avatarHash: null };
  if (!wanted) return bare;

  try {
    if (deps.placeholders) return (await deps.placeholders.user(userId)) ?? bare;

    const profile = await deps.users?.resolve(userId);
    return profile
      ? {
          id: profile.id,
          username: profile.username,
          globalName: profile.globalName,
          avatarHash: profile.avatarHash,
        }
      : bare;
  } catch {
    return bare;
  }
}

async function serverOf(ctx: Ctx, deps: ModerationDeps, wanted: boolean): Promise<ServerFacts> {
  if (!wanted) return { id: ctx.guildId };

  try {
    if (deps.placeholders) return await deps.placeholders.server(ctx.guildId);
    return serverFactsFrom((await deps.guildState?.get(ctx.guildId)) ?? null, ctx.guildId);
  } catch {
    return { id: ctx.guildId };
  }
}

async function botOf(deps: ModerationDeps, wanted: boolean): Promise<BotFacts | null> {
  if (!wanted || !deps.placeholders) return null;

  try {
    return await deps.placeholders.bot();
  } catch {
    return null;
  }
}

export async function reportNoticeFacts(
  ctx: Ctx,
  deps: ModerationDeps,
  report: ReportRecord,
  kind: NotificationKind,
  keys: ReadonlySet<string>,
): Promise<ReportNoticeFacts> {
  const decided = kind !== 'submitted' && report.resolvedBy !== null;

  return {
    report: {
      id: report.id,
      number: report.number,
      status: report.status,
      method: report.method,
      methodName: reportMethodName(ctx, report.method),
      reason: report.reason,
      customReason: report.customReason,
      comment: report.comment,
      createdAt: report.createdAt,
      messageUrl:
        report.sourceChannelId && report.sourceMessageId
          ? messageUrl(report.guildId, report.sourceChannelId, report.sourceMessageId)
          : null,
      action: kind === 'accepted' ? actionName(report.actionKind) : null,
      explanation: kind === 'submitted' ? null : report.reporterNote,
    },
    user: await profileOf(deps, report.reporterId, uses(keys, 'user', IDENTITY_ONLY('user'))),
    target: await profileOf(deps, report.targetId, uses(keys, 'target', IDENTITY_ONLY('target'))),
    moderator:
      decided && report.resolvedBy
        ? await profileOf(
            deps,
            report.resolvedBy,
            uses(keys, 'moderator', IDENTITY_ONLY('moderator')),
          )
        : null,
    server: await serverOf(ctx, deps, uses(keys, 'server')),
    bot: await botOf(deps, uses(keys, 'bot')),
  };
}

async function dmChannelFor(
  ctx: Ctx,
  deps: ModerationDeps,
  report: ReportRecord,
): Promise<{ channelId: string } | { outcome: NotificationOutcome }> {
  if (report.dmChannelId) return { channelId: report.dmChannelId };

  const store = deps.reports;
  if (!store) return { outcome: 'failed' };

  const remembered = await deps.dmChannels
    ?.recall(ctx.guildId, report.reporterId)
    .catch(() => null);
  if (remembered) {
    await store.rememberDm(ctx.guildId, report.id, remembered);
    return { channelId: remembered };
  }

  const attempt = await store.noteDmAttempt(ctx.guildId, report.id);
  if (attempt > DM_ATTEMPTS_MAX) {
    ctx.logger.error(
      `report ${report.id}: Proton gave up reaching ${report.reporterId} by direct message ` +
        `after ${DM_ATTEMPTS_MAX} attempts.`,
      { guildId: ctx.guildId, moduleId: MODULE_ID, reportId: report.id },
    );
    return { outcome: 'gave_up' };
  }

  const opened = await ctx.executor.execute({
    guildId: ctx.guildId,
    moduleId: MODULE_ID,
    kind: 'create_dm',
    actorId: REPORTS_ACTOR,
    targetId: report.reporterId,
    idempotencyKey: reportDmKey(report.id, `open:${attempt}`),
    dryRun: false,
    record: false,
    payload: { userId: report.reporterId },
  });

  const channelId = idOf(opened);
  if (channelId === null) {
    return { outcome: opened.status === 'skipped_duplicate' ? 'failed' : undelivered(opened) };
  }

  await store.rememberDm(ctx.guildId, report.id, channelId);
  await deps.dmChannels?.remember(ctx.guildId, report.reporterId, channelId).catch(() => undefined);
  return { channelId };
}

export async function tellReporter(
  ctx: Ctx,
  deps: ModerationDeps,
  report: ReportRecord,
  kind: NotificationKind,
  now: number,
): Promise<NotificationOutcome> {
  const context = { guildId: ctx.guildId, moduleId: MODULE_ID, reportId: report.id };
  const message = ctx.config.reports.notifications[kind].message;
  const keys = reportNoticeKeys(kind, message);

  const rendered = renderReportNotice(
    kind,
    message,
    await reportNoticeFacts(ctx, deps, report, kind, keys),
    now,
  );
  if (!rendered.ok) {
    ctx.logger.error(
      `report ${report.id}: the ${kind} message for the reporter could not be written: ` +
        rendered.humanReason,
      context,
    );
    return 'failed';
  }

  const channel = await dmChannelFor(ctx, deps, report);
  if ('outcome' in channel) return channel.outcome;

  const { allowedMentions: _ignored, ...body } = toDiscordMessage(rendered.message, {
    customIdFor: (key) => key,
    now: new Date(now),
  });

  const sent = await ctx.executor.execute({
    guildId: ctx.guildId,
    moduleId: MODULE_ID,
    kind: 'send',
    actorId: REPORTS_ACTOR,
    targetId: report.reporterId,
    idempotencyKey: reportDmKey(report.id, kind),
    dryRun: false,
    record: false,
    payload: {
      channelId: channel.channelId,
      ...body,
      allowedMentions: { parse: [] },
      directMessage: true,
    },
  });

  if (sent.status === 'executed' || sent.status === 'skipped_duplicate') return 'sent';

  ctx.logger.warn(
    `report ${report.id}: the ${kind} message did not reach the reporter: ` +
      `${sent.failure?.humanReason ?? 'Discord gave no reason.'}`,
    context,
  );
  return undelivered(sent);
}

export async function notifyReporter(
  ctx: Ctx,
  deps: ModerationDeps,
  report: ReportRecord,
  kind: NotificationKind,
  input: { source: ReportEventSource; now: number },
): Promise<NotificationOutcome | null> {
  const store = deps.reports;
  if (!store) return null;

  const recorded = report.notifications[kind];
  if (recorded) return recorded.outcome;

  if (!ctx.config.reports.notifications[kind].enabled) {
    if (kind !== 'submitted') {
      await store.recordNotification(ctx.guildId, report.id, kind, 'skipped', input.now);
    }
    return 'skipped';
  }

  const outcome = await tellReporter(ctx, deps, report, kind, input.now);
  await store.recordNotification(ctx.guildId, report.id, kind, outcome, input.now);

  const delivered = outcome === 'sent';
  await store.recordEvent({
    id: `${report.id}:${delivered ? 'notified' : 'notification_failed'}:${kind}`,
    reportId: report.id,
    guildId: ctx.guildId,
    kind: delivered ? 'notified' : 'notification_failed',
    actorId: null,
    source: input.source,
    data: { notification: kind, outcome },
    at: input.now,
  });

  return outcome;
}
