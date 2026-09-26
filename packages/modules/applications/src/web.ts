import type { ApplicationStatus } from '@proton/core';
import { isActive, STATUS_LABELS } from './status.ts';

export {
  ACTIVE_STATUSES,
  FINAL_STATUSES,
  isActive,
  isFinal,
  STATUS_LABELS,
} from './status.ts';

export const DAY_MS = 24 * 60 * 60 * 1000;

export const APPLICANT_THREAD_KINDS = ['info_request', 'info_response', 'decision'] as const;

export function dayCount(days: number): string {
  return `${days} ${days === 1 ? 'day' : 'days'}`;
}

export function referenceOf(number: number | null): string {
  return number === null ? '' : `#${number}`;
}

export function canWithdraw(status: ApplicationStatus): boolean {
  return isActive(status);
}

export function canRespond(status: ApplicationStatus): boolean {
  return status === 'needs_info';
}

const SENTENCES: Readonly<Record<ApplicationStatus, string>> = {
  draft: 'Your answers are saved, but the application hasn’t been sent yet.',
  submitted: 'Your application has been sent.',
  in_review: 'Staff are reviewing your application.',
  needs_info: 'We need a little more information.',
  waitlisted: 'Your application is on the waitlist. Staff will come back to it later.',
  accepted: 'Your application was accepted.',
  rejected: 'Your application wasn’t accepted this time.',
  withdrawn: 'You withdrew this application.',
  expired: 'This application has expired.',
};

export function statusSentence(status: ApplicationStatus): string {
  return SENTENCES[status];
}

export function portalStatus(application: { status: ApplicationStatus }): {
  status: ApplicationStatus;
  label: string;
  sentence: string;
  canWithdraw: boolean;
  canRespond: boolean;
} {
  const { status } = application;

  return {
    status,
    label: STATUS_LABELS[status],
    sentence: statusSentence(status),
    canWithdraw: canWithdraw(status),
    canRespond: canRespond(status),
  };
}

export function applicantThread<T extends { kind: string }>(thread: readonly T[]): T[] {
  const shown: ReadonlySet<string> = new Set(APPLICANT_THREAD_KINDS);
  return thread.filter((entry) => shown.has(entry.kind));
}
