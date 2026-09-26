import type { ApplicationStatus } from '@proton/core';
import { EXPORT_ROWS_MAX } from '@proton/module-applications/constants';
import type { CheckedAnswer } from '@proton/module-applications/questions';
import { allowedFrom, STATUS_LABELS } from '@proton/module-applications/status';
import {
  type ApplicationDetail,
  EFFECT_LABELS,
  type EffectProblem,
  type EffectView,
  QUEUE_VIEWS,
  type QueueQuery,
  type QueueSummary,
  type QueueView,
} from '@proton/module-applications/view';
import { referenceOf } from '@proton/module-applications/web';
import { failureKind, readFailure, saveFailure } from '../../lib/errors.ts';

export type Tone = 'neutral' | 'success' | 'warning' | 'danger' | 'info' | 'primary';

export const PAGE_SIZES = [25, 50] as const;
export const SEARCH_MAX = 100;
export const REVIEW_MEMBERS_MAX = 50;

const MEMBER_ID = /^\d{17,20}$/;

export function isMemberId(value: string | null | undefined): value is string {
  return typeof value === 'string' && MEMBER_ID.test(value);
}

export interface SubmissionsSearch {
  view?: string | undefined;
  q?: string | undefined;
  page?: number | undefined;
  id?: string | undefined;
}

export type QueueSort = 'submitted' | 'number' | 'updated';

export interface QueueLocal {
  formId?: string | undefined;
  assignee?: 'me' | 'none' | undefined;
  pageSize?: number | undefined;
  sort?: QueueSort | undefined;
  dir?: 'asc' | 'desc' | undefined;
}

export function queueRequest(search: SubmissionsSearch, local: QueueLocal): QueueQuery {
  const term = (search.q ?? '').trim().slice(0, SEARCH_MAX).trim();
  const page = Math.trunc(search.page ?? 1);

  return {
    view: viewOf(search.view),
    formId: local.formId,
    assignee: local.assignee,
    q: term === '' ? undefined : term,
    page: Number.isFinite(page) && page > 1 ? page : 1,
    pageSize: PAGE_SIZES.find((size) => size === local.pageSize) ?? PAGE_SIZES[0],
    sort: local.sort ?? 'submitted',
    dir: local.dir ?? 'desc',
  };
}

export const VIEW_LABELS: Readonly<Record<QueueView, string>> = {
  awaiting: 'Awaiting review',
  needs_info: 'Needs information',
  waitlisted: 'Waitlisted',
  accepted: 'Accepted',
  rejected: 'Rejected',
  withdrawn: 'Withdrawn',
  expired: 'Expired',
  all: 'All',
  archived: 'Archived',
};

export const EXPORT_SCOPES: Readonly<Record<QueueView, string>> = {
  awaiting: 'Applications awaiting review',
  needs_info: 'Applications waiting on the applicant',
  waitlisted: 'Waitlisted applications',
  accepted: 'Accepted applications',
  rejected: 'Rejected applications',
  withdrawn: 'Withdrawn applications',
  expired: 'Expired applications',
  all: 'All applications',
  archived: 'Archived applications',
};

export function exportScope(
  choice: { view: QueueView; formId?: string | undefined; formName?: string | undefined },
  format: 'csv' | 'json',
): string {
  const limit = `Up to ${EXPORT_ROWS_MAX.toLocaleString('en-GB')} at a time.`;

  if (choice.formId === undefined && format === 'csv') {
    return (
      `${EXPORT_SCOPES[choice.view]} from every form you can export. A CSV of several forms has ` +
      `no answer columns, so pick one form, or choose JSON, to include answers. ${limit}`
    );
  }

  const source =
    choice.formName ?? (choice.formId === undefined ? 'every form you can export' : 'this form');
  return `${EXPORT_SCOPES[choice.view]} from ${source}, with their answers. ${limit}`;
}

export function viewOf(value: string | undefined): QueueView {
  return QUEUE_VIEWS.find((view) => view === value) ?? 'awaiting';
}

const COUNTED: Partial<Record<QueueView, keyof QueueSummary>> = {
  awaiting: 'awaiting',
  needs_info: 'needsInfo',
  waitlisted: 'waitlisted',
};

export function viewTabs(
  summary: QueueSummary | undefined,
): readonly { id: QueueView; label: string }[] {
  return QUEUE_VIEWS.map((view) => {
    const key = COUNTED[view];
    const count = key === undefined || summary === undefined ? null : summary[key];
    const label = VIEW_LABELS[view];

    return {
      id: view,
      label: typeof count === 'number' && count > 0 ? `${label} (${count})` : label,
    };
  });
}

export const EMPTY_VIEWS: Readonly<Record<QueueView, { title: string; body?: string }>> = {
  awaiting: {
    title: 'Nothing is waiting for review',
    body: 'New applications show here as soon as they’re sent.',
  },
  needs_info: { title: 'No applications are waiting on the applicant' },
  waitlisted: { title: 'No waitlisted applications' },
  accepted: { title: 'No accepted applications' },
  rejected: { title: 'No rejected applications' },
  withdrawn: { title: 'No withdrawn applications' },
  expired: { title: 'No expired applications' },
  all: {
    title: 'No applications yet',
    body:
      'Members can apply once a form is published and open, from a panel, with /apply or on ' +
      'the web.',
  },
  archived: {
    title: 'No archived applications',
    body: 'Archive decided applications to keep the other lists short.',
  },
};

const STATUS_TONES: Readonly<Record<ApplicationStatus, Tone>> = {
  draft: 'neutral',
  submitted: 'info',
  in_review: 'primary',
  needs_info: 'warning',
  waitlisted: 'neutral',
  accepted: 'success',
  rejected: 'neutral',
  withdrawn: 'neutral',
  expired: 'neutral',
};

export function statusTone(status: ApplicationStatus): Tone {
  return STATUS_TONES[status];
}

export function statusLabel(status: ApplicationStatus): string {
  return STATUS_LABELS[status];
}

export function titleOf(application: { formName: string; number: number | null }): string {
  const reference = referenceOf(application.number);
  return reference === '' ? application.formName : `${application.formName} ${reference}`;
}

export function problemLabels(problems: readonly Pick<EffectProblem, 'label'>[]): string[] {
  return [...new Set(problems.map((problem) => problem.label))];
}

function lowerFirst(text: string): string {
  if (/^[A-Z]{2}/.test(text)) return text;
  return text.charAt(0).toLowerCase() + text.slice(1);
}

export function problemSummary(
  status: ApplicationStatus,
  problems: readonly Pick<EffectProblem, 'label'>[],
): string | null {
  const labels = problemLabels(problems);
  if (labels.length === 0) return null;

  return `${STATUS_LABELS[status]} · ${labels.map(lowerFirst).join(', ')}`;
}

export function voteLine(votes: { accept: number; reject: number }): string | null {
  if (votes.accept === 0 && votes.reject === 0) return null;
  return `${votes.accept} accept · ${votes.reject} reject`;
}

export function averageScore(votes: readonly { score: number | null }[]): number | null {
  const scores = votes.flatMap((vote) => (vote.score === null ? [] : [vote.score]));
  if (scores.length === 0) return null;

  return Math.round((scores.reduce((sum, score) => sum + score, 0) / scores.length) * 10) / 10;
}

const WORKING: ReadonlySet<EffectView['status']> = new Set(['pending', 'running', 'requested']);

export function isWorking(effects: readonly Pick<EffectView, 'status'>[]): boolean {
  return effects.some((effect) => WORKING.has(effect.status));
}

export const EFFECT_STATUS_LABELS: Readonly<Record<EffectView['status'], string>> = {
  pending: 'Waiting',
  running: 'Running',
  requested: 'Waiting for another module',
  succeeded: 'Done',
  failed: 'Failed',
  skipped: 'Skipped',
  cancelled: 'Cancelled',
};

const EFFECT_STATUS_TONES: Readonly<Record<EffectView['status'], Tone>> = {
  pending: 'info',
  running: 'info',
  requested: 'info',
  succeeded: 'success',
  failed: 'danger',
  skipped: 'neutral',
  cancelled: 'neutral',
};

export function effectStatusTone(status: EffectView['status']): Tone {
  return EFFECT_STATUS_TONES[status];
}

const TRIGGERS: Readonly<Record<string, string>> = {
  submitted: 'When it was submitted',
  accepted: 'When it was accepted',
  rejected: 'When it was rejected',
  waitlisted: 'When it was waitlisted',
  withdrawn: 'When it was withdrawn',
  expired: 'When it expired',
  reopened: 'When it was reopened',
  info: 'When staff asked for more information',
  review_started: 'When review started',
  information_requested: 'When staff asked for more information',
  information_provided: 'When the applicant answered',
  reminder: 'When the review was overdue',
  ticket: 'When staff asked for an interview ticket',
};

export function effectTrigger(key: string): string | null {
  const parts = key.split(':');
  const head = parts[0] === 'event' ? parts[1] : parts[0];
  return head === undefined ? null : (TRIGGERS[head] ?? null);
}

export function effectRoleId(effect: Pick<EffectView, 'key' | 'kind'>): string | null {
  if (effect.kind !== 'add_role' && effect.kind !== 'remove_role') return null;

  const parts = effect.key.split(':');
  const at = parts.findIndex((part) => part === 'add_role' || part === 'remove_role');
  const id = at === -1 ? undefined : parts[at + 1];

  return isMemberId(id) ? id : null;
}

export function effectLabel(effect: Pick<EffectView, 'key' | 'kind' | 'label'>): string {
  if (effect.kind === 'remove_role' && effect.key.endsWith(':cleanup')) {
    return 'Remove roles given on submission';
  }
  return effect.label || EFFECT_LABELS[effect.kind];
}

export function shownEffects<T extends Pick<EffectView, 'kind' | 'status'>>(
  effects: readonly T[],
): T[] {
  return effects.filter((effect) => effect.kind !== 'event' || effect.status === 'failed');
}

export function canRetry(effect: Pick<EffectView, 'status'>): boolean {
  return effect.status === 'failed';
}

export function canCancel(effect: Pick<EffectView, 'status'>): boolean {
  return effect.status === 'pending' || effect.status === 'requested' || effect.status === 'failed';
}

const DOWNGRADES: Readonly<Record<string, string>> = {
  channel_not_private:
    'The review card shows no answers, because members outside the review team can read its ' +
    'channel.',
  audience_unknown:
    'The review card shows no answers, because Proton couldn’t check who can read its channel.',
};

export function downgradeNotice(effect: Pick<EffectView, 'kind' | 'errorCode'>): string | null {
  if (effect.kind !== 'card' || effect.errorCode === null) return null;
  return DOWNGRADES[effect.errorCode] ?? null;
}

export const SOURCE_LABELS: Readonly<Record<string, string>> = {
  discord: 'Discord',
  dashboard: 'Dashboard',
  web: 'Web',
  system: 'System',
};

const HISTORY_LABELS: Readonly<Record<string, string>> = {
  submitted: 'Submitted',
  claimed: 'Claimed',
  unclaimed: 'Claim released',
  assigned: 'Assigned',
  unassigned: 'Assignment cleared',
  note: 'Note added',
  voted: 'Voted',
  information_requested: 'Asked for more information',
  information_provided: 'The applicant answered',
  waitlisted: 'Waitlisted',
  accepted: 'Accepted',
  rejected: 'Rejected',
  override_two_reviewers: 'Decided without a second reviewer',
  reopened: 'Reopened',
  archived: 'Archived',
  unarchived: 'Taken out of the archive',
  ticket_requested: 'Interview ticket requested',
  card_reposted: 'Review card posted again',
  withdrawn: 'Withdrawn by the applicant',
  reminded: 'Review reminder posted',
  review_overdue: 'Review overdue',
  expired: 'Expired',
  deleted: 'Deleted',
  content_purged: 'Answers removed after the keep-for period',
  effect_retried: 'Failed action tried again',
  effect_cancelled: 'Action cancelled',
};

const WARNING_EVENTS: ReadonlySet<string> = new Set([
  'override_two_reviewers',
  'review_overdue',
  'expired',
  'deleted',
  'content_purged',
]);
const SUCCESS_EVENTS: ReadonlySet<string> = new Set(['accepted']);

export function historyLabel(kind: string): string {
  const known = HISTORY_LABELS[kind];
  if (known !== undefined) return known;

  const words = kind.replaceAll('_', ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function historyTone(kind: string): 'warning' | 'success' | undefined {
  if (WARNING_EVENTS.has(kind)) return 'warning';
  if (SUCCESS_EVENTS.has(kind)) return 'success';
  return undefined;
}

export function statusChange(
  from: ApplicationStatus | null,
  to: ApplicationStatus | null,
): string | null {
  if (from === null || to === null || from === to) return null;
  return `${STATUS_LABELS[from]} → ${STATUS_LABELS[to]}`;
}

type ThreadKind = ApplicationDetail['thread'][number]['kind'];

export const THREAD_LABELS: Readonly<Record<ThreadKind, string>> = {
  info_request: 'Staff asked for more information',
  info_response: 'The applicant answered',
  decision: 'Reason sent to the applicant',
  reopened: 'Reopened',
};

export function actorLabel(actorId: string): string | null {
  if (isMemberId(actorId)) return null;
  if (actorId === 'staff') return 'Staff';
  return 'Proton';
}

export interface AnswerGroup {
  id: string;
  title: string;
  answers: CheckedAnswer[];
}

export function answerGroups(
  answers: readonly CheckedAnswer[],
  sections: readonly { id: string; title: string }[],
): AnswerGroup[] {
  const groups = sections.map((section) => ({
    id: section.id,
    title: section.title,
    answers: [] as CheckedAnswer[],
  }));
  const byId = new Map(groups.map((group) => [group.id, group]));
  const loose: AnswerGroup = { id: '', title: '', answers: [] };

  for (const answer of answers) (byId.get(answer.sectionId) ?? loose).answers.push(answer);

  return [...groups, loose].filter((group) => group.answers.length > 0);
}

export function isLink(answer: Pick<CheckedAnswer, 'type' | 'display'>): boolean {
  return answer.type === 'url' && /^https?:\/\/[^\s]+$/i.test(answer.display);
}

export interface ActionAvailability {
  claim: boolean;
  unclaim: boolean;
  assign: boolean;
  requestInfo: boolean;
  waitlist: boolean;
  decide: boolean;
  vote: boolean;
  note: boolean;
  openTicket: boolean;
  repost: boolean;
  reopen: boolean;
  archive: boolean;
  unarchive: boolean;
  remove: boolean;
  exportForm: boolean;
}

export function actionsFor(detail: ApplicationDetail, moduleOn: boolean): ActionAvailability {
  const { application, capabilities } = detail;
  const status = application.status;
  const live = application.deletedAt === null;
  const working = live && moduleOn;
  const can = (capability: ApplicationDetail['capabilities'][number]): boolean =>
    capabilities.includes(capability);
  const from = (action: Parameters<typeof allowedFrom>[0]): boolean =>
    allowedFrom(action).includes(status);

  return {
    claim: working && can('review') && from('claim') && application.assigneeId === null,
    unclaim: working && can('review') && status === 'in_review' && application.assigneeId !== null,
    assign: working && can('review') && from('assign'),
    requestInfo: working && can('review') && from('request_info'),
    waitlist: working && can('review') && from('waitlist'),
    decide: working && can('decide') && from('accept'),
    vote: working && can('review') && from('vote') && (detail.twoReviewers || detail.scoring),
    note: working && can('review') && from('note'),
    openTicket: working && can('review') && from('open_ticket'),
    repost: working && can('review') && from('repost_card'),
    reopen: working && can('override') && from('reopen') && application.contentPurgedAt === null,
    archive: working && can('decide') && from('archive') && !application.archived,
    unarchive: working && can('decide') && from('unarchive') && application.archived,
    remove: live && can('delete'),
    exportForm: live && can('export'),
  };
}

export function removalNote(
  application: Pick<ApplicationDetail['application'], 'contentPurgedAt' | 'deletedAt'>,
): 'deleted' | 'purged' | null {
  if (application.deletedAt !== null) return 'deleted';
  if (application.contentPurgedAt !== null) return 'purged';
  return null;
}

export function detailMemberIds(detail: ApplicationDetail): string[] {
  const ids = new Set<string>();
  const add = (id: string | null | undefined): void => {
    if (isMemberId(id)) ids.add(id);
  };

  add(detail.application.applicantId);
  add(detail.application.assigneeId);
  add(detail.application.decidedBy);
  for (const entry of detail.thread) add(entry.authorId);
  for (const note of detail.notes ?? []) add(note.authorId);
  for (const vote of detail.votes ?? []) add(vote.reviewerId);
  for (const event of detail.history) add(event.actorId);

  return [...ids];
}

export function isNotFound(error: unknown): boolean {
  return error instanceof Error && /can’t find that application/i.test(error.message);
}

const ACCESS_REFUSED =
  /review team|aren’t a member|not a member of that server|export roles|delete roles/i;

export function accessRefusal(error: unknown): string | null {
  if (!(error instanceof Error)) return null;
  if (failureKind(error) === 'not-member') return 'You’re no longer a member of this server.';
  return ACCESS_REFUSED.test(error.message) ? error.message : null;
}

// Not readFailure alone: the api answers in whole sentences, and readFailure would replace them.
export function applicationsReadFailure(error: unknown, what: string): string {
  if (
    error instanceof Error &&
    failureKind(error) === 'unknown' &&
    /^[A-Z].*[.!]$/.test(error.message.trim())
  ) {
    return `Couldn’t load ${what}. ${error.message.trim()}`;
  }

  return readFailure(error, what);
}

export interface ActionFailure {
  tone: 'warning' | 'danger';
  message: string;
}

export function actionFailure(error: Error, attempt: string): ActionFailure {
  if (failureKind(error) === 'unknown' && error.message.trim() !== '') {
    return { tone: 'danger', message: error.message };
  }

  return { tone: 'danger', message: saveFailure(error, attempt) };
}

export function readableOutcome(message: string): string {
  return message
    .replace(/<@&\d+>/g, 'a role')
    .replace(/<@!?\d+>/g, 'a member')
    .replace(/<#\d+>/g, 'a channel')
    .replace(/<t:\d+(?::[tTdDfFR])?>/g, 'recently')
    .replace(/`([^`\n]+)`/g, '$1')
    .replace(/\*\*([^*\n]+)\*\*/g, '$1');
}

export function filenameOf(disposition: string | null, fallback: string): string {
  const match = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disposition ?? '');
  const name = match?.[1]?.trim();
  if (name === undefined || name === '') return fallback;

  try {
    return decodeURIComponent(name).replace(/[\\/]/g, '-');
  } catch {
    return name.replace(/[\\/]/g, '-');
  }
}

export function exportedLine(rows: number, truncated: boolean): string {
  if (truncated) {
    return (
      `Downloaded the first ${rows.toLocaleString('en-GB')} applications. Narrow the filters ` +
      'to get the rest.'
    );
  }
  if (rows === 0) return 'Downloaded a file with no applications in it. Nothing matched.';

  const noun = rows === 1 ? 'application' : 'applications';
  return `Downloaded ${rows.toLocaleString('en-GB')} ${noun}.`;
}
