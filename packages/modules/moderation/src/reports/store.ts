import type {
  AutomationRun,
  AutomationRunStatus,
  CardState,
  CloseAction,
  EvidenceCopy,
  NotificationKind,
  NotificationOutcome,
  ReportEventKind,
  ReportEventRecord,
  ReportEventSource,
  ReportEvidence,
  ReportMethod,
  ReportRecord,
  ReportRefusalCode,
  ReportStatus,
  ResolvedReportStatus,
  RunOutcome,
} from './types.ts';

export const SUBMIT_ID_ATTEMPTS = 5;
export const CARD_ATTEMPTS_MAX = 5;
export const CLOSE_ATTEMPTS_MAX = 10;

export interface ReportSource {
  channelId: string;
  messageId: string;
  authorId: string | null;
}

export interface NewReport {
  guildId: string;
  reporterId: string;
  targetId: string;
  method: ReportMethod;
  reasonId: string | null;
  reason: string | null;
  customReason: string | null;
  comment: string | null;
  source: ReportSource | null;
  evidence: ReportEvidence;
  idempotencyKey: string;
  now: number;
}

export interface SubmitLimits {
  cooldownMs: number;
  bypassCooldown: boolean;
  duplicateProtection: boolean;
  maxOpenPerMember: number;
  maxOpenPerServer: number;
}

export type SubmitResult =
  | { status: 'filed' | 'existing'; report: ReportRecord }
  | { status: 'refused'; code: ReportRefusalCode; retryAt?: number; reportId?: string };

export interface BeginDecisionInput {
  guildId: string;
  id: string;
  token: string;
  kind: string;
  now: number;
  staleMs: number;
}

export interface BeginDecisionResult {
  state: 'acquired' | 'held_by_other' | 'resolved' | 'missing';
  mine: boolean;
  takeover: { token: string; kind: string | null } | null;
  report: ReportRecord | null;
}

export interface ResolveInput {
  guildId: string;
  id: string;
  status: ResolvedReportStatus;
  by: string;
  at: number;
  note: string | null;
  reporterNote: string | null;
  actionKind: string | null;
  caseIds: string[];
  token: string;
  evidenceExpiresAt: number;
  close: { action: CloseAction | null; dueAt: number | null };
}

export interface ReportEventInput {
  id: string;
  reportId: string;
  guildId: string;
  kind: ReportEventKind;
  actorId: string | null;
  source: ReportEventSource;
  data?: Record<string, unknown>;
  at?: number;
}

export interface TargetStats {
  total: number;
  distinctReporters: number;
  open: number;
}

export interface QualifyingQuery {
  since: number;
  lastRun: { coveredUntil: number; reportIds: readonly string[] } | null;
  statuses: readonly ReportStatus[];
  uncoveredBy?: string;
}

export interface QualifyingReport {
  id: string;
  reporterId: string;
  status: ReportStatus;
  assigneeId: string | null;
  createdAt: number;
}

export interface ClaimRunInput {
  id: string;
  guildId: string;
  ruleId: string;
  ruleName: string;
  targetId: string;
  episodeStart: number;
  reportIds: readonly string[];
  now: number;
  leaseMs: number;
}

export interface CardRefs {
  channelId: string | null;
  messageId: string | null;
  copy: { channelId: string; messageId: string } | null;
}

export interface ReportStore {
  submit(input: NewReport, limits: SubmitLimits): Promise<SubmitResult>;

  get(guildId: string, id: string): Promise<ReportRecord | null>;
  byCardMessage(guildId: string, messageId: string): Promise<ReportRecord | null>;
  byIdempotency(guildId: string, key: string): Promise<ReportRecord | null>;

  claim(guildId: string, id: string, assigneeId: string, now: number): Promise<ReportRecord | null>;
  assign(
    guildId: string,
    id: string,
    assigneeId: string | null,
    now: number,
  ): Promise<ReportRecord | null>;
  unclaim(guildId: string, id: string, now: number): Promise<ReportRecord | null>;

  beginDecision(input: BeginDecisionInput): Promise<BeginDecisionResult>;
  releaseDecision(guildId: string, id: string, token: string): Promise<void>;
  resolve(input: ResolveInput): Promise<ReportRecord | null>;
  linkCase(guildId: string, id: string, caseId: string): Promise<ReportRecord | null>;

  noteCardAttempt(guildId: string, id: string): Promise<number>;
  rememberCard(
    guildId: string,
    id: string,
    card: { channelId: string; messageId: string },
  ): Promise<ReportRecord | null>;
  rememberEvidenceCopy(guildId: string, id: string, copy: EvidenceCopy): Promise<void>;
  markCard(
    guildId: string,
    id: string,
    state: CardState,
    options?: { error?: string; messageId?: string },
  ): Promise<ReportRecord | null>;
  bumpVersion(guildId: string, id: string): Promise<number | null>;
  markCardVersion(guildId: string, id: string, version: number): Promise<void>;
  noteCardEditFailure(guildId: string, id: string): Promise<void>;

  scheduleClose(guildId: string, id: string, action: CloseAction, dueAt: number): Promise<void>;
  noteCloseAttempt(guildId: string, id: string): Promise<number>;
  moveCard(
    guildId: string,
    id: string,
    refs: CardRefs,
    state: CardState,
  ): Promise<ReportRecord | null>;
  markClosed(
    guildId: string,
    id: string,
    state: CardState,
    at: number,
  ): Promise<ReportRecord | null>;
  markCloseFailed(guildId: string, id: string, error: string): Promise<void>;

  recordNotification(
    guildId: string,
    id: string,
    kind: NotificationKind,
    outcome: NotificationOutcome,
    at: number,
  ): Promise<void>;
  rememberDm(guildId: string, id: string, channelId: string): Promise<void>;
  noteDmAttempt(guildId: string, id: string): Promise<number>;

  recordEvent(event: ReportEventInput): Promise<void>;
  listEvents(guildId: string, id: string): Promise<ReportEventRecord[]>;

  targetStats(guildId: string, targetId: string, sinceMs: number): Promise<TargetStats>;
  qualifying(
    guildId: string,
    targetId: string,
    query: QualifyingQuery,
  ): Promise<QualifyingReport[]>;
  targetsWithOpenUnclaimed(
    guildId: string,
    before: number,
    limit: number,
    afterTargetId: string | null,
  ): Promise<string[]>;
  deliveryBacklog(guildId: string, now: number, limit: number): Promise<ReportRecord[]>;
  unfinishedResolutions(guildId: string, limit: number): Promise<ReportRecord[]>;
  dueCloses(guildId: string, now: number, limit: number): Promise<ReportRecord[]>;
  purgeExpiredEvidence(now: number, limit: number): Promise<number>;

  claimRun(input: ClaimRunInput): Promise<AutomationRun | null>;
  lastRun(guildId: string, ruleId: string, targetId: string): Promise<AutomationRun | null>;
  recordRunOutcome(guildId: string, runId: string, outcome: RunOutcome): Promise<void>;
  renewLease(guildId: string, runId: string, leaseUntil: number): Promise<boolean>;
  finishRun(
    guildId: string,
    runId: string,
    status: Exclude<AutomationRunStatus, 'running'>,
    at: number,
  ): Promise<void>;
  staleRuns(guildId: string, now: number, limit: number): Promise<AutomationRun[]>;
  resumeRun(
    guildId: string,
    runId: string,
    now: number,
    leaseMs: number,
  ): Promise<AutomationRun | null>;
}

export function cardBackoffMs(attempts: number): number {
  return 2 ** attempts * 60 * 1000;
}

export function closeBackoffMs(attempts: number): number {
  return Math.min(2 ** attempts * 60 * 1000, 60 * 60 * 1000);
}
