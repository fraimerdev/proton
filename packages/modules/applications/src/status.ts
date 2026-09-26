import {
  APPLICATION_STATUSES,
  type ApplicationLifecycleEvent,
  type ApplicationStatus,
} from '@proton/core';

export const ACTIVE_STATUSES = [
  'submitted',
  'in_review',
  'needs_info',
  'waitlisted',
] as const satisfies readonly ApplicationStatus[];

export const FINAL_STATUSES = [
  'accepted',
  'rejected',
  'withdrawn',
  'expired',
] as const satisfies readonly ApplicationStatus[];

export const STAFF_ACTIONS = [
  'claim',
  'unclaim',
  'assign',
  'request_info',
  'waitlist',
  'accept',
  'reject',
  'reopen',
  'archive',
  'unarchive',
  'note',
  'vote',
  'open_ticket',
  'retry_effect',
  'cancel_effect',
  'repost_card',
  'delete',
] as const;
export type StaffAction = (typeof STAFF_ACTIONS)[number];

export const APPLICANT_ACTIONS = ['submit', 'withdraw', 'respond'] as const;
export type ApplicantAction = (typeof APPLICANT_ACTIONS)[number];

export const TRANSITION_ACTIONS = [
  'claim',
  'unclaim',
  'assign',
  'request_info',
  'waitlist',
  'accept',
  'reject',
  'reopen',
  'withdraw',
  'respond',
  'submit',
  'expire_draft',
  'expire_info',
] as const;
export type TransitionAction = (typeof TRANSITION_ACTIONS)[number];

export type TransitionTarget = ApplicationStatus | 'in_review_or_submitted';

const PENDING = ['submitted', 'in_review', 'needs_info', 'waitlisted'] as const;

export const TRANSITIONS: Readonly<
  Record<TransitionAction, { from: readonly ApplicationStatus[]; to: TransitionTarget }>
> = {
  submit: { from: ['draft'], to: 'submitted' },
  claim: { from: ['submitted', 'waitlisted', 'needs_info', 'in_review'], to: 'in_review' },
  assign: {
    from: ['submitted', 'waitlisted', 'needs_info', 'in_review'],
    to: 'in_review_or_submitted',
  },
  unclaim: { from: ['in_review'], to: 'submitted' },
  request_info: { from: ['submitted', 'in_review', 'waitlisted'], to: 'needs_info' },
  respond: { from: ['needs_info'], to: 'in_review_or_submitted' },
  waitlist: { from: ['submitted', 'in_review', 'needs_info'], to: 'waitlisted' },
  accept: { from: PENDING, to: 'accepted' },
  reject: { from: PENDING, to: 'rejected' },
  withdraw: { from: PENDING, to: 'withdrawn' },
  reopen: { from: ['accepted', 'rejected'], to: 'in_review_or_submitted' },
  expire_draft: { from: ['draft'], to: 'expired' },
  expire_info: { from: ['needs_info'], to: 'expired' },
};

export const STATUS_LABELS: Readonly<Record<ApplicationStatus, string>> = {
  draft: 'Draft',
  submitted: 'Submitted',
  in_review: 'In review',
  needs_info: 'Needs information',
  waitlisted: 'Waitlisted',
  accepted: 'Accepted',
  rejected: 'Rejected',
  withdrawn: 'Withdrawn',
  expired: 'Expired',
};

export function isActive(status: ApplicationStatus): boolean {
  return (ACTIVE_STATUSES as readonly ApplicationStatus[]).includes(status);
}

export function isFinal(status: ApplicationStatus): boolean {
  return (FINAL_STATUSES as readonly ApplicationStatus[]).includes(status);
}

export function mayTransition(action: TransitionAction, from: ApplicationStatus): boolean {
  return TRANSITIONS[action].from.includes(from);
}

// Assigning never changes needs_info, and unassigning only sends in_review back to submitted.
export function nextStatus(
  action: TransitionAction,
  from: ApplicationStatus,
  assigned: boolean,
): ApplicationStatus | null {
  if (!mayTransition(action, from)) return null;

  const { to } = TRANSITIONS[action];

  if (action === 'claim' || action === 'assign') {
    if (from === 'needs_info') return 'needs_info';
    if (action === 'claim' || assigned) return 'in_review';
    return from === 'in_review' ? 'submitted' : from;
  }

  if (to === 'in_review_or_submitted') return assigned ? 'in_review' : 'submitted';
  return to;
}

const NON_DRAFT = APPLICATION_STATUSES.filter((status) => status !== 'draft');

export function allowedFrom(action: StaffAction | ApplicantAction): readonly ApplicationStatus[] {
  switch (action) {
    case 'archive':
    case 'unarchive':
      return FINAL_STATUSES;
    case 'vote':
    case 'open_ticket':
      return ACTIVE_STATUSES;
    case 'note':
    case 'retry_effect':
    case 'cancel_effect':
    case 'repost_card':
      return NON_DRAFT;
    case 'delete':
      return APPLICATION_STATUSES;
    default:
      return TRANSITIONS[action].from;
  }
}

export function lifecycleEventFor(
  action: TransitionAction,
  from: ApplicationStatus,
  to: ApplicationStatus,
): ApplicationLifecycleEvent | null {
  switch (action) {
    case 'submit':
      return 'applications.submitted';
    case 'claim':
    case 'assign':
      return to === 'in_review' && from !== 'in_review' ? 'applications.review_started' : null;
    case 'request_info':
      return 'applications.information_requested';
    case 'respond':
      return 'applications.information_provided';
    case 'waitlist':
      return 'applications.waitlisted';
    case 'accept':
      return 'applications.accepted';
    case 'reject':
      return 'applications.rejected';
    case 'withdraw':
      return 'applications.withdrawn';
    case 'reopen':
      return 'applications.reopened';
    case 'expire_info':
      return 'applications.expired';
    case 'unclaim':
    case 'expire_draft':
      return null;
  }
}
