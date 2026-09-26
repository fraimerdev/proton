import { type ModuleContext, tryParseDuration } from '@proton/core';
import type { ModerationConfig } from '../config.ts';
import type { ModerationDeps } from '../deps.ts';
import { MODULE_ID } from '../perform.ts';
import type { ReportSource, SubmitLimits } from './store.ts';
import type { ReportEvidence, ReportMethod, ReportRecord, ReportRefusalCode } from './types.ts';

export interface SubmitInput {
  guildId: string;
  method: ReportMethod;
  reporter: { id: string; roleIds: readonly string[] };
  targetId: string;
  reasonId: string | null;
  customReason: string | null;
  comment: string | null;
  source: ReportSource | null;
  evidence: ReportEvidence;
  idempotencyKey: string;
  now: number;
}

export type SubmitOutcome =
  | { status: 'filed' | 'existing'; report: ReportRecord; message: string }
  | { status: 'refused'; code: ReportRefusalCode | 'unavailable'; message: string };

export const REPORT_STORE_UNBOUND =
  'User reports aren’t available right now, so nothing was filed. Let the server’s staff know.';

export function submitLimits(
  config: ModerationConfig,
  reporterRoleIds: readonly string[],
): SubmitLimits {
  const limits = config.reports.limits;

  return {
    cooldownMs: tryParseDuration(limits.cooldown) ?? 0,
    bypassCooldown: reporterRoleIds.some((roleId) => limits.cooldownBypassRoleIds.includes(roleId)),
    duplicateProtection: limits.duplicateProtection,
    maxOpenPerMember: limits.maxOpenPerMember,
    maxOpenPerServer: limits.maxOpenPerServer,
  };
}

export function reasonLabel(config: ModerationConfig, reasonId: string | null): string | null {
  if (reasonId === null) return null;
  return config.reports.reasons.find((reason) => reason.id === reasonId)?.label ?? null;
}

export function filedMessage(config: ModerationConfig, reportId: string): string {
  const notifications = config.reports.notifications;
  const told = notifications.accepted.enabled || notifications.dismissed.enabled;

  return (
    `Report \`${reportId}\` filed. Staff will review it.` +
    (told ? ' You’ll get a DM when it’s reviewed.' : '')
  );
}

export function refusalMessage(
  code: ReportRefusalCode,
  targetId: string,
  details: { retryAt?: number; reportId?: string; fromMessage: boolean },
): string {
  switch (code) {
    case 'cooldown':
      return details.retryAt === undefined
        ? 'You filed a report very recently. Wait a little before filing another.'
        : `You can file another report <t:${Math.ceil(details.retryAt / 1000)}:R>.`;

    case 'duplicate':
      return (
        `You already reported <@${targetId}>${details.fromMessage ? ' for this message' : ''}.` +
        (details.reportId ? ` Report \`${details.reportId}\` is still waiting for staff.` : '')
      );

    case 'member_cap':
      return (
        `Staff already have several open reports about <@${targetId}>, so this one wasn’t ` +
        'filed. They’ll review the ones already waiting.'
      );

    case 'server_cap':
      return 'This server’s report queue is full right now, so your report wasn’t filed. Try again later.';
  }
}

export async function submitReport(
  ctx: ModuleContext<ModerationConfig>,
  deps: ModerationDeps,
  input: SubmitInput,
): Promise<SubmitOutcome> {
  const store = deps.reports;
  if (!store) return { status: 'refused', code: 'unavailable', message: REPORT_STORE_UNBOUND };

  const reasonId = reasonLabel(ctx.config, input.reasonId) === null ? null : input.reasonId;

  const result = await store.submit(
    {
      guildId: input.guildId,
      reporterId: input.reporter.id,
      targetId: input.targetId,
      method: input.method,
      reasonId,
      reason: reasonLabel(ctx.config, reasonId),
      customReason: input.customReason,
      comment: input.comment,
      source: input.source,
      evidence: input.evidence,
      idempotencyKey: input.idempotencyKey,
      now: input.now,
    },
    submitLimits(ctx.config, input.reporter.roleIds),
  );

  if (result.status === 'refused') {
    return {
      status: 'refused',
      code: result.code,
      message: refusalMessage(result.code, input.targetId, {
        ...(result.retryAt === undefined ? {} : { retryAt: result.retryAt }),
        ...(result.reportId === undefined ? {} : { reportId: result.reportId }),
        fromMessage: input.source !== null,
      }),
    };
  }

  if (result.status === 'filed' || result.report.card.state === 'pending') {
    await announce(ctx, result.report);
  }

  return {
    status: result.status,
    report: result.report,
    message: filedMessage(ctx.config, result.report.id),
  };
}

async function announce(ctx: ModuleContext<ModerationConfig>, report: ReportRecord): Promise<void> {
  const context = { guildId: ctx.guildId, moduleId: MODULE_ID, reportId: report.id };

  if (!ctx.publish) {
    ctx.logger.error(
      `report ${report.id} was saved but this context cannot publish moderation.report_submitted, ` +
        'so its staff card waits for the reports patrol to deliver it.',
      context,
    );
    return;
  }

  try {
    await ctx.publish('moderation.report_submitted', report.id, {
      guildId: report.guildId,
      reportId: report.id,
      number: report.number,
      reporterId: report.reporterId,
      targetId: report.targetId,
      method: report.method,
      reason: report.reason,
      channelId: report.sourceChannelId,
      messageId: report.sourceMessageId,
      createdAt: report.createdAt,
    });
  } catch (error) {
    ctx.logger.error(
      `report ${report.id} was saved but moderation.report_submitted could not be published ` +
        `(${error instanceof Error ? error.message : String(error)}), so its staff card waits for ` +
        'the reports patrol to deliver it.',
      context,
    );
  }
}
