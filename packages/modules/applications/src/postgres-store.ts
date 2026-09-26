import {
  APPLICATION_STATUSES,
  type ApplicationLifecycle,
  type ApplicationStatus,
  MODULE_JOB_KIND,
  moduleScheduleKey,
  newId,
} from '@proton/core';
import { auditTrail, type DbHandle, scheduledActions } from '@proton/db';
import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  ne,
  or,
  type SQL,
  sql,
} from 'drizzle-orm';
import { APPLICATIONS_ACTOR, MODULE_ID, REQUEST_ANSWER_TIMEOUT_MS } from './constants.ts';
import { CARD_KEY, DELETE_CARD_KEY, deleteCardPlan, type EffectPlan, XP_KEY } from './effects.ts';
import {
  type CheckedAnswer,
  checkedAnswerSchema,
  type DraftAnswers,
  rawAnswerSchema,
} from './questions.ts';
import { ACTIVE_STATUSES, FINAL_STATUSES } from './status.ts';
import {
  type Actor,
  type ApplicantSource,
  type ApplicationDetailRecord,
  type ApplicationRecord,
  type ApplicationStore,
  type AuditInput,
  CHANGED_CODE,
  CHANGED_ERROR,
  type DeleteApplicantInput,
  type DeleteApplicationInput,
  type DeleteApplicationResult,
  type DueWork,
  type EffectClaim,
  type EffectOutcome,
  type EffectRecord,
  type EventRecord,
  type ExportRowsQuery,
  type FormCounts,
  type FormVersionRecord,
  type ListQuery,
  type ListResult,
  type NoteRecord,
  type PlanEffects,
  type PublishInput,
  type PublishOutcome,
  type RequestAnswer,
  type RequestedEffect,
  type SaveDraftInput,
  type SaveDraftResult,
  type Source,
  type StartDraftInput,
  SUPERSEDED_KINDS,
  SUPERSEDED_TRIGGERS,
  type SubmitInput,
  type SubmitRefusalCode,
  type SubmitResult,
  SWEEP_JOB,
  type ThreadRecord,
  type TransitionExpect,
  type TransitionInput,
  type TransitionPatch,
  type TransitionResult,
  type VoteRecord,
  type VoteTally,
  WAKE_KEY,
  wakeSlot,
} from './store.ts';
import {
  type ApplicationEffectRow,
  type ApplicationEventRow,
  type ApplicationFormVersionRow,
  type ApplicationNoteRow,
  type ApplicationRow,
  type ApplicationThreadRow,
  type ApplicationVoteRow,
  applicationEffects,
  applicationEvents,
  applicationFormVersions,
  applicationNotes,
  applicationRoleGrants,
  applications,
  applicationThread,
  applicationVotes,
} from './table.ts';
import { formSnapshotSchema, sameSnapshot } from './version.ts';
import {
  DRAFT_POLICIES,
  EFFECT_KINDS,
  EFFECT_STATUSES,
  EVENT_SOURCES,
  type QueueSummary,
  type QueueView,
  THREAD_KINDS,
  VOTES,
} from './view.ts';

type Tx = Parameters<Parameters<DbHandle['db']['transaction']>[0]>[0];
type NewApplicationRow = typeof applications.$inferInsert;

const DAY_MS = 24 * 60 * 60 * 1000;
const INTAKE_LOCK = 'applications:intake:';
const MINE_LIMIT = 100;
const AWAITING: ApplicationStatus[] = ['submitted', 'in_review'];
const REVIEW_DUE: ApplicationStatus[] = ['submitted', 'in_review'];
const LEASED = ['running', 'requested'];
const UNFINISHED = ['pending', 'failed', 'running', 'requested'];
const XP_REPLANNABLE = ['failed', 'skipped', 'cancelled'];

const MESSAGES: Readonly<Record<SubmitRefusalCode | 'missing' | 'restarted', string>> = {
  missing: 'This draft no longer exists, so there’s nothing to send.',
  restarted: 'This draft was cleared because the form changed. Start again to apply.',
  not_draft: 'This application has already been sent.',
  conflict:
    'These answers changed somewhere else since they were opened. Review them and send again.',
  active: 'There’s already an application for this form waiting for review.',
  cooldown: 'This form was applied to recently. Applying again opens once the waiting time ends.',
  cap: 'This form has all the applications it can take right now.',
};

function ms(value: Date | null): number | null {
  return value === null ? null : value.getTime();
}

function dated(value: number | null): Date | null {
  return value === null ? null : new Date(value);
}

function iso(at: number): string {
  return new Date(at).toISOString();
}

function member<T extends string>(values: readonly T[], value: string, what: string): T {
  const found = values.find((candidate) => candidate === value);
  if (found === undefined) {
    throw new Error(`${what} "${value}" is not one Proton knows, so the row can’t be read`);
  }
  return found;
}

function objectOf(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readDraft(value: unknown): DraftAnswers {
  const draft: DraftAnswers = {};
  for (const [key, raw] of Object.entries(objectOf(value))) {
    const parsed = rawAnswerSchema.safeParse(raw);
    if (parsed.success) draft[key] = parsed.data;
  }
  return draft;
}

function readAnswers(value: unknown): CheckedAnswer[] | null {
  if (!Array.isArray(value)) return null;
  return value.flatMap((entry) => {
    const parsed = checkedAnswerSchema.safeParse(entry);
    return parsed.success ? [parsed.data] : [];
  });
}

function applicantSource(source: string | null): ApplicantSource | null {
  return source === 'discord' || source === 'web' ? source : null;
}

function statusOrNull(value: string | null): ApplicationStatus | null {
  return value === null ? null : member(APPLICATION_STATUSES, value, 'application status');
}

export function pgErrorCode(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; current !== null && current !== undefined && depth < 5; depth++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string') return code;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

function unknownServer(error: unknown, guildId: string): unknown {
  return pgErrorCode(error) === '23503'
    ? new Error(`server ${guildId} isn’t in Proton’s records yet, so nothing was saved`, {
        cause: error,
      })
    : error;
}

export function toApplicationRecord(row: ApplicationRow): ApplicationRecord {
  return {
    id: row.id,
    guildId: row.guildId,
    number: row.number,
    formId: row.formId,
    versionId: row.versionId,
    applicantId: row.applicantId,
    applicantName: row.applicantName,
    status: member(APPLICATION_STATUSES, row.status, 'application status'),
    revision: row.revision,
    draft: readDraft(row.draft),
    step: row.step,
    answers: readAnswers(row.answers),
    source: applicantSource(row.source),
    assigneeId: row.assigneeId,
    assignedAt: ms(row.assignedAt),
    submittedAt: ms(row.submittedAt),
    reviewStartedAt: ms(row.reviewStartedAt),
    infoRequestedAt: ms(row.infoRequestedAt),
    infoDueAt: ms(row.infoDueAt),
    waitlistedAt: ms(row.waitlistedAt),
    decidedAt: ms(row.decidedAt),
    decidedBy: row.decidedBy,
    decisionReason: row.decisionReason,
    withdrawnAt: ms(row.withdrawnAt),
    reopenedCount: row.reopenedCount,
    archivedAt: ms(row.archivedAt),
    expiresAt: ms(row.expiresAt),
    reviewDueAt: ms(row.reviewDueAt),
    remindedAt: ms(row.remindedAt),
    contentPurgeAt: ms(row.contentPurgeAt),
    contentPurgedAt: ms(row.contentPurgedAt),
    deletedAt: ms(row.deletedAt),
    dmChannelId: row.dmChannelId,
    cardChannelId: row.cardChannelId,
    cardMessageId: row.cardMessageId,
    cardRevision: row.cardRevision,
    interviewTicketId: row.interviewTicketId,
    interviewChannelId: row.interviewChannelId,
    createdAt: row.createdAt.getTime(),
    updatedAt: row.updatedAt.getTime(),
  };
}

export function toFormVersionRecord(row: ApplicationFormVersionRow): FormVersionRecord {
  const snapshot = formSnapshotSchema.safeParse(row.snapshot);
  if (!snapshot.success) {
    throw new Error(`form version ${row.id} holds a snapshot Proton can’t read, so it can’t load`);
  }

  return {
    id: row.id,
    guildId: row.guildId,
    formId: row.formId,
    version: row.version,
    snapshot: snapshot.data,
    draftPolicy: member(DRAFT_POLICIES, row.draftPolicy, 'draft policy'),
    publishedBy: row.publishedBy,
    publishedAt: row.publishedAt.getTime(),
  };
}

export function toEffectRecord(row: ApplicationEffectRow): EffectRecord {
  return {
    id: row.id,
    guildId: row.guildId,
    applicationId: row.applicationId,
    key: row.key,
    kind: member(EFFECT_KINDS, row.kind, 'effect kind'),
    trigger: row.trigger,
    revision: row.revision,
    params: objectOf(row.params),
    status: member(EFFECT_STATUSES, row.status, 'effect status'),
    attempts: row.attempts,
    claimSeq: row.claimSeq,
    leaseUntil: ms(row.leaseUntil),
    nextAttemptAt: row.nextAttemptAt.getTime(),
    result: objectOf(row.result),
    errorCode: row.errorCode,
    error: row.error,
    createdAt: row.createdAt.getTime(),
    updatedAt: row.updatedAt.getTime(),
  };
}

function toEvent(row: ApplicationEventRow): EventRecord {
  return {
    id: row.id,
    kind: row.kind,
    actorId: row.actorId,
    source: member(EVENT_SOURCES, row.source, 'event source'),
    fromStatus: statusOrNull(row.fromStatus),
    toStatus: statusOrNull(row.toStatus),
    revision: row.revision,
    data: objectOf(row.data),
    createdAt: row.createdAt.getTime(),
  };
}

function toThread(row: ApplicationThreadRow): ThreadRecord {
  return {
    id: row.id,
    kind: member(THREAD_KINDS, row.kind, 'thread entry kind'),
    authorId: row.authorId,
    body: row.body,
    revision: row.revision,
    createdAt: row.createdAt.getTime(),
  };
}

function toNote(row: ApplicationNoteRow): NoteRecord {
  return {
    id: row.id,
    authorId: row.authorId,
    body: row.body,
    createdAt: row.createdAt.getTime(),
  };
}

function toVote(row: ApplicationVoteRow): VoteRecord {
  return {
    reviewerId: row.reviewerId,
    vote: member(VOTES, row.vote, 'vote'),
    score: row.score,
    updatedAt: row.updatedAt.getTime(),
  };
}

function one(guildId: string, id: string): SQL | undefined {
  return and(eq(applications.guildId, guildId), eq(applications.id, id));
}

function oneEffect(guildId: string, effectId: string): SQL | undefined {
  return and(eq(applicationEffects.guildId, guildId), eq(applicationEffects.id, effectId));
}

function statusIn(statuses: readonly string[]): SQL {
  return statuses.length === 0 ? sql`false` : inArray(applications.status, [...statuses]);
}

const submitted = isNotNull(applications.number);
const live = isNull(applications.deletedAt);

function queueBase(guildId: string, formIds: readonly string[], viewerId: string): SQL | undefined {
  return and(
    eq(applications.guildId, guildId),
    live,
    submitted,
    formIds.length === 0 ? sql`false` : inArray(applications.formId, [...formIds]),
    ne(applications.applicantId, viewerId),
  );
}

function viewCondition(view: QueueView, archivedInAll: boolean): SQL | undefined {
  const shown = isNull(applications.archivedAt);

  switch (view) {
    case 'awaiting':
      return and(statusIn(AWAITING), shown);
    case 'all':
      return archivedInAll ? undefined : shown;
    case 'archived':
      return isNotNull(applications.archivedAt);
    default:
      return and(eq(applications.status, view), shown);
  }
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

function searchCondition(q: string | undefined): SQL | undefined {
  const text = q?.trim() ?? '';
  if (text === '') return undefined;

  const reference = /^#?(\d{1,9})$/.exec(text);

  return or(
    sql`${applications.applicantName} ilike ${`%${escapeLike(text)}%`} escape '\\'`,
    eq(applications.applicantId, text),
    reference?.[1] === undefined ? undefined : eq(applications.number, Number(reference[1])),
  );
}

function assigneeCondition(assignee: string | undefined, viewerId: string): SQL | undefined {
  if (assignee === undefined) return undefined;
  if (assignee === 'none') return isNull(applications.assigneeId);
  return eq(applications.assigneeId, assignee === 'me' ? viewerId : assignee);
}

function meets(application: ApplicationRecord, expect: TransitionExpect): boolean {
  if (application.deletedAt !== null) return false;
  if (expect.statuses !== undefined && !expect.statuses.includes(application.status)) return false;
  if (expect.assigneeId !== undefined && application.assigneeId !== expect.assigneeId) return false;
  if (expect.revision !== undefined && application.revision !== expect.revision) return false;
  return true;
}

function expectation(expect: TransitionExpect): SQL[] {
  const conditions: SQL[] = [live];
  if (expect.statuses !== undefined) conditions.push(statusIn(expect.statuses));
  if (expect.assigneeId !== undefined) {
    conditions.push(sql`${applications.assigneeId} is not distinct from ${expect.assigneeId}`);
  }
  if (expect.revision !== undefined) conditions.push(eq(applications.revision, expect.revision));
  return conditions;
}

function patchColumns(patch: TransitionPatch): Partial<NewApplicationRow> {
  const set: Partial<NewApplicationRow> = {};

  if (patch.status !== undefined) set.status = patch.status;
  if (patch.assigneeId !== undefined) set.assigneeId = patch.assigneeId;
  if (patch.decidedBy !== undefined) set.decidedBy = patch.decidedBy;
  if (patch.decisionReason !== undefined) set.decisionReason = patch.decisionReason;
  if (patch.reopenedCount !== undefined) set.reopenedCount = patch.reopenedCount;
  if (patch.assignedAt !== undefined) set.assignedAt = dated(patch.assignedAt);
  if (patch.reviewStartedAt !== undefined) set.reviewStartedAt = dated(patch.reviewStartedAt);
  if (patch.infoRequestedAt !== undefined) set.infoRequestedAt = dated(patch.infoRequestedAt);
  if (patch.infoDueAt !== undefined) set.infoDueAt = dated(patch.infoDueAt);
  if (patch.waitlistedAt !== undefined) set.waitlistedAt = dated(patch.waitlistedAt);
  if (patch.decidedAt !== undefined) set.decidedAt = dated(patch.decidedAt);
  if (patch.withdrawnAt !== undefined) set.withdrawnAt = dated(patch.withdrawnAt);
  if (patch.archivedAt !== undefined) set.archivedAt = dated(patch.archivedAt);
  if (patch.reviewDueAt !== undefined) set.reviewDueAt = dated(patch.reviewDueAt);
  if (patch.remindedAt !== undefined) set.remindedAt = dated(patch.remindedAt);
  if (patch.contentPurgeAt !== undefined) set.contentPurgeAt = dated(patch.contentPurgeAt);

  return set;
}

function schedulesWork(patch: TransitionPatch): boolean {
  return (
    (patch.reviewDueAt !== undefined && patch.reviewDueAt !== null) ||
    (patch.infoDueAt !== undefined && patch.infoDueAt !== null)
  );
}

const SCRUBBED = {
  answers: null,
  draft: {},
  applicantName: null,
  decisionReason: null,
} satisfies Partial<NewApplicationRow>;

const CLOCK_MS = sql`floor(extract(epoch from clock_timestamp()) * 1000)::float8`;

async function dbNow(tx: Tx): Promise<number> {
  const [row] = await tx.execute<{ at: number }>(sql`select ${CLOCK_MS} as at`);
  if (row === undefined) throw new Error('the database didn’t report its clock');
  return Number(row.at);
}

async function lockIntake(tx: Tx, guildId: string): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`${INTAKE_LOCK}${guildId}`}, 0))`,
  );
}

function wakeRow(guildId: string, at: number) {
  const slot = wakeSlot(at);

  return {
    id: newId(),
    guildId,
    runAt: new Date(slot),
    kind: MODULE_JOB_KIND,
    payload: { kind: 'module', moduleId: MODULE_ID, jobId: SWEEP_JOB, guildId, data: {} },
    idempotencyKey: moduleScheduleKey(MODULE_ID, SWEEP_JOB, guildId, `${WAKE_KEY}:${slot}`),
  };
}

async function wake(tx: Tx, guildId: string, at: number): Promise<void> {
  await tx
    .insert(scheduledActions)
    .values(wakeRow(guildId, at))
    .onConflictDoNothing({ target: scheduledActions.idempotencyKey });
}

async function insertAudit(tx: Tx, guildId: string, audit: AuditInput, at: number): Promise<void> {
  await tx
    .insert(auditTrail)
    .values({
      id: audit.id,
      guildId,
      actorId: audit.actorId,
      source: audit.source,
      action: audit.action,
      before: audit.before ?? null,
      after: audit.after ?? null,
      ipHash: audit.ipHash ?? null,
      createdAt: new Date(at),
    })
    .onConflictDoNothing();
}

async function auditExists(tx: Tx, id: string): Promise<boolean> {
  const rows = await tx
    .select({ id: auditTrail.id })
    .from(auditTrail)
    .where(eq(auditTrail.id, id))
    .limit(1);
  return rows.length > 0;
}

async function eventExists(tx: Tx, id: string): Promise<boolean> {
  const rows = await tx
    .select({ id: applicationEvents.id })
    .from(applicationEvents)
    .where(eq(applicationEvents.id, id))
    .limit(1);
  return rows.length > 0;
}

interface EventInput {
  id: string;
  application: ApplicationRecord;
  kind: string;
  actorId: string;
  source: Source;
  fromStatus: ApplicationStatus | null;
  data: Record<string, unknown>;
  at: number;
}

async function insertEvent(tx: Tx, event: EventInput): Promise<void> {
  await tx
    .insert(applicationEvents)
    .values({
      id: event.id,
      guildId: event.application.guildId,
      applicationId: event.application.id,
      kind: event.kind,
      actorId: event.actorId,
      source: event.source,
      fromStatus: event.fromStatus,
      toStatus: event.application.status,
      revision: event.application.revision,
      data: event.data,
      createdAt: new Date(event.at),
    })
    .onConflictDoNothing();
}

const leasedNow = sql`${applicationEffects.status} in ('running', 'requested')`;

async function insertEffects(
  tx: Tx,
  application: ApplicationRecord,
  plans: readonly EffectPlan[],
  at: number,
): Promise<EffectRecord[]> {
  const seen = new Set<string>();
  const unique = plans.filter((plan) => {
    if (seen.has(plan.key)) return false;
    seen.add(plan.key);
    return true;
  });

  const values = (plan: EffectPlan) => ({
    id: newId(),
    guildId: application.guildId,
    applicationId: application.id,
    key: plan.key,
    kind: plan.kind,
    trigger: plan.trigger,
    revision: application.revision,
    params: plan.params,
    status: 'pending',
    attempts: 0,
    nextAttemptAt: new Date(at),
    createdAt: new Date(at),
    updatedAt: new Date(at),
  });

  const card = unique.find((plan) => plan.key === CARD_KEY);
  const xp = unique.find((plan) => plan.key === XP_KEY);
  const rest = unique.filter((plan) => plan.key !== CARD_KEY && plan.key !== XP_KEY);
  const rows: ApplicationEffectRow[] = [];

  if (card !== undefined) {
    // Leased: keep the lease so the holder's post lands before anyone renders again.
    const upserted = await tx
      .insert(applicationEffects)
      .values(values(card))
      .onConflictDoUpdate({
        target: [applicationEffects.applicationId, applicationEffects.key],
        set: {
          trigger: sql`excluded."trigger"`,
          revision: sql`greatest(${applicationEffects.revision}, excluded.revision)`,
          params: sql`excluded.params`,
          status: 'pending',
          attempts: 0,
          leaseUntil: sql`case when ${leasedNow} then ${applicationEffects.leaseUntil} else null end`,
          nextAttemptAt: sql`excluded.next_attempt_at`,
          errorCode: null,
          error: null,
          updatedAt: sql`excluded.updated_at`,
        },
      })
      .returning();
    rows.push(...upserted);
  }

  if (xp !== undefined) {
    const upserted = await tx
      .insert(applicationEffects)
      .values(values(xp))
      .onConflictDoUpdate({
        target: [applicationEffects.applicationId, applicationEffects.key],
        set: {
          trigger: sql`excluded."trigger"`,
          revision: sql`greatest(${applicationEffects.revision}, excluded.revision)`,
          params: sql`excluded.params`,
          status: 'pending',
          attempts: 0,
          leaseUntil: null,
          nextAttemptAt: sql`excluded.next_attempt_at`,
          result: sql`'{}'::jsonb`,
          errorCode: null,
          error: null,
          updatedAt: sql`excluded.updated_at`,
        },
        setWhere: inArray(applicationEffects.status, [...XP_REPLANNABLE]),
      })
      .returning();
    rows.push(...upserted);
  }

  if (rest.length > 0) {
    const inserted = await tx
      .insert(applicationEffects)
      .values(rest.map(values))
      .onConflictDoNothing({ target: [applicationEffects.applicationId, applicationEffects.key] })
      .returning();
    rows.push(...inserted);
  }

  return rows.map(toEffectRecord);
}

function cardRedraw(application: ApplicationRecord, cancelled: EffectRecord): EffectPlan[] {
  if (cancelled.key === CARD_KEY) return [];
  if (application.cardChannelId === null || application.cardMessageId === null) return [];
  return [
    {
      key: CARD_KEY,
      kind: 'card',
      trigger: 'card',
      params: { channelId: application.cardChannelId },
    },
  ];
}

async function supersede(tx: Tx, applicationId: string, at: number): Promise<void> {
  await tx
    .update(applicationEffects)
    .set({
      status: 'skipped',
      errorCode: CHANGED_CODE,
      error: CHANGED_ERROR,
      leaseUntil: null,
      updatedAt: new Date(at),
    })
    .where(
      and(
        eq(applicationEffects.applicationId, applicationId),
        inArray(applicationEffects.kind, [...SUPERSEDED_KINDS]),
        inArray(applicationEffects.trigger, [...SUPERSEDED_TRIGGERS]),
        inArray(applicationEffects.status, UNFINISHED),
        or(isNull(applicationEffects.leaseUntil), lte(applicationEffects.leaseUntil, new Date(at))),
      ),
    );
}

async function versionName(tx: Tx, versionId: string): Promise<string | null> {
  const [row] = await tx
    .select({ name: sql<string | null>`${applicationFormVersions.snapshot} ->> 'name'` })
    .from(applicationFormVersions)
    .where(eq(applicationFormVersions.id, versionId))
    .limit(1);
  return row?.name ?? null;
}

async function completePlans(
  tx: Tx,
  plans: readonly EffectPlan[],
  application: ApplicationRecord,
  actorId: string,
  at: number,
  formName?: string,
): Promise<EffectPlan[]> {
  const events = plans.filter((plan) => plan.kind === 'event');
  if (events.length === 0) return [...plans];

  const number = application.number;
  if (number === null) return plans.filter((plan) => plan.kind !== 'event');

  const planned = events
    .map((plan) => objectOf(plan.params.payload).formName)
    .find((name): name is string => typeof name === 'string' && name.length > 0);
  const name =
    formName ?? planned ?? (await versionName(tx, application.versionId)) ?? application.formId;

  return plans.map((plan) => {
    if (plan.kind !== 'event') return plan;

    const payload: ApplicationLifecycle = {
      guildId: application.guildId,
      applicationId: application.id,
      number,
      formId: application.formId,
      formName: name.slice(0, 100),
      versionId: application.versionId,
      applicantId: application.applicantId,
      actorId,
      revision: application.revision,
      status: application.status,
      occurredAt: at,
    };

    return { ...plan, params: { ...plan.params, payload } };
  });
}

async function lockedApplication(tx: Tx, guildId: string, id: string) {
  const [row] = await tx.select().from(applications).where(one(guildId, id)).limit(1).for('update');
  return row;
}

async function scrubChildren(tx: Tx, applicationIds: readonly string[]): Promise<void> {
  if (applicationIds.length === 0) return;
  await tx
    .update(applicationThread)
    .set({ body: null })
    .where(inArray(applicationThread.applicationId, [...applicationIds]));
  await tx
    .update(applicationNotes)
    .set({ body: null })
    .where(inArray(applicationNotes.applicationId, [...applicationIds]));
}

async function restart(
  tx: Tx,
  guildId: string,
  formId: string,
  keepVersionId: string,
  actor: Actor,
  at: number,
): Promise<number> {
  const rows = await tx
    .update(applications)
    .set({
      status: 'expired',
      draft: {},
      applicantName: null,
      contentPurgedAt: new Date(at),
      revision: sql`${applications.revision} + 1`,
      updatedAt: new Date(at),
    })
    .where(
      and(
        eq(applications.guildId, guildId),
        eq(applications.formId, formId),
        eq(applications.status, 'draft'),
        ne(applications.versionId, keepVersionId),
        live,
      ),
    )
    .returning();

  for (const row of rows) {
    const application = toApplicationRecord(row);
    await insertEvent(tx, {
      id: `${application.id}:expired:${application.revision}`,
      application,
      kind: 'expired',
      actorId: actor.id,
      source: actor.source,
      fromStatus: 'draft',
      data: { reason: 'form_changed' },
      at,
    });
  }

  return rows.length;
}

async function deleteLocked(
  tx: Tx,
  row: ApplicationRow,
  actor: Actor,
  at: number,
  cleanup: PlanEffects | undefined,
): Promise<ApplicationRecord> {
  const before = toApplicationRecord(row);

  if (before.status === 'draft') {
    await tx.delete(applications).where(one(before.guildId, before.id));
    return before;
  }

  const [updated] = await tx
    .update(applications)
    .set({
      ...SCRUBBED,
      contentPurgedAt: new Date(at),
      deletedAt: new Date(at),
      revision: sql`${applications.revision} + 1`,
      updatedAt: new Date(at),
    })
    .where(one(before.guildId, before.id))
    .returning();
  if (updated === undefined) return before;

  const application = toApplicationRecord(updated);
  await scrubChildren(tx, [application.id]);

  await tx
    .update(applicationEffects)
    .set({ status: 'cancelled', leaseUntil: null, updatedAt: new Date(at) })
    .where(
      and(
        eq(applicationEffects.applicationId, application.id),
        inArray(applicationEffects.status, UNFINISHED),
        ne(applicationEffects.kind, 'delete_card'),
        sql`not (${applicationEffects.kind} = 'remove_role' and ${applicationEffects.params} @> '{"fromGrants": true}'::jsonb)`,
      ),
    );

  const removal = deleteCardPlan(application);
  const plans = await completePlans(
    tx,
    [
      ...(cleanup === undefined ? [] : cleanup(application, application.revision)),
      ...(removal === null ? [] : [removal]),
    ],
    application,
    actor.id,
    at,
  );
  const effects = await insertEffects(tx, application, plans, at);

  await insertEvent(tx, {
    id: `${application.id}:deleted:${application.revision}`,
    application,
    kind: 'deleted',
    actorId: actor.id,
    source: actor.source,
    fromStatus: before.status,
    data: {},
    at,
  });

  if (effects.length > 0) await wake(tx, application.guildId, at);
  return application;
}

export class DrizzleApplicationStore implements ApplicationStore {
  readonly #handle: DbHandle;

  constructor(handle: DbHandle) {
    this.#handle = handle;
  }

  get #db() {
    return this.#handle.db;
  }

  async now(): Promise<number> {
    const [row] = await this.#db.execute<{ at: number }>(sql`select ${CLOCK_MS} as at`);
    if (row === undefined) throw new Error('the database didn’t report its clock');
    return Number(row.at);
  }

  async latestVersions(guildId: string): Promise<Map<string, FormVersionRecord>> {
    const rows = await this.#db
      .selectDistinctOn([applicationFormVersions.formId])
      .from(applicationFormVersions)
      .where(eq(applicationFormVersions.guildId, guildId))
      .orderBy(applicationFormVersions.formId, desc(applicationFormVersions.version));

    return new Map(rows.map((row) => [row.formId, toFormVersionRecord(row)] as const));
  }

  async version(guildId: string, versionId: string): Promise<FormVersionRecord | null> {
    const [row] = await this.#db
      .select()
      .from(applicationFormVersions)
      .where(
        and(
          eq(applicationFormVersions.guildId, guildId),
          eq(applicationFormVersions.id, versionId),
        ),
      )
      .limit(1);
    return row === undefined ? null : toFormVersionRecord(row);
  }

  async versions(guildId: string, formId: string): Promise<FormVersionRecord[]> {
    const rows = await this.#db
      .select()
      .from(applicationFormVersions)
      .where(
        and(
          eq(applicationFormVersions.guildId, guildId),
          eq(applicationFormVersions.formId, formId),
        ),
      )
      .orderBy(desc(applicationFormVersions.version));
    return rows.map(toFormVersionRecord);
  }

  async publish(input: PublishInput): Promise<PublishOutcome> {
    try {
      return await this.#db.transaction(async (tx) => {
        await lockIntake(tx, input.guildId);
        const at = input.now ?? (await dbNow(tx));
        const actor: Actor = { id: input.publishedBy, source: 'dashboard' };

        const [latestRow] = await tx
          .select()
          .from(applicationFormVersions)
          .where(
            and(
              eq(applicationFormVersions.guildId, input.guildId),
              eq(applicationFormVersions.formId, input.formId),
            ),
          )
          .orderBy(desc(applicationFormVersions.version))
          .limit(1);
        const latest = latestRow === undefined ? null : toFormVersionRecord(latestRow);

        if (latest !== null && sameSnapshot(latest.snapshot, input.snapshot)) {
          const expired =
            input.draftPolicy === 'restart'
              ? await restart(tx, input.guildId, input.formId, latest.id, actor, at)
              : 0;
          if (expired > 0) await insertAudit(tx, input.guildId, input.audit, at);
          return { status: 'unchanged', version: latest, draftsExpired: expired };
        }

        const [inserted] = await tx
          .insert(applicationFormVersions)
          .values({
            id: newId(),
            guildId: input.guildId,
            formId: input.formId,
            version: (latest?.version ?? 0) + 1,
            snapshot: input.snapshot,
            draftPolicy: input.draftPolicy,
            publishedBy: input.publishedBy,
            publishedAt: new Date(at),
          })
          .returning();
        if (inserted === undefined) throw new Error('the published form version was not saved');

        const version = toFormVersionRecord(inserted);
        const expired =
          input.draftPolicy === 'restart'
            ? await restart(tx, input.guildId, input.formId, version.id, actor, at)
            : 0;

        await insertAudit(tx, input.guildId, input.audit, at);
        return { status: 'published', version, draftsExpired: expired };
      });
    } catch (error) {
      throw unknownServer(error, input.guildId);
    }
  }

  async counts(guildId: string): Promise<Map<string, FormCounts>> {
    const count = (condition: SQL) =>
      sql<number>`count(*) filter (where ${condition})::int`.mapWith(Number);

    const rows = await this.#db
      .select({
        formId: applications.formId,
        awaiting: count(sql`${statusIn(AWAITING)} and ${applications.archivedAt} is null`),
        needsInfo: count(sql`${applications.status} = 'needs_info'`),
        drafts: count(sql`${applications.status} = 'draft'`),
        total: count(sql`${applications.number} is not null`),
        submittedForCap: count(
          sql`${applications.submittedAt} is not null and ${applications.status} <> 'withdrawn'`,
        ),
      })
      .from(applications)
      .where(and(eq(applications.guildId, guildId), live))
      .groupBy(applications.formId);

    return new Map(
      rows.map(({ formId, ...counts }) => [formId, counts satisfies FormCounts] as const),
    );
  }

  async draftCount(guildId: string, formId: string, olderThanVersionId?: string): Promise<number> {
    const [row] = await this.#db
      .select({ n: sql<number>`count(*)::int`.mapWith(Number) })
      .from(applications)
      .where(
        and(
          eq(applications.guildId, guildId),
          eq(applications.formId, formId),
          eq(applications.status, 'draft'),
          live,
          olderThanVersionId === undefined
            ? undefined
            : ne(applications.versionId, olderThanVersionId),
        ),
      );
    return row?.n ?? 0;
  }

  async get(guildId: string, id: string): Promise<ApplicationRecord | null> {
    const [row] = await this.#db.select().from(applications).where(one(guildId, id)).limit(1);
    return row === undefined ? null : toApplicationRecord(row);
  }

  async byNumber(guildId: string, number: number): Promise<ApplicationRecord | null> {
    const [row] = await this.#db
      .select()
      .from(applications)
      .where(and(eq(applications.guildId, guildId), eq(applications.number, number)))
      .limit(1);
    return row === undefined ? null : toApplicationRecord(row);
  }

  async draftFor(
    guildId: string,
    formId: string,
    applicantId: string,
  ): Promise<ApplicationRecord | null> {
    const [row] = await this.#db
      .select()
      .from(applications)
      .where(
        and(
          eq(applications.guildId, guildId),
          eq(applications.formId, formId),
          eq(applications.applicantId, applicantId),
          eq(applications.status, 'draft'),
          live,
        ),
      )
      .limit(1);
    return row === undefined ? null : toApplicationRecord(row);
  }

  async mine(guildId: string | null, applicantId: string): Promise<ApplicationRecord[]> {
    const rows = await this.#db
      .select()
      .from(applications)
      .where(
        and(
          eq(applications.applicantId, applicantId),
          guildId === null ? undefined : eq(applications.guildId, guildId),
          live,
        ),
      )
      .orderBy(desc(applications.createdAt), desc(applications.id))
      .limit(MINE_LIMIT);
    return rows.map(toApplicationRecord);
  }

  async startDraft(
    input: StartDraftInput,
  ): Promise<{ status: 'started' | 'existing'; application: ApplicationRecord }> {
    try {
      return await this.#db.transaction(async (tx) => {
        await lockIntake(tx, input.guildId);
        const at = input.now ?? (await dbNow(tx));

        const draft = async () => {
          const [row] = await tx
            .select()
            .from(applications)
            .where(
              and(
                eq(applications.guildId, input.guildId),
                eq(applications.formId, input.formId),
                eq(applications.applicantId, input.applicantId),
                eq(applications.status, 'draft'),
              ),
            )
            .limit(1);
          return row;
        };

        const existing = await draft();
        if (existing !== undefined) {
          return { status: 'existing' as const, application: toApplicationRecord(existing) };
        }

        const [latest] = await tx
          .select({ id: applicationFormVersions.id })
          .from(applicationFormVersions)
          .where(
            and(
              eq(applicationFormVersions.guildId, input.guildId),
              eq(applicationFormVersions.formId, input.formId),
            ),
          )
          .orderBy(desc(applicationFormVersions.version))
          .limit(1);
        if (latest === undefined) {
          throw new Error(
            `form ${input.formId} has no published version in server ${input.guildId}, so no draft can start`,
          );
        }

        const [row] = await tx
          .insert(applications)
          .values({
            id: newId(),
            guildId: input.guildId,
            formId: input.formId,
            versionId: latest.id,
            applicantId: input.applicantId,
            applicantName: input.applicantName,
            status: 'draft',
            source: input.source,
            expiresAt: new Date(input.expiresAt),
            createdAt: new Date(at),
            updatedAt: new Date(at),
          })
          .onConflictDoNothing()
          .returning();
        if (row !== undefined) {
          return { status: 'started' as const, application: toApplicationRecord(row) };
        }

        const raced = await draft();
        if (raced === undefined) throw new Error('the new draft was neither saved nor found');
        return { status: 'existing' as const, application: toApplicationRecord(raced) };
      });
    } catch (error) {
      throw unknownServer(error, input.guildId);
    }
  }

  async saveDraft(input: SaveDraftInput): Promise<SaveDraftResult> {
    return this.#db.transaction(async (tx) => {
      const row = await lockedApplication(tx, input.guildId, input.applicationId);
      if (
        row === undefined ||
        row.applicantId !== input.applicantId ||
        row.status !== 'draft' ||
        row.deletedAt !== null
      ) {
        return { status: 'gone' as const };
      }

      const current = toApplicationRecord(row);
      if (input.expectedRevision !== null && current.revision !== input.expectedRevision) {
        return { status: 'conflict' as const, application: current };
      }

      const at = input.now ?? (await dbNow(tx));
      const draft =
        input.mode === 'merge' ? { ...current.draft, ...input.answers } : { ...input.answers };

      const [updated] = await tx
        .update(applications)
        .set({
          draft,
          step: input.step ?? current.step,
          expiresAt: new Date(input.expiresAt),
          revision: sql`${applications.revision} + 1`,
          updatedAt: new Date(at),
        })
        .where(
          and(
            one(input.guildId, input.applicationId),
            eq(applications.status, 'draft'),
            eq(applications.revision, current.revision),
          ),
        )
        .returning();

      return updated === undefined
        ? { status: 'conflict' as const, application: current }
        : { status: 'saved' as const, application: toApplicationRecord(updated) };
    });
  }

  async discardDraft(
    guildId: string,
    applicationId: string,
    applicantId: string,
  ): Promise<boolean> {
    const rows = await this.#db
      .delete(applications)
      .where(
        and(
          one(guildId, applicationId),
          eq(applications.applicantId, applicantId),
          eq(applications.status, 'draft'),
        ),
      )
      .returning({ id: applications.id });
    return rows.length > 0;
  }

  async submit(input: SubmitInput): Promise<SubmitResult> {
    const refuse = (
      code: SubmitRefusalCode,
      message: string,
      extra: { retryAt?: number; existingId?: string } = {},
    ): SubmitResult => ({ status: 'refused', code, message, ...extra });

    return this.#db.transaction(async (tx) => {
      await lockIntake(tx, input.guildId);

      const row = await lockedApplication(tx, input.guildId, input.applicationId);
      if (row === undefined || row.applicantId !== input.applicantId || row.deletedAt !== null) {
        return refuse('not_draft', MESSAGES.missing);
      }
      if (row.status !== 'draft') {
        return row.number === null
          ? refuse('not_draft', MESSAGES.restarted)
          : refuse('not_draft', MESSAGES.not_draft, { existingId: row.id });
      }
      if (input.expectedRevision !== null && row.revision !== input.expectedRevision) {
        return refuse('conflict', MESSAGES.conflict);
      }

      const at = input.now ?? (await dbNow(tx));
      const { limits } = input;

      const [history] = await tx
        .select({
          active: sql<number>`count(*) filter (where ${statusIn(ACTIVE_STATUSES)})::int`.mapWith(
            Number,
          ),
          activeId: sql<
            string | null
          >`(array_agg(${applications.id} order by ${applications.submittedAt} desc) filter (where ${statusIn(ACTIVE_STATUSES)}))[1]`,
          lastAt: sql<number | null>`(extract(epoch from max(greatest(
            ${applications.decidedAt}, ${applications.withdrawnAt}, ${applications.submittedAt}
          ))) * 1000)::float8`,
        })
        .from(applications)
        .where(
          and(
            eq(applications.guildId, input.guildId),
            eq(applications.formId, row.formId),
            eq(applications.applicantId, input.applicantId),
            live,
            submitted,
          ),
        );

      if ((history?.active ?? 0) >= limits.maxActive) {
        return refuse('active', MESSAGES.active, {
          ...(history?.activeId ? { existingId: history.activeId } : {}),
        });
      }

      const lastAt = history?.lastAt ?? null;
      if (limits.cooldownDays > 0 && lastAt !== null) {
        const retryAt = Math.round(lastAt) + limits.cooldownDays * DAY_MS;
        if (retryAt > at) return refuse('cooldown', MESSAGES.cooldown, { retryAt });
      }

      if (limits.cap !== undefined) {
        const [taken] = await tx
          .select({ n: sql<number>`count(*)::int`.mapWith(Number) })
          .from(applications)
          .where(
            and(
              eq(applications.guildId, input.guildId),
              eq(applications.formId, row.formId),
              isNotNull(applications.submittedAt),
              ne(applications.status, 'withdrawn'),
              live,
            ),
          );
        if ((taken?.n ?? 0) >= limits.cap) return refuse('cap', MESSAGES.cap);
      }

      const [numbered] = await tx
        .select({
          next: sql<number>`(coalesce(max(${applications.number}), 0) + 1)::int`.mapWith(Number),
        })
        .from(applications)
        .where(eq(applications.guildId, input.guildId));

      const [updated] = await tx
        .update(applications)
        .set({
          status: 'submitted',
          number: numbered?.next ?? 1,
          revision: sql`${applications.revision} + 1`,
          answers: input.answers,
          draft: {},
          step: 0,
          source: input.source,
          applicantName: input.applicantName ?? row.applicantName,
          submittedAt: new Date(at),
          reviewDueAt: dated(input.reviewDueAt),
          expiresAt: null,
          updatedAt: new Date(at),
        })
        .where(
          and(
            one(input.guildId, input.applicationId),
            eq(applications.status, 'draft'),
            eq(applications.revision, row.revision),
          ),
        )
        .returning();
      if (updated === undefined) return refuse('conflict', MESSAGES.conflict);

      const application = toApplicationRecord(updated);
      const plans = await completePlans(
        tx,
        input.plan(application, application.revision),
        application,
        input.lifecycle.actorId,
        at,
        input.lifecycle.formName,
      );
      const effects = await insertEffects(tx, application, plans, at);

      await insertEvent(tx, {
        id: `${application.id}:submitted:${application.revision}`,
        application,
        kind: 'submitted',
        actorId: input.applicantId,
        source: input.source,
        fromStatus: 'draft',
        data: { answers: input.answers.length },
        at,
      });

      if (effects.length > 0 || application.reviewDueAt !== null) {
        await wake(tx, input.guildId, at);
      }

      return { status: 'submitted' as const, application, effects };
    });
  }

  async transition(input: TransitionInput): Promise<TransitionResult> {
    return this.#db.transaction(async (tx) => {
      const row = await lockedApplication(tx, input.guildId, input.applicationId);
      if (row === undefined) return { status: 'stale' as const, application: null };

      const before = toApplicationRecord(row);
      const replayed =
        (input.audit !== undefined && (await auditExists(tx, input.audit.id))) ||
        (input.event.id !== undefined && (await eventExists(tx, input.event.id)));
      if (replayed) return { status: 'done' as const, application: before, effects: [] };

      if (!meets(before, input.expect)) return { status: 'stale' as const, application: before };

      const at = input.now ?? (await dbNow(tx));
      const bump = input.bumpRevision !== false;

      const [updated] = await tx
        .update(applications)
        .set({
          ...patchColumns(input.patch),
          ...(bump ? { revision: sql`${applications.revision} + 1` } : {}),
          updatedAt: new Date(at),
        })
        .where(and(one(input.guildId, input.applicationId), ...expectation(input.expect)))
        .returning();
      if (updated === undefined) return { status: 'stale' as const, application: before };

      const application = toApplicationRecord(updated);
      const suffix = bump ? '' : `:${newId()}`;
      const eventId =
        input.event.id ?? `${application.id}:${input.event.kind}:${application.revision}${suffix}`;

      await insertEvent(tx, {
        id: eventId,
        application,
        kind: input.event.kind,
        actorId: input.actor.id,
        source: input.actor.source,
        fromStatus: before.status,
        data: {
          ...(input.event.lifecycle === undefined ? {} : { lifecycle: input.event.lifecycle }),
          ...input.event.data,
        },
        at,
      });

      if (input.thread !== undefined) {
        await tx.insert(applicationThread).values({
          id: `${eventId}:thread`,
          guildId: application.guildId,
          applicationId: application.id,
          kind: input.thread.kind,
          authorId: input.actor.id,
          body: input.thread.body,
          revision: application.revision,
          createdAt: new Date(at),
        });
      }

      if (input.note !== undefined) {
        await tx.insert(applicationNotes).values({
          id: `${eventId}:note`,
          guildId: application.guildId,
          applicationId: application.id,
          authorId: input.actor.id,
          body: input.note.body,
          createdAt: new Date(at),
        });
      }

      if (input.clearVotes === true) {
        await tx
          .delete(applicationVotes)
          .where(
            and(
              eq(applicationVotes.guildId, application.guildId),
              eq(applicationVotes.applicationId, application.id),
            ),
          );
      }

      if (input.vote !== undefined) {
        await tx
          .insert(applicationVotes)
          .values({
            guildId: application.guildId,
            applicationId: application.id,
            reviewerId: input.actor.id,
            vote: input.vote.vote,
            score: input.vote.score,
            createdAt: new Date(at),
            updatedAt: new Date(at),
          })
          .onConflictDoUpdate({
            target: [applicationVotes.applicationId, applicationVotes.reviewerId],
            set: { vote: input.vote.vote, score: input.vote.score, updatedAt: new Date(at) },
          });
      }

      if (input.supersede === true) await supersede(tx, application.id, at);

      const plans =
        input.plan === undefined
          ? []
          : await completePlans(
              tx,
              input.plan(application, application.revision),
              application,
              input.actor.id,
              at,
            );
      const effects = await insertEffects(tx, application, plans, at);

      if (input.audit !== undefined) await insertAudit(tx, input.guildId, input.audit, at);
      if (effects.length > 0 || schedulesWork(input.patch)) await wake(tx, input.guildId, at);

      return { status: 'done' as const, application, effects };
    });
  }

  async votes(guildId: string, applicationId: string): Promise<VoteRecord[]> {
    const rows = await this.#db
      .select()
      .from(applicationVotes)
      .where(
        and(
          eq(applicationVotes.guildId, guildId),
          eq(applicationVotes.applicationId, applicationId),
        ),
      )
      .orderBy(asc(applicationVotes.createdAt), asc(applicationVotes.reviewerId));
    return rows.map(toVote);
  }

  async detail(guildId: string, applicationId: string): Promise<ApplicationDetailRecord | null> {
    return this.#db.transaction(
      async (tx) => {
        const [row] = await tx
          .select()
          .from(applications)
          .where(one(guildId, applicationId))
          .limit(1);
        if (row === undefined) return null;

        const [thread, notes, votes, events, effects] = await Promise.all([
          tx
            .select()
            .from(applicationThread)
            .where(
              and(
                eq(applicationThread.guildId, guildId),
                eq(applicationThread.applicationId, applicationId),
              ),
            )
            .orderBy(asc(applicationThread.createdAt), asc(applicationThread.id)),
          tx
            .select()
            .from(applicationNotes)
            .where(
              and(
                eq(applicationNotes.guildId, guildId),
                eq(applicationNotes.applicationId, applicationId),
              ),
            )
            .orderBy(asc(applicationNotes.createdAt), asc(applicationNotes.id)),
          tx
            .select()
            .from(applicationVotes)
            .where(
              and(
                eq(applicationVotes.guildId, guildId),
                eq(applicationVotes.applicationId, applicationId),
              ),
            )
            .orderBy(asc(applicationVotes.createdAt), asc(applicationVotes.reviewerId)),
          tx
            .select()
            .from(applicationEvents)
            .where(
              and(
                eq(applicationEvents.guildId, guildId),
                eq(applicationEvents.applicationId, applicationId),
              ),
            )
            .orderBy(asc(applicationEvents.createdAt), asc(applicationEvents.revision)),
          tx
            .select()
            .from(applicationEffects)
            .where(
              and(
                eq(applicationEffects.guildId, guildId),
                eq(applicationEffects.applicationId, applicationId),
              ),
            )
            .orderBy(asc(applicationEffects.createdAt), asc(applicationEffects.key)),
        ]);

        return {
          application: toApplicationRecord(row),
          thread: thread.map(toThread),
          notes: notes.map(toNote),
          votes: votes.map(toVote),
          events: events.map(toEvent),
          effects: effects.map(toEffectRecord),
        };
      },
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    );
  }

  async list(guildId: string, query: ListQuery): Promise<ListResult> {
    const empty: ListResult = { items: [], total: 0, problems: new Map(), votes: new Map() };
    if (query.formId !== undefined && !query.formIds.includes(query.formId)) return empty;

    const where = and(
      queueBase(guildId, query.formIds, query.viewerId),
      query.formId === undefined ? undefined : eq(applications.formId, query.formId),
      viewCondition(query.view, false),
      assigneeCondition(query.assignee, query.viewerId),
      searchCondition(query.q),
    );

    const direction = query.dir === 'asc' ? asc : desc;
    const order =
      query.sort === 'number'
        ? [direction(applications.number)]
        : query.sort === 'updated'
          ? [direction(applications.updatedAt), direction(applications.id)]
          : [direction(applications.submittedAt), direction(applications.id)];

    const [rows, counted] = await Promise.all([
      this.#db
        .select()
        .from(applications)
        .where(where)
        .orderBy(...order)
        .limit(query.pageSize)
        .offset((query.page - 1) * query.pageSize),
      this.#db
        .select({ n: sql<number>`count(*)::int`.mapWith(Number) })
        .from(applications)
        .where(where),
    ]);

    const items = rows.map(toApplicationRecord);
    const ids = items.map((item) => item.id);
    if (ids.length === 0) return { ...empty, total: counted[0]?.n ?? 0 };

    const [failed, tallies] = await Promise.all([
      this.#db
        .select()
        .from(applicationEffects)
        .where(
          and(
            eq(applicationEffects.guildId, guildId),
            inArray(applicationEffects.applicationId, ids),
            eq(applicationEffects.status, 'failed'),
          ),
        )
        .orderBy(asc(applicationEffects.createdAt), asc(applicationEffects.key)),
      this.#db
        .select({
          applicationId: applicationVotes.applicationId,
          accept:
            sql<number>`count(*) filter (where ${applicationVotes.vote} = 'accept')::int`.mapWith(
              Number,
            ),
          reject:
            sql<number>`count(*) filter (where ${applicationVotes.vote} = 'reject')::int`.mapWith(
              Number,
            ),
        })
        .from(applicationVotes)
        .where(
          and(eq(applicationVotes.guildId, guildId), inArray(applicationVotes.applicationId, ids)),
        )
        .groupBy(applicationVotes.applicationId),
    ]);

    const problems = new Map<string, EffectRecord[]>();
    for (const effect of failed.map(toEffectRecord)) {
      problems.set(effect.applicationId, [...(problems.get(effect.applicationId) ?? []), effect]);
    }

    const votes = new Map<string, VoteTally>(
      tallies.map(
        (row) => [row.applicationId, { accept: row.accept, reject: row.reject }] as const,
      ),
    );

    return { items, total: counted[0]?.n ?? 0, problems, votes };
  }

  async summary(
    guildId: string,
    formIds: readonly string[],
    viewerId: string,
  ): Promise<QueueSummary> {
    const awaiting = sql`${statusIn(AWAITING)} and ${applications.archivedAt} is null`;
    const count = (condition: SQL) =>
      sql<number>`count(*) filter (where ${condition})::int`.mapWith(Number);

    const [row] = await this.#db
      .select({
        awaiting: count(awaiting),
        unassigned: count(sql`${awaiting} and ${applications.assigneeId} is null`),
        needsInfo: count(
          sql`${applications.status} = 'needs_info' and ${applications.archivedAt} is null`,
        ),
        waitlisted: count(
          sql`${applications.status} = 'waitlisted' and ${applications.archivedAt} is null`,
        ),
        problems: count(sql`exists (
          select 1 from ${applicationEffects}
           where ${applicationEffects.applicationId} = ${applications.id}
             and ${applicationEffects.status} = 'failed'
        )`),
        oldest: sql<number | null>`(extract(epoch from min(${applications.submittedAt})
          filter (where ${awaiting})) * 1000)::float8`,
      })
      .from(applications)
      .where(queueBase(guildId, formIds, viewerId));

    return {
      awaiting: row?.awaiting ?? 0,
      unassigned: row?.unassigned ?? 0,
      needsInfo: row?.needsInfo ?? 0,
      waitlisted: row?.waitlisted ?? 0,
      problems: row?.problems ?? 0,
      oldestAwaitingAt:
        row?.oldest === null || row?.oldest === undefined ? null : Math.round(row.oldest),
    };
  }

  async dueWork(guildId: string, now: number, limit: number): Promise<DueWork> {
    const at = new Date(now);
    const take = Math.max(0, Math.floor(limit));

    const effectDue = and(
      eq(applicationEffects.guildId, guildId),
      or(
        and(
          eq(applicationEffects.status, 'pending'),
          lte(applicationEffects.nextAttemptAt, at),
          or(isNull(applicationEffects.leaseUntil), lte(applicationEffects.leaseUntil, at)),
        ),
        and(
          inArray(applicationEffects.status, LEASED),
          or(isNull(applicationEffects.leaseUntil), lte(applicationEffects.leaseUntil, at)),
        ),
      ),
    );

    const reviewDue = and(
      eq(applications.guildId, guildId),
      live,
      isNull(applications.remindedAt),
      statusIn(REVIEW_DUE),
      isNotNull(applications.reviewDueAt),
    );
    const infoDue = and(
      eq(applications.guildId, guildId),
      live,
      eq(applications.status, 'needs_info'),
      isNotNull(applications.infoDueAt),
    );

    const [effects, reminders, infoExpiries, next] = await Promise.all([
      this.#db
        .select()
        .from(applicationEffects)
        .where(effectDue)
        .orderBy(asc(applicationEffects.nextAttemptAt), asc(applicationEffects.createdAt))
        .limit(take),
      this.#db
        .select()
        .from(applications)
        .where(and(reviewDue, lte(applications.reviewDueAt, at)))
        .orderBy(asc(applications.reviewDueAt))
        .limit(take),
      this.#db
        .select()
        .from(applications)
        .where(and(infoDue, lte(applications.infoDueAt, at)))
        .orderBy(asc(applications.infoDueAt))
        .limit(take),
      this.#db.execute<{ due: number | null }>(sql`
        select (extract(epoch from least(
          (select min(greatest(next_attempt_at, coalesce(lease_until, next_attempt_at)))
             from application_effects where guild_id = ${guildId} and status = 'pending'),
          (select min(coalesce(lease_until, updated_at))
             from application_effects
            where guild_id = ${guildId} and status in ('running', 'requested')),
          (select min(review_due_at) from applications
            where guild_id = ${guildId} and deleted_at is null and reminded_at is null
              and status in ('submitted', 'in_review')),
          (select min(info_due_at) from applications
            where guild_id = ${guildId} and deleted_at is null and status = 'needs_info')
        )) * 1000)::float8 as due`),
    ]);

    const due = next[0]?.due;

    return {
      effects: effects.map(toEffectRecord),
      reminders: reminders.map(toApplicationRecord),
      infoExpiries: infoExpiries.map(toApplicationRecord),
      nextDueAt: due === null || due === undefined ? null : Math.round(Number(due)),
    };
  }

  async claimEffect(
    guildId: string,
    effectId: string,
    now: number,
    leaseMs: number,
  ): Promise<EffectClaim | null> {
    const at = new Date(now);
    const leaseFree = or(
      isNull(applicationEffects.leaseUntil),
      lte(applicationEffects.leaseUntil, at),
    );

    const [row] = await this.#db
      .update(applicationEffects)
      .set({
        status: 'running',
        attempts: sql`${applicationEffects.attempts} + 1`,
        claimSeq: sql`${applicationEffects.claimSeq} + 1`,
        leaseUntil: new Date(now + leaseMs),
        updatedAt: at,
      })
      .where(
        and(
          oneEffect(guildId, effectId),
          or(
            and(
              eq(applicationEffects.status, 'pending'),
              lte(applicationEffects.nextAttemptAt, at),
              leaseFree,
            ),
            and(inArray(applicationEffects.status, LEASED), leaseFree),
          ),
        ),
      )
      .returning();

    if (row === undefined) return null;
    const effect = toEffectRecord(row);
    return { effect, token: effect.claimSeq };
  }

  async finishEffect(
    guildId: string,
    effectId: string,
    token: number,
    outcome: EffectOutcome,
  ): Promise<boolean> {
    const next = outcome.nextAttemptAt;
    const lease =
      outcome.status !== 'requested'
        ? null
        : next !== undefined
          ? sql`${iso(next)}::timestamptz`
          : sql`clock_timestamp() + ${REQUEST_ANSWER_TIMEOUT_MS}::int * interval '1 millisecond'`;

    const rows = await this.#db
      .update(applicationEffects)
      .set({
        status: outcome.status,
        ...(outcome.result === undefined ? {} : { result: outcome.result }),
        errorCode: outcome.errorCode ?? null,
        error: outcome.error ?? null,
        leaseUntil: lease,
        ...(outcome.status === 'pending'
          ? {
              nextAttemptAt:
                next === undefined ? sql`clock_timestamp()` : sql`${iso(next)}::timestamptz`,
            }
          : {}),
        updatedAt: sql`clock_timestamp()`,
      })
      .where(
        and(
          oneEffect(guildId, effectId),
          eq(applicationEffects.claimSeq, token),
          inArray(applicationEffects.status, LEASED),
        ),
      )
      .returning({ id: applicationEffects.id });

    return rows.length > 0;
  }

  async answerRequested(
    guildId: string,
    key: RequestedEffect,
    outcome: RequestAnswer,
  ): Promise<EffectRecord | null> {
    return this.#db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(applicationEffects)
        .where(
          and(
            eq(applicationEffects.guildId, guildId),
            eq(applicationEffects.applicationId, key.applicationId),
            'effectKey' in key
              ? eq(applicationEffects.key, key.effectKey)
              : eq(applicationEffects.id, key.effectId),
          ),
        )
        .limit(1)
        .for('update');
      if (row === undefined) return null;

      const current = toEffectRecord(row);
      const settle =
        outcome.status === 'succeeded'
          ? current.status !== 'succeeded'
          : current.status === 'requested' ||
            current.status === 'running' ||
            current.status === 'pending';
      if (!settle) return current;

      const [updated] = await tx
        .update(applicationEffects)
        .set({
          status: outcome.status,
          ...(outcome.result === undefined ? {} : { result: outcome.result }),
          errorCode: outcome.errorCode ?? null,
          error: outcome.error ?? null,
          leaseUntil: null,
          updatedAt: sql`clock_timestamp()`,
        })
        .where(eq(applicationEffects.id, current.id))
        .returning();

      return updated === undefined ? current : toEffectRecord(updated);
    });
  }

  async #settleEffect(
    guildId: string,
    applicationId: string,
    effectId: string,
    actor: Actor,
    audit: AuditInput | undefined,
    change: 'retried' | 'cancelled',
  ): Promise<EffectRecord | null> {
    return this.#db.transaction(async (tx) => {
      const row = await lockedApplication(tx, guildId, applicationId);
      if (row === undefined || row.deletedAt !== null) return null;
      const application = toApplicationRecord(row);

      const [effectRow] = await tx
        .select()
        .from(applicationEffects)
        .where(
          and(oneEffect(guildId, effectId), eq(applicationEffects.applicationId, applicationId)),
        )
        .limit(1)
        .for('update');
      if (effectRow === undefined) return null;

      const effect = toEffectRecord(effectRow);
      const allowed =
        change === 'retried' ? effect.status === 'failed' : UNFINISHED.includes(effect.status);
      if (!allowed) return null;

      const at = await dbNow(tx);
      const [updated] = await tx
        .update(applicationEffects)
        .set(
          change === 'retried'
            ? {
                status: 'pending',
                attempts: 0,
                leaseUntil: null,
                nextAttemptAt: new Date(at),
                errorCode: null,
                error: null,
                updatedAt: new Date(at),
              }
            : { status: 'cancelled', leaseUntil: null, updatedAt: new Date(at) },
        )
        .where(eq(applicationEffects.id, effect.id))
        .returning();
      if (updated === undefined) return null;

      await insertEvent(tx, {
        id: `${application.id}:effect_${change}:${effect.id}:${effect.updatedAt}`,
        application,
        kind: `effect_${change}`,
        actorId: actor.id,
        source: actor.source,
        fromStatus: application.status,
        data: { effectId: effect.id, kind: effect.kind, key: effect.key },
        at,
      });

      const redraw = change === 'cancelled' ? cardRedraw(application, effect) : [];
      const redrawn = await insertEffects(tx, application, redraw, at);

      if (audit !== undefined) await insertAudit(tx, guildId, audit, at);
      if (change === 'retried' || redrawn.length > 0) await wake(tx, guildId, at);

      return toEffectRecord(updated);
    });
  }

  async retryEffect(
    guildId: string,
    applicationId: string,
    effectId: string,
    actor: Actor,
    audit?: AuditInput,
  ): Promise<EffectRecord | null> {
    return this.#settleEffect(guildId, applicationId, effectId, actor, audit, 'retried');
  }

  async cancelEffect(
    guildId: string,
    applicationId: string,
    effectId: string,
    actor: Actor,
    audit?: AuditInput,
  ): Promise<EffectRecord | null> {
    return this.#settleEffect(guildId, applicationId, effectId, actor, audit, 'cancelled');
  }

  async armWake(guildId: string, at: number): Promise<void> {
    await this.#db
      .insert(scheduledActions)
      .values(wakeRow(guildId, at))
      .onConflictDoNothing({ target: scheduledActions.idempotencyKey });
  }

  async rememberCard(
    guildId: string,
    applicationId: string,
    channelId: string,
    messageId: string,
    revision: number,
  ): Promise<boolean> {
    const rows = await this.#db
      .update(applications)
      .set({
        cardChannelId: channelId,
        cardMessageId: messageId,
        cardRevision: sql`greatest(${applications.cardRevision}, ${revision}::int)`,
      })
      .where(and(one(guildId, applicationId), live))
      .returning({ id: applications.id });
    return rows.length > 0;
  }

  async queueCardRemoval(
    guildId: string,
    applicationId: string,
    channelId: string,
    messageId: string,
  ): Promise<void> {
    await this.#db.transaction(async (tx) => {
      const row = await lockedApplication(tx, guildId, applicationId);
      if (row === undefined) return;

      const at = await dbNow(tx);
      const removal: EffectPlan = {
        key: `${DELETE_CARD_KEY}:${messageId}`,
        kind: 'delete_card',
        trigger: 'card',
        params: { channelId, messageId },
      };
      const effects = await insertEffects(tx, toApplicationRecord(row), [removal], at);
      if (effects.length > 0) await wake(tx, guildId, at);
    });
  }

  async rememberDm(guildId: string, applicationId: string, channelId: string): Promise<void> {
    await this.#db
      .update(applications)
      .set({ dmChannelId: channelId })
      .where(one(guildId, applicationId));
  }

  async recordRoleGrant(
    guildId: string,
    applicationId: string,
    userId: string,
    roleId: string,
  ): Promise<void> {
    await this.#db.transaction(async (tx) => {
      const [owner] = await tx
        .select({ id: applications.id })
        .from(applications)
        .where(one(guildId, applicationId))
        .limit(1);
      if (owner === undefined) return;

      const at = await dbNow(tx);
      await tx
        .insert(applicationRoleGrants)
        .values({ guildId, applicationId, userId, roleId, grantedAt: new Date(at) })
        .onConflictDoUpdate({
          target: [applicationRoleGrants.applicationId, applicationRoleGrants.roleId],
          set: { userId, grantedAt: new Date(at), removedAt: null },
        });
    });
  }

  async grantedRoles(guildId: string, applicationId: string): Promise<string[]> {
    const rows = await this.#db
      .select({ roleId: applicationRoleGrants.roleId })
      .from(applicationRoleGrants)
      .where(
        and(
          eq(applicationRoleGrants.guildId, guildId),
          eq(applicationRoleGrants.applicationId, applicationId),
          isNull(applicationRoleGrants.removedAt),
        ),
      )
      .orderBy(asc(applicationRoleGrants.grantedAt), asc(applicationRoleGrants.roleId));
    return rows.map((row) => row.roleId);
  }

  async markRoleRemoved(guildId: string, applicationId: string, roleId: string): Promise<void> {
    await this.#db
      .update(applicationRoleGrants)
      .set({ removedAt: sql`clock_timestamp()` })
      .where(
        and(
          eq(applicationRoleGrants.guildId, guildId),
          eq(applicationRoleGrants.applicationId, applicationId),
          eq(applicationRoleGrants.roleId, roleId),
          isNull(applicationRoleGrants.removedAt),
        ),
      );
  }

  async rememberInterview(
    guildId: string,
    applicationId: string,
    ticketId: string,
    channelId: string | null,
  ): Promise<void> {
    await this.#db
      .update(applications)
      .set({ interviewTicketId: ticketId, interviewChannelId: channelId })
      .where(one(guildId, applicationId));
  }

  async expireIdleDrafts(now: number, limit: number): Promise<number> {
    return this.#db.transaction(async (tx) => {
      const idle = tx
        .select({ id: applications.id })
        .from(applications)
        .where(and(eq(applications.status, 'draft'), lte(applications.expiresAt, new Date(now))))
        .orderBy(asc(applications.expiresAt))
        .limit(Math.max(0, Math.floor(limit)))
        .for('update', { skipLocked: true });

      const deleted = await tx
        .delete(applications)
        .where(and(inArray(applications.id, idle), eq(applications.status, 'draft')))
        .returning({ id: applications.id });
      return deleted.length;
    });
  }

  async restartDrafts(
    guildId: string,
    formId: string,
    keepVersionId: string,
    actorId: string,
  ): Promise<number> {
    return this.#db.transaction(async (tx) => {
      await lockIntake(tx, guildId);
      const at = await dbNow(tx);
      return restart(tx, guildId, formId, keepVersionId, { id: actorId, source: 'system' }, at);
    });
  }

  async purgeContent(now: number, limit: number): Promise<number> {
    return this.#db.transaction(async (tx) => {
      const due = tx
        .select({ id: applications.id })
        .from(applications)
        .where(
          and(
            isNull(applications.contentPurgedAt),
            lte(applications.contentPurgeAt, new Date(now)),
          ),
        )
        .orderBy(asc(applications.contentPurgeAt))
        .limit(Math.max(0, Math.floor(limit)))
        .for('update', { skipLocked: true });

      const rows = await tx
        .update(applications)
        .set({
          ...SCRUBBED,
          contentPurgedAt: new Date(now),
          revision: sql`${applications.revision} + 1`,
          updatedAt: new Date(now),
        })
        .where(and(inArray(applications.id, due), isNull(applications.contentPurgedAt)))
        .returning();

      const purged = rows.map(toApplicationRecord);
      await scrubChildren(
        tx,
        purged.map((application) => application.id),
      );

      const woken = new Set<string>();
      for (const application of purged) {
        await insertEvent(tx, {
          id: `${application.id}:content_purged:${application.revision}`,
          application,
          kind: 'content_purged',
          actorId: APPLICATIONS_ACTOR,
          source: 'system',
          fromStatus: application.status,
          data: {},
          at: now,
        });

        if (application.cardChannelId === null || application.cardMessageId === null) continue;

        const card: EffectPlan = {
          key: CARD_KEY,
          kind: 'card',
          trigger: 'purge',
          params: { channelId: application.cardChannelId },
        };
        await insertEffects(tx, application, [card], now);
        if (!woken.has(application.guildId)) {
          woken.add(application.guildId);
          await wake(tx, application.guildId, now);
        }
      }

      return purged.length;
    });
  }

  async extendInfoDeadlines(guildId: string, minDueAt: number): Promise<number> {
    const rows = await this.#db
      .update(applications)
      .set({ infoDueAt: new Date(minDueAt) })
      .where(
        and(
          eq(applications.guildId, guildId),
          live,
          eq(applications.status, 'needs_info'),
          lt(applications.infoDueAt, new Date(minDueAt)),
        ),
      )
      .returning({ id: applications.id });
    return rows.length;
  }

  async rescheduleRetention(guildId: string, retentionDays: number): Promise<number> {
    const days = Math.floor(retentionDays);
    const rows = await this.#db
      .update(applications)
      .set({
        contentPurgeAt: sql`coalesce(${applications.decidedAt}, ${applications.withdrawnAt}, ${applications.updatedAt}) + ${days}::int * interval '24 hours'`,
      })
      .where(
        and(
          eq(applications.guildId, guildId),
          live,
          statusIn(FINAL_STATUSES),
          isNull(applications.contentPurgedAt),
        ),
      )
      .returning({ id: applications.id });
    return rows.length;
  }

  async deleteApplication(input: DeleteApplicationInput): Promise<DeleteApplicationResult> {
    return this.#db.transaction(async (tx) => {
      const row = await lockedApplication(tx, input.guildId, input.applicationId);
      if (row === undefined) return { status: 'missing' as const };
      if (row.deletedAt !== null) {
        return { status: 'deleted' as const, application: toApplicationRecord(row) };
      }

      const at = input.now ?? (await dbNow(tx));
      const application = await deleteLocked(tx, row, input.actor, at, input.cleanup);
      await insertAudit(tx, input.guildId, input.audit, at);
      return { status: 'deleted' as const, application };
    });
  }

  async deleteApplicant(input: DeleteApplicantInput): Promise<{ deleted: number }> {
    return this.#db.transaction(async (tx) => {
      const rows = await tx
        .select()
        .from(applications)
        .where(
          and(
            eq(applications.guildId, input.guildId),
            eq(applications.applicantId, input.applicantId),
            live,
          ),
        )
        .orderBy(asc(applications.id))
        .for('update');

      const at = input.now ?? (await dbNow(tx));
      for (const row of rows) await deleteLocked(tx, row, input.actor, at, input.cleanup);

      await insertAudit(tx, input.guildId, input.audit, at);
      return { deleted: rows.length };
    });
  }

  async exportRows(
    guildId: string,
    query: ExportRowsQuery,
    limit: number,
  ): Promise<{ rows: ApplicationRecord[]; truncated: boolean }> {
    if (query.formId !== undefined && !query.formIds.includes(query.formId)) {
      return { rows: [], truncated: false };
    }

    const take = Math.max(0, Math.floor(limit));
    const rows = await this.#db
      .select()
      .from(applications)
      .where(
        and(
          queueBase(guildId, query.formIds, query.viewerId),
          query.formId === undefined ? undefined : eq(applications.formId, query.formId),
          viewCondition(query.view, true),
          query.from === undefined
            ? undefined
            : sql`${applications.submittedAt} >= ${iso(query.from)}::timestamptz`,
          query.to === undefined
            ? undefined
            : sql`${applications.submittedAt} <= ${iso(query.to)}::timestamptz`,
        ),
      )
      .orderBy(asc(applications.submittedAt), asc(applications.number))
      .limit(take + 1);

    return {
      rows: rows.slice(0, take).map(toApplicationRecord),
      truncated: rows.length > take,
    };
  }
}
