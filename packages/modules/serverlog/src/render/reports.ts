import {
  contextMenuKey,
  labelOf,
  moderationReportResolvedSchema,
  moderationReportSubmittedSchema,
  type ReportMethod,
} from '@proton/core';
import { ServerLogColors } from '../colours.ts';
import { channelMention, jumpUrl, type LogLine, logEmbed, userMention } from '../embed.ts';
import { actorLine } from './tickets.ts';
import type { RenderInput, RenderResult } from './types.ts';

const METHOD_COMMANDS: Record<Exclude<ReportMethod, 'reaction'>, string> = {
  command: 'report',
  user_menu: contextMenuKey('user', 'Report user'),
  message_menu: contextMenuKey('message', 'Report message'),
};

function methodLabel(input: RenderInput, method: ReportMethod): string {
  return method === 'reaction' ? 'Reaction' : labelOf(input, METHOD_COMMANDS[method]);
}

const UNLISTED_REASON = 'Custom reason or none';

function reportLines(payload: {
  number: number;
  reportId: string;
  targetId: string;
  reporterId: string;
}): LogLine[] {
  return [
    { label: 'Report', value: `#${payload.number}` },
    { label: 'Report ID', value: payload.reportId },
    { label: 'Reported member', mention: userMention(payload.targetId), value: payload.targetId },
    { label: 'Reported by', mention: userMention(payload.reporterId), value: payload.reporterId },
  ];
}

function sourceLines(
  guildId: string,
  channelId: string | null,
  messageId: string | null,
): LogLine[] {
  if (!channelId) return [];

  return [
    { label: 'Source', mention: channelMention(channelId), value: channelId },
    ...(messageId
      ? [{ label: 'Jump', mention: `[\`Jump to\`](${jumpUrl(guildId, channelId, messageId)})` }]
      : []),
  ];
}

function actionLabel(kind: string | null): string {
  return kind === null || kind === 'none' ? 'None' : kind.replaceAll('_', ' ');
}

export function renderReportFiled(input: RenderInput): RenderResult | null {
  const parsed = moderationReportSubmittedSchema.safeParse(input.entity);
  if (!parsed.success) return null;

  const payload = parsed.data;

  return {
    embed: logEmbed({
      subject: `Report #${payload.number}`,
      action: 'filed',
      colour: ServerLogColors.Add,
      lines: [
        ...reportLines(payload),
        { label: 'Method', value: methodLabel(input, payload.method) },
        { label: 'Reason', value: payload.reason ?? UNLISTED_REASON },
        ...sourceLines(input.guildId, payload.channelId, payload.messageId),
      ],
      executor: input.executor,
      occurredAt: input.occurredAt,
      emojis: input.emojis,
    }),
  };
}

export function renderReportResolved(input: RenderInput): RenderResult | null {
  const parsed = moderationReportResolvedSchema.safeParse(input.entity);
  if (!parsed.success) return null;

  const payload = parsed.data;
  const accepted = payload.status === 'accepted';
  const cases = payload.caseIds;

  return {
    embed: logEmbed({
      subject: `Report #${payload.number}`,
      action: accepted ? 'accepted' : 'dismissed',
      colour: accepted ? ServerLogColors.Remove : ServerLogColors.Modify,
      lines: [
        ...reportLines(payload),
        { label: 'Status', value: accepted ? 'Accepted' : 'Dismissed' },
        actorLine('Resolved by', payload.resolvedBy),
        { label: 'Action', value: actionLabel(payload.actionKind) },
        ...(cases.length > 0
          ? [{ label: cases.length === 1 ? 'Case' : 'Cases', value: cases.join(', ') }]
          : []),
      ],
      executor: input.executor,
      occurredAt: input.occurredAt,
      emojis: input.emojis,
    }),
  };
}
