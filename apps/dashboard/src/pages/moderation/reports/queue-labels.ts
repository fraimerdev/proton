import {
  hasWithAdmin,
  Permissions,
  type ReportActionParams,
  type ReportMethod,
  type ReportStatus,
} from '@proton/core';
import type {
  ReportDetail,
  ReportEventView,
  ReportGroup,
  ReportSummary,
} from '@proton/module-moderation/reports-view';
import { failureKind, readFailure, saveFailure } from '../../../lib/errors.ts';

export type Punishment = NonNullable<ReportActionParams['punishment']>;
export type PunishKind = Exclude<Punishment, 'none'>;
export type CardState = ReportSummary['card']['state'];
export type MessageEvidence = NonNullable<ReportDetail['evidence']['message']>;
export type UnavailableReason = Extract<MessageEvidence, { status: 'unavailable' }>['reason'];
export type MessageSnapshot = Extract<MessageEvidence, { status: 'captured' }>['snapshot'];
export type LinkEvidence = ReportDetail['evidence']['links'][number];
export type ReportAttachment = ReportDetail['evidence']['attachments'][number];
export type EventSource = ReportEventView['source'];

export type Tone = 'neutral' | 'success' | 'warning' | 'danger' | 'info' | 'primary';

export const STATUS_LABELS: Record<ReportStatus, string> = {
  open: 'Open',
  in_review: 'In review',
  accepted: 'Accepted',
  dismissed: 'Dismissed',
};

const STATUS_TONES: Record<ReportStatus, Tone> = {
  open: 'info',
  in_review: 'primary',
  accepted: 'success',
  dismissed: 'neutral',
};

export function statusTone(status: ReportStatus): Tone {
  return STATUS_TONES[status];
}

export function isActive(status: ReportStatus): boolean {
  return status === 'open' || status === 'in_review';
}

export const METHOD_LABELS: Record<ReportMethod, string> = {
  command: '/report',
  user_menu: 'Apps → Report user',
  message_menu: 'Apps → Report message',
  reaction: 'Reaction',
};

export function cardProblem(state: CardState): string | null {
  if (state === 'failed') return 'Delivery failed';
  if (state === 'missing') return 'Card missing';
  return null;
}

export function closeFailed(close: ReportSummary['close']): boolean {
  return close.error !== null && close.closedAt === null;
}

export const PUNISHMENT_LABELS: Record<Punishment, string> = {
  none: 'No punishment',
  warn: 'Warn',
  timeout: 'Timeout',
  kick: 'Kick',
  ban: 'Ban',
};

const KIND_NOUNS: Record<string, string> = {
  warn: 'warning',
  timeout: 'timeout',
  kick: 'kick',
  ban: 'ban',
};

const PUNISH_KINDS: readonly PunishKind[] = ['warn', 'timeout', 'kick', 'ban'];

const KIND_PERMISSION: Record<PunishKind, bigint> = {
  warn: Permissions.ModerateMembers,
  timeout: Permissions.ModerateMembers,
  kick: Permissions.KickMembers,
  ban: Permissions.BanMembers,
};

export interface ViewerAccess {
  id: string | null;
  owner: boolean;
  permissions: string;
}

function permissionBits(viewer: ViewerAccess): bigint | null {
  try {
    return BigInt(viewer.permissions);
  } catch {
    return null;
  }
}

export function allowedPunishments(viewer: ViewerAccess | undefined): Punishment[] {
  if (viewer === undefined || viewer.owner) return ['none', ...PUNISH_KINDS];

  const bits = permissionBits(viewer);
  if (bits === null) return ['none', ...PUNISH_KINDS];

  return ['none', ...PUNISH_KINDS.filter((kind) => hasWithAdmin(bits, KIND_PERMISSION[kind]))];
}

export function deletesByDefault(setting: boolean, viewer: ViewerAccess | undefined): boolean {
  if (!setting) return false;
  if (viewer === undefined || viewer.owner) return true;

  const bits = permissionBits(viewer);
  return bits === null || hasWithAdmin(bits, Permissions.ManageMessages);
}

export interface AcceptChoices {
  punishment: Punishment;
  reason: string;
  timeoutFor: string;
  banFor: string | null;
  deleteMessage: boolean | null;
  note: string;
  reporterNote: string | null;
  confirmRecentCase: boolean;
}

export function acceptParams(choices: AcceptChoices): ReportActionParams {
  const { punishment } = choices;
  const reason = choices.reason.trim();
  const note = choices.note.trim();
  const reporterNote = choices.reporterNote?.trim() ?? '';

  return {
    punishment,
    ...(punishment !== 'none' && reason !== '' ? { reason } : {}),
    ...(punishment === 'timeout' ? { duration: choices.timeoutFor } : {}),
    ...(punishment === 'ban' ? { duration: choices.banFor } : {}),
    ...(choices.deleteMessage !== null ? { deleteMessage: choices.deleteMessage } : {}),
    ...(note !== '' ? { note } : {}),
    ...(reporterNote !== '' ? { reporterNote } : {}),
    ...(choices.confirmRecentCase ? { confirmRecentCase: true } : {}),
  };
}

export function filedByViewer(
  report: Pick<ReportSummary, 'reporterId'>,
  viewer: ViewerAccess | undefined,
): boolean {
  return viewer !== undefined && !viewer.owner && viewer.id === report.reporterId;
}

function span(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));

  if (seconds < 3600) return `${Math.max(1, Math.floor(seconds / 60))}m`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h`;
  if (seconds < 31_536_000) return `${Math.floor(seconds / 86_400)}d`;

  return `${Math.floor(seconds / 31_536_000)}y`;
}

export function relativeTime(at: number, now: number): string {
  const ms = now - at;

  if (Math.abs(ms) < 60_000) return 'just now';
  return ms < 0 ? `in ${span(-ms)}` : `${span(ms)} ago`;
}

export function attachmentExpiry(
  expiresAt: number | null,
  now: number,
): { expired: boolean; label: string } {
  if (expiresAt === null) return { expired: false, label: 'Link from Discord' };
  if (expiresAt <= now) return { expired: true, label: 'Link expired' };

  return { expired: false, label: `Link from Discord, expires ${relativeTime(expiresAt, now)}` };
}

export function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;

  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export const UNAVAILABLE_COPY: Record<UnavailableReason, string> = {
  deleted: 'The message was deleted before Proton could read it.',
  no_access: 'Proton couldn’t view that channel when the report was filed.',
  failed: 'Proton couldn’t read the message when the report was filed.',
  not_captured: 'The message wasn’t captured with this report.',
  purged: 'The message was removed with the rest of the evidence.',
};

export const LINK_STATUS_COPY: Record<LinkEvidence['status'], string> = {
  captured: 'Captured when reported',
  not_found: 'Message not found. It may have been deleted.',
  no_access: 'Not captured: the reporter can’t view that channel',
  other_server: 'Not captured: the link is to another server',
  invalid: 'Not captured: not a message link',
  failed: 'Not captured: Proton couldn’t read it',
};

const DAY_MS = 86_400_000;
const EVIDENCE_OPEN_MS = 90 * DAY_MS;
const EVIDENCE_RESOLVED_MS = 30 * DAY_MS;

export function purgeNotice(report: {
  evidence: { purged?: boolean | undefined };
  evidencePurgedAt: number | null;
  createdAt: number;
  resolvedAt: number | null;
}): string | null {
  if (report.evidence.purged !== true && report.evidencePurgedAt === null) return null;

  const resolvedFirst =
    report.resolvedAt !== null &&
    report.resolvedAt + EVIDENCE_RESOLVED_MS <= report.createdAt + EVIDENCE_OPEN_MS;

  return resolvedFirst
    ? 'Evidence was removed 30 days after this report was resolved.'
    : 'Evidence was removed 90 days after this report was filed.';
}

function plural(count: number, noun: string, many = `${noun}s`): string {
  return `${count} ${count === 1 ? noun : many}`;
}

export function groupLine(
  group: Pick<ReportGroup, 'total' | 'distinctReporters' | 'open'>,
): string {
  return [
    plural(group.total, 'report'),
    `from ${plural(group.distinctReporters, 'member')}`,
    `${group.open} open`,
  ].join(' · ');
}

export function historyLine(stats: ReportDetail['stats'], active: boolean): string {
  const others = Math.max(0, stats.open - (active ? 1 : 0));

  return [
    `Reported ${plural(stats.total, 'time')} by ${plural(stats.distinctReporters, 'member')} in 30 days`,
    others === 0 ? 'no other open reports' : `${others} other open`,
  ].join(' · ');
}

export const SOURCE_LABELS: Record<EventSource, string> = {
  discord: 'Discord',
  dashboard: 'Dashboard',
  automation: 'Automation',
  system: 'System',
};

const MEMBER_ID = /^\d{17,20}$/;

export function isMemberId(value: string | null | undefined): value is string {
  return typeof value === 'string' && MEMBER_ID.test(value);
}

function text(data: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = data[key];
    if (typeof value === 'string' && value.trim() !== '') return value;
  }
  return undefined;
}

function kindNoun(kind: string | undefined): string | undefined {
  if (kind === undefined || kind === 'none') return undefined;
  return KIND_NOUNS[kind] ?? kind.replaceAll('_', ' ');
}

function capital(sentence: string): string {
  return sentence.charAt(0).toUpperCase() + sentence.slice(1);
}

const NOTIFIED: Record<string, string> = {
  submitted: 'Reporter sent a confirmation DM',
  accepted: 'Reporter told the report was accepted',
  dismissed: 'Reporter told the report was dismissed',
};

const DM_OUTCOMES: Record<string, string> = {
  closed: 'Their DMs are closed to Proton.',
  no_mutual_server: 'They no longer share a server with Proton.',
  failed: 'Discord refused the DM.',
  gave_up: 'Proton gave up after 5 attempts.',
  skipped: 'The message was turned off.',
};

export interface EventDescription {
  text: string;
  member?: string | undefined;
  caseId?: string | undefined;
  detail?: string | undefined;
}

const DELIVERY_CODES: Record<string, string> = {
  no_channel: 'No report channel is set in Report settings.',
  discord_429: 'Discord was rate-limiting Proton. It tries again on its own.',
};

export function describeEvent(
  event: Pick<ReportEventView, 'kind' | 'data'>,
  ruleName: (id: string) => string | undefined = () => undefined,
): EventDescription {
  const data = event.data;
  const kind = kindNoun(text(data, 'kind', 'punishment', 'actionKind'));
  const caseId = text(data, 'caseId');
  const message = text(data, 'message', 'error', 'reason');

  switch (event.kind) {
    case 'submitted': {
      const method = text(data, 'method') as ReportMethod | undefined;
      const via = method !== undefined ? METHOD_LABELS[method] : undefined;
      return { text: via === undefined ? 'Report filed' : `Report filed via ${via}` };
    }

    case 'claimed':
      return { text: 'Claimed for review' };

    case 'unclaimed':
      return { text: 'Claim released' };

    case 'assigned': {
      const assignee = text(data, 'assigneeId', 'to');
      return isMemberId(assignee)
        ? { text: 'Assigned to', member: assignee }
        : { text: 'Assignment cleared' };
    }

    case 'accepted':
      return {
        text: kind === undefined ? 'Accepted without a punishment' : `Accepted with a ${kind}`,
        caseId,
      };

    case 'dismissed':
      return { text: 'Dismissed' };

    case 'action_executed':
      return {
        text: kind === undefined ? 'Punishment carried out' : `${capital(kind)} carried out`,
        caseId,
      };

    case 'action_failed':
      return {
        text:
          kind === undefined
            ? 'Punishment failed, so the report stayed open'
            : `${capital(kind)} failed, so the report stayed open`,
        detail: message,
      };

    case 'delivery_failed': {
      const code = text(data, 'code');
      return {
        text: 'Report card not posted',
        detail: message ?? (code !== undefined ? DELIVERY_CODES[code] : undefined),
      };
    }

    case 'delivered':
      return { text: 'Report card posted' };

    case 'card_missing':
      return { text: 'Report card deleted in Discord' };

    case 'reposted':
      return { text: 'Report card posted again' };

    case 'moved':
      return data.copyKept === true
        ? {
            text: 'Report card moved to the archive channel',
            detail: 'The forwarded copy of the message stayed in the report channel.',
          }
        : { text: 'Report card moved to the archive channel' };

    case 'deleted':
      return { text: 'Report card deleted on close' };

    case 'close_failed':
      return { text: 'Closing the report card failed', detail: message };

    case 'notified': {
      const which = text(data, 'kind', 'notification');
      return { text: (which !== undefined ? NOTIFIED[which] : undefined) ?? 'Reporter sent a DM' };
    }

    case 'notification_failed': {
      const outcome = text(data, 'outcome');
      return {
        text: 'Reporter DM not delivered',
        detail: (outcome !== undefined ? DM_OUTCOMES[outcome] : undefined) ?? message,
      };
    }

    case 'automation_fired': {
      const id = text(data, 'ruleId');
      const rule = text(data, 'ruleName', 'name') ?? (id !== undefined ? ruleName(id) : undefined);
      return {
        text: rule === undefined ? 'Automation rule fired' : `Automation rule “${rule}” fired`,
      };
    }

    case 'evidence_purged':
      return { text: 'Evidence removed after the retention period' };

    default:
      return { text: capital(event.kind.replaceAll('_', ' ')) };
  }
}

export function actorLabel(actorId: string | null): string | null {
  if (actorId === null || MEMBER_ID.test(actorId)) return null;
  return actorId.startsWith('proton:') ? 'Proton' : actorId;
}

export function readableOutcome(
  message: string,
  names: ReadonlyMap<string, string>,
  now: number,
): string {
  return message
    .replace(/<@!?(\d+)>/g, (_, id: string) => `@${names.get(id) ?? id}`)
    .replace(/<@&(\d+)>/g, (_, id: string) => `@${names.get(id) ?? 'role'}`)
    .replace(/<#(\d+)>/g, (_, id: string) => `#${names.get(id) ?? 'channel'}`)
    .replace(/<t:(\d+)(?::[tTdDfFR])?>/g, (_, seconds: string) =>
      relativeTime(Number(seconds) * 1000, now),
    )
    .replace(/`([^`\n]+)`/g, '$1')
    .replace(/\*\*([^*\n]+)\*\*/g, '$1');
}

const WORKER_UNSETTLED = /may still complete/i;

export interface ActionFailure {
  tone: 'warning' | 'danger';
  message: string;
  unsettled: boolean;
}

// Not saveFailure alone: the api and the worker answer in whole sentences, and saveFailure would replace them.
export function actionFailure(error: Error, attempt: string): ActionFailure {
  if (WORKER_UNSETTLED.test(error.message)) {
    return { tone: 'warning', message: error.message, unsettled: true };
  }

  if (failureKind(error) === 'unknown' && error.message.trim() !== '') {
    return { tone: 'danger', message: error.message, unsettled: false };
  }

  return { tone: 'danger', message: saveFailure(error, attempt), unsettled: false };
}

const NO_SUCH_REPORT = /^This server has no report/;

export function reportReadFailure(error: unknown, what: string): string {
  if (error instanceof Error && NO_SUCH_REPORT.test(error.message)) {
    return error.message.replaceAll('`', '');
  }

  return readFailure(error, what);
}
