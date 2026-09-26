import type {
  ApplicationLifecycle,
  ApplicationLifecycleEvent,
  ApplicationStatus,
} from '@proton/core';
import { SWEEP_STEP_MS } from './constants.ts';
import type { EffectKind, EffectPlan, EffectStatus } from './effects.ts';
import type { CheckedAnswer, DraftAnswers } from './questions.ts';
import type { StaffAction } from './status.ts';
import type { FormSnapshot } from './version.ts';
import type {
  DRAFT_POLICIES,
  EVENT_SOURCES,
  QueueQuery,
  QueueSummary,
  QueueView,
  THREAD_KINDS,
  VOTES,
} from './view.ts';

export type Source = (typeof EVENT_SOURCES)[number];
export type ApplicantSource = 'discord' | 'web';
export type DraftPolicy = (typeof DRAFT_POLICIES)[number];
export type ThreadKind = (typeof THREAD_KINDS)[number];
export type VoteChoice = (typeof VOTES)[number];
export type AuditSource = 'dashboard' | 'command' | 'system';

export const SWEEP_JOB = 'sweep';
export const WAKE_KEY = 'wake';

export const SUPERSEDED_KINDS: readonly EffectKind[] = [
  'dm',
  'ping',
  'add_role',
  'remove_role',
  'reminder',
];
export const SUPERSEDED_TRIGGERS: readonly string[] = ['accepted', 'rejected'];
export const CHANGED_CODE = 'changed';
export const CHANGED_ERROR = 'Skipped because the application changed after this was queued.';

// Strictly future: a running sweep holds its past-due row, and a wake sharing that key is dropped.
export function wakeSlot(at: number): number {
  return Math.floor(at / SWEEP_STEP_MS) * SWEEP_STEP_MS + SWEEP_STEP_MS;
}

export interface ApplicationRecord {
  id: string;
  guildId: string;
  number: number | null;
  formId: string;
  versionId: string;
  applicantId: string;
  applicantName: string | null;
  status: ApplicationStatus;
  revision: number;
  draft: DraftAnswers;
  step: number;
  answers: CheckedAnswer[] | null;
  source: ApplicantSource | null;
  assigneeId: string | null;
  assignedAt: number | null;
  submittedAt: number | null;
  reviewStartedAt: number | null;
  infoRequestedAt: number | null;
  infoDueAt: number | null;
  waitlistedAt: number | null;
  decidedAt: number | null;
  decidedBy: string | null;
  decisionReason: string | null;
  withdrawnAt: number | null;
  reopenedCount: number;
  archivedAt: number | null;
  expiresAt: number | null;
  reviewDueAt: number | null;
  remindedAt: number | null;
  contentPurgeAt: number | null;
  contentPurgedAt: number | null;
  deletedAt: number | null;
  dmChannelId: string | null;
  cardChannelId: string | null;
  cardMessageId: string | null;
  cardRevision: number;
  interviewTicketId: string | null;
  interviewChannelId: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface FormVersionRecord {
  id: string;
  guildId: string;
  formId: string;
  version: number;
  snapshot: FormSnapshot;
  draftPolicy: DraftPolicy;
  publishedBy: string;
  publishedAt: number;
}

export interface EffectRecord {
  id: string;
  guildId: string;
  applicationId: string;
  key: string;
  kind: EffectKind;
  trigger: string;
  revision: number;
  params: Record<string, unknown>;
  status: EffectStatus;
  attempts: number;
  claimSeq: number;
  leaseUntil: number | null;
  nextAttemptAt: number;
  result: Record<string, unknown>;
  errorCode: string | null;
  error: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface EventRecord {
  id: string;
  kind: string;
  actorId: string;
  source: Source;
  fromStatus: ApplicationStatus | null;
  toStatus: ApplicationStatus | null;
  revision: number;
  data: Record<string, unknown>;
  createdAt: number;
}

export interface ThreadRecord {
  id: string;
  kind: ThreadKind;
  authorId: string;
  body: string | null;
  revision: number;
  createdAt: number;
}

export interface NoteRecord {
  id: string;
  authorId: string;
  body: string | null;
  createdAt: number;
}

export interface VoteRecord {
  reviewerId: string;
  vote: VoteChoice;
  score: number | null;
  updatedAt: number;
}

export interface VoteTally {
  accept: number;
  reject: number;
}

export interface AuditInput {
  actorId: string;
  source: AuditSource;
  action: string;
  id: string;
  before?: unknown;
  after?: unknown;
  ipHash?: string | null | undefined;
}

export interface Actor {
  id: string;
  source: Source;
}

export type PlanEffects = (application: ApplicationRecord, revision: number) => EffectPlan[];

export interface PublishInput {
  guildId: string;
  formId: string;
  snapshot: FormSnapshot;
  draftPolicy: DraftPolicy;
  publishedBy: string;
  audit: AuditInput;
  now?: number | undefined;
}

export interface PublishOutcome {
  status: 'published' | 'unchanged';
  version: FormVersionRecord;
  draftsExpired: number;
}

export interface FormCounts {
  awaiting: number;
  needsInfo: number;
  drafts: number;
  total: number;
  submittedForCap: number;
}

export interface StartDraftInput {
  guildId: string;
  formId: string;
  versionId: string;
  applicantId: string;
  applicantName: string | null;
  expiresAt: number;
  source: Source;
  now?: number | undefined;
}

export interface SaveDraftInput {
  guildId: string;
  applicationId: string;
  applicantId: string;
  expectedRevision: number | null;
  answers: DraftAnswers;
  mode: 'merge' | 'replace';
  step?: number | undefined;
  expiresAt: number;
  now?: number | undefined;
}

export type SaveDraftResult =
  | { status: 'saved'; application: ApplicationRecord }
  | { status: 'conflict'; application: ApplicationRecord }
  | { status: 'gone' };

export interface SubmitLimits {
  cap?: number | undefined;
  cooldownDays: number;
  maxActive: number;
}

export type SubmitRefusalCode = 'not_draft' | 'conflict' | 'cap' | 'cooldown' | 'active';

export interface SubmitInput {
  guildId: string;
  applicationId: string;
  applicantId: string;
  expectedRevision: number | null;
  answers: CheckedAnswer[];
  source: Source;
  applicantName: string | null;
  limits: SubmitLimits;
  reviewDueAt: number | null;
  plan: PlanEffects;
  lifecycle: Omit<ApplicationLifecycle, 'number' | 'revision' | 'status' | 'occurredAt'>;
  now?: number | undefined;
}

export type SubmitResult =
  | { status: 'submitted'; application: ApplicationRecord; effects: EffectRecord[] }
  | {
      status: 'refused';
      code: SubmitRefusalCode;
      message: string;
      retryAt?: number;
      existingId?: string;
    };

export type TransitionAction = StaffAction | 'withdraw' | 'respond' | 'expire_info' | 'reminded';

export type TransitionPatch = Partial<
  Pick<
    ApplicationRecord,
    | 'status'
    | 'assigneeId'
    | 'assignedAt'
    | 'reviewStartedAt'
    | 'infoRequestedAt'
    | 'infoDueAt'
    | 'waitlistedAt'
    | 'decidedAt'
    | 'decidedBy'
    | 'decisionReason'
    | 'withdrawnAt'
    | 'reopenedCount'
    | 'archivedAt'
    | 'reviewDueAt'
    | 'remindedAt'
    | 'contentPurgeAt'
  >
>;

export interface TransitionExpect {
  statuses?: readonly ApplicationStatus[] | undefined;
  assigneeId?: string | null | undefined;
  revision?: number | undefined;
}

export interface TransitionInput {
  guildId: string;
  applicationId: string;
  action: TransitionAction;
  actor: Actor;
  expect: TransitionExpect;
  patch: TransitionPatch;
  thread?: { kind: ThreadKind; body: string } | undefined;
  note?: { body: string } | undefined;
  vote?: { vote: VoteChoice; score: number | null } | undefined;
  event: {
    kind: string;
    id?: string | undefined;
    lifecycle?: ApplicationLifecycleEvent | undefined;
    data?: Record<string, unknown> | undefined;
  };
  plan?: PlanEffects | undefined;
  audit?: AuditInput | undefined;
  bumpRevision?: boolean | undefined;
  clearVotes?: boolean | undefined;
  supersede?: boolean | undefined;
  now?: number | undefined;
}

export type TransitionResult =
  | { status: 'done'; application: ApplicationRecord; effects: EffectRecord[] }
  | { status: 'stale'; application: ApplicationRecord | null };

export interface ApplicationDetailRecord {
  application: ApplicationRecord;
  thread: ThreadRecord[];
  notes: NoteRecord[];
  votes: VoteRecord[];
  events: EventRecord[];
  effects: EffectRecord[];
}

export type ListQuery = QueueQuery & { formIds: readonly string[]; viewerId: string };

export interface ListResult {
  items: ApplicationRecord[];
  total: number;
  problems: Map<string, EffectRecord[]>;
  votes: Map<string, VoteTally>;
}

export interface DueWork {
  effects: EffectRecord[];
  reminders: ApplicationRecord[];
  infoExpiries: ApplicationRecord[];
  nextDueAt: number | null;
}

export interface EffectClaim {
  effect: EffectRecord;
  token: number;
}

export interface EffectOutcome {
  status: 'succeeded' | 'failed' | 'skipped' | 'requested' | 'pending';
  result?: Record<string, unknown> | undefined;
  errorCode?: string | null | undefined;
  error?: string | null | undefined;
  nextAttemptAt?: number | undefined;
}

export interface RequestAnswer {
  status: 'succeeded' | 'failed';
  result?: Record<string, unknown> | undefined;
  errorCode?: string | null | undefined;
  error?: string | null | undefined;
}

export type RequestedEffect =
  | { applicationId: string; effectKey: string }
  | { applicationId: string; effectId: string };

export interface DeleteApplicationInput {
  guildId: string;
  applicationId: string;
  actor: Actor;
  audit: AuditInput;
  cleanup?: PlanEffects | undefined;
  now?: number | undefined;
}

export type DeleteApplicationResult =
  | { status: 'deleted'; application: ApplicationRecord }
  | { status: 'missing' };

export interface DeleteApplicantInput {
  guildId: string;
  applicantId: string;
  actor: Actor;
  audit: AuditInput;
  cleanup?: PlanEffects | undefined;
  now?: number | undefined;
}

export interface ExportRowsQuery {
  formIds: readonly string[];
  formId?: string | undefined;
  view: QueueView;
  from?: number | undefined;
  to?: number | undefined;
  viewerId: string;
}

export interface ApplicationStore {
  now(): Promise<number>;

  latestVersions(guildId: string): Promise<Map<string, FormVersionRecord>>;
  version(guildId: string, versionId: string): Promise<FormVersionRecord | null>;
  versions(guildId: string, formId: string): Promise<FormVersionRecord[]>;
  publish(input: PublishInput): Promise<PublishOutcome>;
  counts(guildId: string): Promise<Map<string, FormCounts>>;
  draftCount(guildId: string, formId: string, olderThanVersionId?: string): Promise<number>;

  get(guildId: string, id: string): Promise<ApplicationRecord | null>;
  byNumber(guildId: string, number: number): Promise<ApplicationRecord | null>;
  draftFor(guildId: string, formId: string, applicantId: string): Promise<ApplicationRecord | null>;
  mine(guildId: string | null, applicantId: string): Promise<ApplicationRecord[]>;
  startDraft(
    input: StartDraftInput,
  ): Promise<{ status: 'started' | 'existing'; application: ApplicationRecord }>;
  saveDraft(input: SaveDraftInput): Promise<SaveDraftResult>;
  discardDraft(guildId: string, applicationId: string, applicantId: string): Promise<boolean>;
  submit(input: SubmitInput): Promise<SubmitResult>;
  transition(input: TransitionInput): Promise<TransitionResult>;
  votes(guildId: string, applicationId: string): Promise<VoteRecord[]>;
  detail(guildId: string, applicationId: string): Promise<ApplicationDetailRecord | null>;
  list(guildId: string, query: ListQuery): Promise<ListResult>;
  summary(guildId: string, formIds: readonly string[], viewerId: string): Promise<QueueSummary>;

  dueWork(guildId: string, now: number, limit: number): Promise<DueWork>;
  claimEffect(
    guildId: string,
    effectId: string,
    now: number,
    leaseMs: number,
  ): Promise<EffectClaim | null>;
  finishEffect(
    guildId: string,
    effectId: string,
    token: number,
    outcome: EffectOutcome,
  ): Promise<boolean>;
  answerRequested(
    guildId: string,
    key: RequestedEffect,
    outcome: RequestAnswer,
  ): Promise<EffectRecord | null>;
  retryEffect(
    guildId: string,
    applicationId: string,
    effectId: string,
    actor: Actor,
    audit?: AuditInput,
  ): Promise<EffectRecord | null>;
  cancelEffect(
    guildId: string,
    applicationId: string,
    effectId: string,
    actor: Actor,
    audit?: AuditInput,
  ): Promise<EffectRecord | null>;
  armWake(guildId: string, at: number): Promise<void>;
  rememberCard(
    guildId: string,
    applicationId: string,
    channelId: string,
    messageId: string,
    revision: number,
  ): Promise<boolean>;
  queueCardRemoval(
    guildId: string,
    applicationId: string,
    channelId: string,
    messageId: string,
  ): Promise<void>;
  rememberDm(guildId: string, applicationId: string, channelId: string): Promise<void>;
  recordRoleGrant(
    guildId: string,
    applicationId: string,
    userId: string,
    roleId: string,
  ): Promise<void>;
  grantedRoles(guildId: string, applicationId: string): Promise<string[]>;
  markRoleRemoved(guildId: string, applicationId: string, roleId: string): Promise<void>;
  rememberInterview(
    guildId: string,
    applicationId: string,
    ticketId: string,
    channelId: string | null,
  ): Promise<void>;

  expireIdleDrafts(now: number, limit: number): Promise<number>;
  restartDrafts(
    guildId: string,
    formId: string,
    keepVersionId: string,
    actorId: string,
  ): Promise<number>;
  purgeContent(now: number, limit: number): Promise<number>;
  extendInfoDeadlines(guildId: string, minDueAt: number): Promise<number>;
  rescheduleRetention(guildId: string, retentionDays: number): Promise<number>;
  deleteApplication(input: DeleteApplicationInput): Promise<DeleteApplicationResult>;
  deleteApplicant(input: DeleteApplicantInput): Promise<{ deleted: number }>;
  exportRows(
    guildId: string,
    query: ExportRowsQuery,
    limit: number,
  ): Promise<{ rows: ApplicationRecord[]; truncated: boolean }>;
}
