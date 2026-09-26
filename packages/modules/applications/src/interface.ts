import { encodeCustomId, type ProtonCustomId, parseCustomId } from '@proton/core';
import { MODULE_ID } from './constants.ts';

export const APPLICANT_ACTION = {
  open: 'o',
  openSelect: 'os',
  mine: 'mine',
  start: 'st',
  step: 'sp',
  answer: 'ans',
  review: 'rvw',
  submit: 'sub',
  later: 'later',
  cancel: 'cx',
  cancelConfirm: 'cxok',
  view: 'view',
  withdraw: 'wd',
  withdrawConfirm: 'wdok',
  respond: 'resp',
  respondModal: 'respm',
} as const;

export const STAFF_ACTION = {
  claim: 'cl',
  unclaim: 'ucl',
  accept: 'acc',
  acceptModal: 'accm',
  reject: 'rej',
  rejectModal: 'rejm',
  more: 'more',
  infoModal: 'infom',
  waitlistModal: 'waitm',
  noteModal: 'notem',
  voteModal: 'votem',
  read: 'read',
  card: 'card',
} as const;

export const MORE_CHOICES = {
  info: 'info',
  waitlist: 'wait',
  note: 'note',
  voteAccept: 'va',
  voteReject: 'vr',
  ticket: 'tkt',
  read: 'read',
} as const;

export type ApplicantActionCode = (typeof APPLICANT_ACTION)[keyof typeof APPLICANT_ACTION];
export type StaffActionCode = (typeof STAFF_ACTION)[keyof typeof STAFF_ACTION];

const APPLICANT_CODES: ReadonlySet<string> = new Set(Object.values(APPLICANT_ACTION));
const STAFF_CODES: ReadonlySet<string> = new Set(Object.values(STAFF_ACTION));

export function isApplicantAction(action: string): action is ApplicantActionCode {
  return APPLICANT_CODES.has(action);
}

export function isStaffAction(action: string): action is StaffActionCode {
  return STAFF_CODES.has(action);
}

export class CustomIdTooLongError extends Error {
  constructor(humanReason: string) {
    super(humanReason);
    this.name = 'CustomIdTooLongError';
  }
}

// Every id is built from bounded slugs and ULIDs, so a refusal here is a bug, never member input.
export function customId(action: ApplicantActionCode | StaffActionCode, ...args: string[]): string {
  const encoded = encodeCustomId(MODULE_ID, action, ...args);
  if (!encoded.ok) throw new CustomIdTooLongError(encoded.humanReason);
  return encoded.customId;
}

export function readCustomId(raw: unknown): ProtonCustomId | null {
  const parsed = parseCustomId(raw);
  return parsed && parsed.moduleId === MODULE_ID ? parsed : null;
}
