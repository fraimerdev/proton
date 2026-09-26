import {
  type ActionRow,
  DEFAULT_MENTION_POLICY,
  type DiscordMessageBody,
  type Embed,
  encodeCustomId,
  type MessageButton,
  messageUrl,
  type ProtonMessage,
  toDiscordMessage,
} from '@proton/core';
import { REPORT_METHOD_NAMES } from './surfaces.ts';
import {
  EVIDENCE_OPEN_TTL_MS,
  EVIDENCE_RESOLVED_TTL_MS,
  isActiveStatus,
  type ReportRecord,
  type ReportStatus,
} from './types.ts';

const MODULE = 'moderation';

export const REPORT_CARD_ACTIONS = {
  claim: 'rclaim',
  unclaim: 'runclaim',
  accept: 'raccept',
  dismiss: 'rdismiss',
  member: 'rmember',
  evidence: 'revidence',
} as const;

export type ReportCardAction = (typeof REPORT_CARD_ACTIONS)[keyof typeof REPORT_CARD_ACTIONS];

export const REPORT_STATUS_COLOURS: Readonly<Record<ReportStatus, number>> = {
  open: 0xf0b752,
  in_review: 0x3874f3,
  accepted: 0x4fcf95,
  dismissed: 0x868e9f,
};

export const ACTION_NAMES: Readonly<Record<string, string>> = {
  ban: 'Ban',
  kick: 'Kick',
  timeout: 'Timeout',
  warn: 'Warning',
};

export const STATS_WINDOW_DAYS = 30;

const DETAILS_SHOWN = 900;
const EXCERPT_SHOWN = 400;
const CUSTOM_REASON_SHOWN = 200;
const DISCORD_EPOCH = 1_420_070_400_000n;

export type CardReport = Pick<
  ReportRecord,
  | 'id'
  | 'guildId'
  | 'number'
  | 'status'
  | 'method'
  | 'reporterId'
  | 'targetId'
  | 'reason'
  | 'customReason'
  | 'comment'
  | 'sourceChannelId'
  | 'sourceMessageId'
  | 'evidence'
  | 'evidencePurgedAt'
  | 'assigneeId'
  | 'resolvedBy'
  | 'actionKind'
  | 'caseIds'
  | 'createdAt'
> & { resolvedAt?: number | null };

export function purgedText(
  report: Pick<CardReport, 'createdAt' | 'evidencePurgedAt' | 'resolvedAt'>,
): string {
  const resolved = report.resolvedAt ?? null;
  const purged = report.evidencePurgedAt;
  const afterResolution =
    resolved !== null &&
    (purged === null || purged >= resolved) &&
    resolved + EVIDENCE_RESOLVED_TTL_MS < report.createdAt + EVIDENCE_OPEN_TTL_MS;

  return afterResolution
    ? 'Evidence was removed 30 days after the report was resolved.'
    : 'Evidence was removed 90 days after the report was filed.';
}

export interface CardTarget {
  username: string | null;
  membership: 'member' | 'absent' | 'unknown';
  joinedAt: number | null;
}

export interface CardStats {
  total: number;
  distinctReporters: number;
  open: number;
}

export interface ReportCardView {
  report: CardReport;
  target: CardTarget;
  stats: CardStats | null;
  statsWindowDays: number;
  notifyRoleIds: readonly string[];
  firstPost: boolean;
  methodName?: string;
}

function points(text: string): string[] {
  return Array.from(text);
}

export function clipText(text: string, max: number): { text: string; clipped: boolean } {
  const all = points(text);
  if (all.length <= max) return { text, clipped: false };
  return { text: `${all.slice(0, Math.max(0, max - 1)).join('')}…`, clipped: true };
}

export function fenced(text: string, max: number): string {
  const shown = clipText(text.trim(), max).text.replaceAll('`', "'");
  return ['```', shown.length > 0 ? shown : ' ', '```'].join('\n');
}

export function escapeMarkdown(text: string): string {
  return text.replace(/([\\`*_~|>])/g, '\\$1');
}

export function relative(ms: number): string {
  return `<t:${Math.floor(ms / 1000)}:R>`;
}

export function snowflakeCreatedAt(id: string): number | null {
  if (!/^\d{17,20}$/.test(id)) return null;
  return Number((BigInt(id) >> 22n) + DISCORD_EPOCH);
}

export function actorMention(id: string | null): string {
  return id !== null && /^\d{17,20}$/.test(id) ? `<@${id}>` : 'Proton';
}

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

export function actionName(kind: string | null): string {
  return kind === null ? 'No punishment' : (ACTION_NAMES[kind] ?? kind);
}

export function casesLine(caseIds: readonly string[]): string | null {
  if (caseIds.length === 0) return null;
  const listed = caseIds.map((id) => `\`${id}\``).join(', ');
  return caseIds.length === 1 ? `Case ${listed}` : `Cases ${listed}`;
}

export function statusLine(
  report: Pick<CardReport, 'status' | 'assigneeId' | 'resolvedBy' | 'actionKind' | 'caseIds'>,
): string {
  switch (report.status) {
    case 'open':
      return 'Open · Waiting for staff';
    case 'in_review':
      return report.assigneeId === null
        ? 'In review'
        : `In review · Claimed by <@${report.assigneeId}>`;
    case 'accepted': {
      const cases = casesLine(report.caseIds);
      return [
        `Accepted by ${actorMention(report.resolvedBy)}`,
        actionName(report.actionKind),
        ...(cases ? [cases] : []),
      ].join(' · ');
    }
    case 'dismissed':
      return `Dismissed by ${actorMention(report.resolvedBy)}`;
  }
}

function isPurged(report: CardReport): boolean {
  return report.evidence.purged === true || report.evidencePurgedAt !== null;
}

function memberField(report: CardReport, target: CardTarget): string {
  const name = target.username ? ` · @${escapeMarkdown(target.username)}` : '';
  const lines = [`<@${report.targetId}>${name} · \`${report.targetId}\``];

  const created = snowflakeCreatedAt(report.targetId);
  if (created !== null) lines.push(`Account created ${relative(created)}`);

  if (target.membership === 'absent') lines.push('Not in the server');
  if (target.membership === 'member') {
    lines.push(target.joinedAt === null ? 'In the server' : `Joined ${relative(target.joinedAt)}`);
  }

  return lines.join('\n');
}

function reasonField(report: CardReport): string {
  const lines = [report.reason ?? 'No reason picked'];
  if (report.customReason) lines.push(fenced(report.customReason, CUSTOM_REASON_SHOWN));
  return lines.join('\n');
}

function messageField(report: CardReport): string | null {
  const message = report.evidence.message;
  if (isPurged(report) || message?.status !== 'captured') return null;

  const snapshot = message.snapshot;
  const text = snapshot.content || snapshot.forwardedContent || '';

  if (text.trim() === '') {
    return snapshot.attachments.length > 0 || snapshot.embeds.length > 0
      ? 'No text. See **View evidence**.'
      : 'No text.';
  }

  const { clipped } = clipText(text.trim(), EXCERPT_SHOWN);
  return clipped
    ? `${fenced(text, EXCERPT_SHOWN)}\nFull text under **View evidence**.`
    : fenced(text, EXCERPT_SHOWN);
}

export function evidenceSummary(report: CardReport): string {
  if (isPurged(report)) return purgedText(report);

  const { evidence } = report;
  const parts: string[] = [];
  const message = evidence.message;

  if (message?.status === 'unavailable') parts.push('Message unavailable when reported');

  const files =
    evidence.attachments.length +
    (message?.status === 'captured' ? message.snapshot.attachments.length : 0);
  if (files > 0) parts.push(plural(files, 'attachment'));

  if (evidence.links.length > 0) parts.push(plural(evidence.links.length, 'linked message'));

  if (evidence.copy && 'messageId' in evidence.copy) parts.push('copy posted below');
  if (evidence.copy && 'failed' in evidence.copy) parts.push('no copy (see **View evidence**)');

  return parts.length > 0 ? parts.join(' · ') : 'None';
}

function historyField(view: ReportCardView): string | null {
  const stats = view.stats;
  if (stats === null) return null;

  const others = Math.max(0, stats.open - (isActiveStatus(view.report.status) ? 1 : 0));
  const line =
    `Reported ${plural(stats.total, 'time')} by ${plural(stats.distinctReporters, 'member')} ` +
    `in ${view.statsWindowDays} days`;

  return others > 0 ? `${line} · ${others} other open` : line;
}

function button(
  key: ReportCardAction,
  label: string,
  style: MessageButton['style'],
): MessageButton {
  return { key, label, style };
}

function rows(report: CardReport): ActionRow[] {
  const view: ActionRow = {
    kind: 'buttons',
    buttons: [
      button(REPORT_CARD_ACTIONS.member, 'View member', 'secondary'),
      button(REPORT_CARD_ACTIONS.evidence, 'View evidence', 'secondary'),
    ],
  };

  if (!isActiveStatus(report.status)) return [view];

  return [
    {
      kind: 'buttons',
      buttons: [
        report.status === 'open'
          ? button(REPORT_CARD_ACTIONS.claim, 'Claim', 'primary')
          : button(REPORT_CARD_ACTIONS.unclaim, 'Unclaim', 'secondary'),
        button(REPORT_CARD_ACTIONS.accept, 'Accept', 'success'),
        button(REPORT_CARD_ACTIONS.dismiss, 'Dismiss', 'danger'),
      ],
    },
    view,
  ];
}

export function cardPings(view: ReportCardView): string[] {
  return view.firstPost ? [...new Set(view.notifyRoleIds)] : [];
}

export function buildReportCard(view: ReportCardView): ProtonMessage {
  const { report } = view;
  const fields: NonNullable<Embed['fields']> = [
    { name: 'Reported member', value: memberField(report, view.target), inline: false },
    { name: 'Reported by', value: `<@${report.reporterId}>`, inline: true },
    { name: 'Reason', value: reasonField(report), inline: true },
  ];

  if (report.comment && !isPurged(report)) {
    fields.push({ name: 'Details', value: fenced(report.comment, DETAILS_SHOWN), inline: false });
  }

  if (report.sourceChannelId && report.sourceMessageId) {
    const url = messageUrl(report.guildId, report.sourceChannelId, report.sourceMessageId);
    fields.push({
      name: 'Source',
      value: `<#${report.sourceChannelId}> · [Jump to message](${url})`,
      inline: false,
    });
  }

  const message = messageField(report);
  if (message) fields.push({ name: 'Message', value: message, inline: false });

  fields.push({ name: 'Evidence', value: evidenceSummary(report), inline: false });

  const history = historyField(view);
  if (history) fields.push({ name: 'History', value: history, inline: false });

  fields.push({ name: 'Status', value: statusLine(report), inline: false });

  const pings = cardPings(view);

  return {
    content: pings.length > 0 ? pings.map((roleId) => `<@&${roleId}>`).join(' ') : undefined,
    embeds: [
      {
        title: `Report \`${report.id}\` · #${report.number}`,
        color: REPORT_STATUS_COLOURS[report.status],
        fields,
        footer: {
          text: `Submitted via ${view.methodName ?? REPORT_METHOD_NAMES[report.method]}`,
        },
        timestamp: new Date(report.createdAt).toISOString(),
      },
    ],
    components: rows(report),
    mentions: { ...DEFAULT_MENTION_POLICY, roles: false, users: false },
    v2: [],
  };
}

export function reportCustomId(action: string, reportId: string): string | null {
  const encoded = encodeCustomId(MODULE, action, reportId);
  return encoded.ok ? encoded.customId : null;
}

export function toReportCardMessage(
  card: ProtonMessage,
  reportId: string,
  pings: readonly string[] = [],
  now: Date = new Date(),
): DiscordMessageBody {
  const body = toDiscordMessage(card, {
    customIdFor: (key) => reportCustomId(key, reportId) ?? key,
    now,
  });

  return {
    ...body,
    allowedMentions: { parse: [], ...(pings.length > 0 ? { roles: [...pings] } : {}) },
  };
}
