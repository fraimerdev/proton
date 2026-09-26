import { type ApplicationLifecycle, type ApplicationStatus, moduleScheduleKey } from '@proton/core';
import { APPLICATIONS_ACTOR, MODULE_ID, REQUEST_ANSWER_TIMEOUT_MS } from '../src/constants.ts';
import {
  CARD_KEY,
  DELETE_CARD_KEY,
  deleteCardPlan,
  type EffectPlan,
  XP_KEY,
} from '../src/effects.ts';
import { ACTIVE_STATUSES, FINAL_STATUSES } from '../src/status.ts';
import {
  type Actor,
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
} from '../src/store.ts';
import { sameSnapshot } from '../src/version.ts';
import type { QueueSummary, QueueView } from '../src/view.ts';

const DAY_MS = 24 * 60 * 60 * 1000;
const MINE_LIMIT = 100;
const LEASED: readonly string[] = ['running', 'requested'];
const UNFINISHED: readonly string[] = ['pending', 'failed', 'running', 'requested'];
const XP_REPLANNABLE: readonly string[] = ['failed', 'skipped', 'cancelled'];
const AWAITING: readonly ApplicationStatus[] = ['submitted', 'in_review'];

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

type Owned<T> = T & { guildId: string; applicationId: string };

interface GrantRow {
  guildId: string;
  applicationId: string;
  userId: string;
  roleId: string;
  grantedAt: number;
  removedAt: number | null;
}

export interface WakeRow {
  guildId: string;
  runAt: number;
  key: string;
}

export interface AuditRow extends AuditInput {
  guildId: string;
  createdAt: number;
}

function jsonb<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function copy<T>(value: T): T {
  return structuredClone(value);
}

export function applicationRecord(overrides: Partial<ApplicationRecord> = {}): ApplicationRecord {
  return {
    id: 'app-1',
    guildId: '900000000000000001',
    number: 1,
    formId: 'mods',
    versionId: 'version-1',
    applicantId: '400000000000000001',
    applicantName: 'applicant',
    status: 'submitted',
    revision: 1,
    draft: {},
    step: 0,
    answers: [],
    source: 'discord',
    assigneeId: null,
    assignedAt: null,
    submittedAt: 1_000,
    reviewStartedAt: null,
    infoRequestedAt: null,
    infoDueAt: null,
    waitlistedAt: null,
    decidedAt: null,
    decidedBy: null,
    decisionReason: null,
    withdrawnAt: null,
    reopenedCount: 0,
    archivedAt: null,
    expiresAt: null,
    reviewDueAt: null,
    remindedAt: null,
    contentPurgeAt: null,
    contentPurgedAt: null,
    deletedAt: null,
    dmChannelId: null,
    cardChannelId: null,
    cardMessageId: null,
    cardRevision: -1,
    interviewTicketId: null,
    interviewChannelId: null,
    createdAt: 1_000,
    updatedAt: 1_000,
    ...overrides,
  };
}

function meets(application: ApplicationRecord, expect: TransitionExpect): boolean {
  if (application.deletedAt !== null) return false;
  if (expect.statuses !== undefined && !expect.statuses.includes(application.status)) return false;
  if (expect.assigneeId !== undefined && application.assigneeId !== expect.assigneeId) return false;
  if (expect.revision !== undefined && application.revision !== expect.revision) return false;
  return true;
}

function applyPatch(application: ApplicationRecord, patch: TransitionPatch): ApplicationRecord {
  const next = { ...application };
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) Object.assign(next, { [key]: value });
  }
  return next;
}

function inView(application: ApplicationRecord, view: QueueView, archivedInAll: boolean): boolean {
  const shown = application.archivedAt === null;
  switch (view) {
    case 'awaiting':
      return AWAITING.includes(application.status) && shown;
    case 'all':
      return archivedInAll || shown;
    case 'archived':
      return !shown;
    default:
      return application.status === view && shown;
  }
}

function matches(application: ApplicationRecord, q: string | undefined): boolean {
  const text = q?.trim() ?? '';
  if (text === '') return true;

  const reference = /^#?(\d{1,9})$/.exec(text);
  return (
    (application.applicantName ?? '').toLowerCase().includes(text.toLowerCase()) ||
    application.applicantId === text ||
    (reference?.[1] !== undefined && application.number === Number(reference[1]))
  );
}

function byThenId(
  value: (application: ApplicationRecord) => number | null,
  direction: 1 | -1,
): (a: ApplicationRecord, b: ApplicationRecord) => number {
  return (a, b) => {
    const left = value(a) ?? Number.POSITIVE_INFINITY;
    const right = value(b) ?? Number.POSITIVE_INFINITY;
    if (left !== right) return (left < right ? -1 : 1) * direction;
    return (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) * direction;
  };
}

// No locks: no method awaits before it finishes, so two calls can never interleave.
export class MemoryApplicationStore implements ApplicationStore {
  readonly versionsById = new Map<string, FormVersionRecord>();
  readonly applicationsById = new Map<string, ApplicationRecord>();
  readonly eventRows: Owned<EventRecord>[] = [];
  readonly threadRows: Owned<ThreadRecord>[] = [];
  readonly noteRows: Owned<NoteRecord>[] = [];
  readonly voteRows = new Map<string, Owned<VoteRecord> & { createdAt: number }>();
  readonly effectsById = new Map<string, EffectRecord>();
  readonly grantRows = new Map<string, GrantRow>();
  readonly auditRows = new Map<string, AuditRow>();
  readonly wakeRows = new Map<string, WakeRow>();

  #clock: () => number;
  #sequence = 0;

  constructor(options: { now?: () => number } = {}) {
    this.#clock = options.now ?? (() => Date.now());
  }

  setClock(now: () => number): void {
    this.#clock = now;
  }

  #id(prefix: string): string {
    this.#sequence += 1;
    return `${prefix}-${String(this.#sequence).padStart(6, '0')}`;
  }

  #at(now?: number): number {
    return Math.floor(now ?? this.#clock());
  }

  #app(guildId: string, id: string): ApplicationRecord | undefined {
    const application = this.applicationsById.get(id);
    return application?.guildId === guildId ? application : undefined;
  }

  #guildApps(guildId: string): ApplicationRecord[] {
    return [...this.applicationsById.values()].filter((app) => app.guildId === guildId);
  }

  #save(application: ApplicationRecord): ApplicationRecord {
    const stored = { ...application, draft: jsonb(application.draft) };
    if (application.answers !== null) stored.answers = jsonb(application.answers);
    this.applicationsById.set(stored.id, stored);
    return copy(stored);
  }

  #removeApplication(id: string): void {
    this.applicationsById.delete(id);
    const keep = <T extends { applicationId: string }>(rows: T[]) => {
      const kept = rows.filter((row) => row.applicationId !== id);
      rows.splice(0, rows.length, ...kept);
    };
    keep(this.eventRows);
    keep(this.threadRows);
    keep(this.noteRows);
    for (const [key, row] of this.voteRows) {
      if (row.applicationId === id) this.voteRows.delete(key);
    }
    for (const [key, row] of this.effectsById) {
      if (row.applicationId === id) this.effectsById.delete(key);
    }
    for (const [key, row] of this.grantRows) {
      if (row.applicationId === id) this.grantRows.delete(key);
    }
  }

  #wake(guildId: string, at: number): void {
    const runAt = wakeSlot(at);
    const key = moduleScheduleKey(MODULE_ID, SWEEP_JOB, guildId, `${WAKE_KEY}:${runAt}`);
    if (!this.wakeRows.has(key)) this.wakeRows.set(key, { guildId, runAt, key });
  }

  #audit(guildId: string, audit: AuditInput, at: number): void {
    if (!this.auditRows.has(audit.id)) {
      this.auditRows.set(audit.id, { ...jsonb(audit), guildId, createdAt: at });
    }
  }

  #event(
    id: string,
    application: ApplicationRecord,
    input: {
      kind: string;
      actor: Actor;
      fromStatus: ApplicationStatus | null;
      data: Record<string, unknown>;
      at: number;
    },
  ): void {
    if (this.eventRows.some((row) => row.id === id)) return;
    this.eventRows.push({
      id,
      guildId: application.guildId,
      applicationId: application.id,
      kind: input.kind,
      actorId: input.actor.id,
      source: input.actor.source,
      fromStatus: input.fromStatus,
      toStatus: application.status,
      revision: application.revision,
      data: jsonb(input.data),
      createdAt: input.at,
    });
  }

  #effects(
    application: ApplicationRecord,
    plans: readonly EffectPlan[],
    at: number,
  ): EffectRecord[] {
    const seen = new Set<string>();
    const written: EffectRecord[] = [];

    for (const plan of plans) {
      if (seen.has(plan.key)) continue;
      seen.add(plan.key);

      const existing = [...this.effectsById.values()].find(
        (effect) => effect.applicationId === application.id && effect.key === plan.key,
      );

      if (existing === undefined) {
        const effect: EffectRecord = {
          id: this.#id('effect'),
          guildId: application.guildId,
          applicationId: application.id,
          key: plan.key,
          kind: plan.kind,
          trigger: plan.trigger,
          revision: application.revision,
          params: jsonb(plan.params),
          status: 'pending',
          attempts: 0,
          claimSeq: 0,
          leaseUntil: null,
          nextAttemptAt: at,
          result: {},
          errorCode: null,
          error: null,
          createdAt: at,
          updatedAt: at,
        };
        this.effectsById.set(effect.id, effect);
        written.push(copy(effect));
        continue;
      }

      const replanned = plan.key === XP_KEY && XP_REPLANNABLE.includes(existing.status);
      if (plan.key !== CARD_KEY && !replanned) continue;

      const leased = LEASED.includes(existing.status);
      const updated: EffectRecord = {
        ...existing,
        trigger: plan.trigger,
        revision: Math.max(existing.revision, application.revision),
        params: jsonb(plan.params),
        status: 'pending',
        attempts: 0,
        leaseUntil: leased ? existing.leaseUntil : null,
        nextAttemptAt: at,
        ...(replanned ? { result: {} } : {}),
        errorCode: null,
        error: null,
        updatedAt: at,
      };
      this.effectsById.set(updated.id, updated);
      written.push(copy(updated));
    }

    return written;
  }

  #complete(
    plans: readonly EffectPlan[],
    application: ApplicationRecord,
    actorId: string,
    at: number,
    formName?: string,
  ): EffectPlan[] {
    if (!plans.some((plan) => plan.kind === 'event')) return [...plans];

    const number = application.number;
    if (number === null) return plans.filter((plan) => plan.kind !== 'event');

    const planned = plans
      .filter((plan) => plan.kind === 'event')
      .map((plan) => (plan.params.payload as { formName?: unknown } | undefined)?.formName)
      .find((name): name is string => typeof name === 'string' && name.length > 0);
    const name =
      formName ??
      planned ??
      this.versionsById.get(application.versionId)?.snapshot.name ??
      application.formId;

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

  #supersede(applicationId: string, at: number): void {
    for (const effect of this.effectsById.values()) {
      if (
        effect.applicationId === applicationId &&
        SUPERSEDED_KINDS.includes(effect.kind) &&
        SUPERSEDED_TRIGGERS.includes(effect.trigger) &&
        UNFINISHED.includes(effect.status) &&
        (effect.leaseUntil === null || effect.leaseUntil <= at)
      ) {
        this.effectsById.set(effect.id, {
          ...effect,
          status: 'skipped',
          errorCode: CHANGED_CODE,
          error: CHANGED_ERROR,
          leaseUntil: null,
          updatedAt: at,
        });
      }
    }
  }

  #scrubChildren(applicationId: string): void {
    for (const row of this.threadRows) if (row.applicationId === applicationId) row.body = null;
    for (const row of this.noteRows) if (row.applicationId === applicationId) row.body = null;
  }

  #restart(guildId: string, formId: string, keepVersionId: string, actor: Actor, at: number) {
    let expired = 0;
    for (const application of this.#guildApps(guildId)) {
      if (
        application.formId !== formId ||
        application.status !== 'draft' ||
        application.versionId === keepVersionId ||
        application.deletedAt !== null
      ) {
        continue;
      }

      const saved = this.#save({
        ...application,
        status: 'expired',
        draft: {},
        applicantName: null,
        contentPurgedAt: at,
        revision: application.revision + 1,
        updatedAt: at,
      });
      this.#event(`${saved.id}:expired:${saved.revision}`, saved, {
        kind: 'expired',
        actor,
        fromStatus: 'draft',
        data: { reason: 'form_changed' },
        at,
      });
      expired += 1;
    }
    return expired;
  }

  #deleteOne(
    row: ApplicationRecord,
    actor: Actor,
    at: number,
    cleanup: PlanEffects | undefined,
  ): ApplicationRecord {
    if (row.status === 'draft') {
      this.#removeApplication(row.id);
      return copy(row);
    }

    const application = this.#save({
      ...row,
      answers: null,
      draft: {},
      applicantName: null,
      decisionReason: null,
      contentPurgedAt: at,
      deletedAt: at,
      revision: row.revision + 1,
      updatedAt: at,
    });
    this.#scrubChildren(application.id);

    for (const effect of this.effectsById.values()) {
      if (
        effect.applicationId === application.id &&
        UNFINISHED.includes(effect.status) &&
        effect.kind !== 'delete_card' &&
        !(effect.kind === 'remove_role' && effect.params.fromGrants === true)
      ) {
        this.effectsById.set(effect.id, {
          ...effect,
          status: 'cancelled',
          leaseUntil: null,
          updatedAt: at,
        });
      }
    }

    const removal = deleteCardPlan(application);
    const plans = this.#complete(
      [
        ...(cleanup === undefined ? [] : cleanup(copy(application), application.revision)),
        ...(removal === null ? [] : [removal]),
      ],
      application,
      actor.id,
      at,
    );
    const effects = this.#effects(application, plans, at);
    this.#event(`${application.id}:deleted:${application.revision}`, application, {
      kind: 'deleted',
      actor,
      fromStatus: row.status,
      data: {},
      at,
    });
    if (effects.length > 0) this.#wake(application.guildId, at);
    return application;
  }

  #queue(guildId: string, formIds: readonly string[], viewerId: string): ApplicationRecord[] {
    return this.#guildApps(guildId).filter(
      (app) =>
        app.deletedAt === null &&
        app.number !== null &&
        formIds.includes(app.formId) &&
        app.applicantId !== viewerId,
    );
  }

  async now(): Promise<number> {
    return this.#at();
  }

  #latest(guildId: string): Map<string, FormVersionRecord> {
    const latest = new Map<string, FormVersionRecord>();
    for (const version of this.versionsById.values()) {
      if (version.guildId !== guildId) continue;
      const current = latest.get(version.formId);
      if (current === undefined || version.version > current.version) {
        latest.set(version.formId, copy(version));
      }
    }
    return latest;
  }

  #votes(guildId: string, applicationId: string): VoteRecord[] {
    return [...this.voteRows.values()]
      .filter((row) => row.guildId === guildId && row.applicationId === applicationId)
      .sort((a, b) => a.createdAt - b.createdAt || (a.reviewerId < b.reviewerId ? -1 : 1))
      .map(({ reviewerId, vote, score, updatedAt }) => ({ reviewerId, vote, score, updatedAt }));
  }

  async latestVersions(guildId: string): Promise<Map<string, FormVersionRecord>> {
    return this.#latest(guildId);
  }

  async version(guildId: string, versionId: string): Promise<FormVersionRecord | null> {
    const version = this.versionsById.get(versionId);
    return version?.guildId === guildId ? copy(version) : null;
  }

  async versions(guildId: string, formId: string): Promise<FormVersionRecord[]> {
    return [...this.versionsById.values()]
      .filter((version) => version.guildId === guildId && version.formId === formId)
      .sort((a, b) => b.version - a.version)
      .map(copy);
  }

  async publish(input: PublishInput): Promise<PublishOutcome> {
    const at = this.#at(input.now);
    const actor: Actor = { id: input.publishedBy, source: 'dashboard' };
    const latest = this.#latest(input.guildId).get(input.formId) ?? null;

    if (latest !== null && sameSnapshot(latest.snapshot, input.snapshot)) {
      const expired =
        input.draftPolicy === 'restart'
          ? this.#restart(input.guildId, input.formId, latest.id, actor, at)
          : 0;
      if (expired > 0) this.#audit(input.guildId, input.audit, at);
      return { status: 'unchanged', version: latest, draftsExpired: expired };
    }

    const version: FormVersionRecord = {
      id: this.#id('version'),
      guildId: input.guildId,
      formId: input.formId,
      version: (latest?.version ?? 0) + 1,
      snapshot: jsonb(input.snapshot),
      draftPolicy: input.draftPolicy,
      publishedBy: input.publishedBy,
      publishedAt: at,
    };
    this.versionsById.set(version.id, version);

    const expired =
      input.draftPolicy === 'restart'
        ? this.#restart(input.guildId, input.formId, version.id, actor, at)
        : 0;
    this.#audit(input.guildId, input.audit, at);
    return { status: 'published', version: copy(version), draftsExpired: expired };
  }

  async counts(guildId: string): Promise<Map<string, FormCounts>> {
    const counts = new Map<string, FormCounts>();
    for (const app of this.#guildApps(guildId)) {
      if (app.deletedAt !== null) continue;
      const entry = counts.get(app.formId) ?? {
        awaiting: 0,
        needsInfo: 0,
        drafts: 0,
        total: 0,
        submittedForCap: 0,
      };
      if (AWAITING.includes(app.status) && app.archivedAt === null) entry.awaiting += 1;
      if (app.status === 'needs_info') entry.needsInfo += 1;
      if (app.status === 'draft') entry.drafts += 1;
      if (app.number !== null) entry.total += 1;
      if (app.submittedAt !== null && app.status !== 'withdrawn') entry.submittedForCap += 1;
      counts.set(app.formId, entry);
    }
    return counts;
  }

  async draftCount(guildId: string, formId: string, olderThanVersionId?: string): Promise<number> {
    return this.#guildApps(guildId).filter(
      (app) =>
        app.formId === formId &&
        app.status === 'draft' &&
        app.deletedAt === null &&
        (olderThanVersionId === undefined || app.versionId !== olderThanVersionId),
    ).length;
  }

  async get(guildId: string, id: string): Promise<ApplicationRecord | null> {
    const app = this.#app(guildId, id);
    return app === undefined ? null : copy(app);
  }

  async byNumber(guildId: string, number: number): Promise<ApplicationRecord | null> {
    const app = this.#guildApps(guildId).find((candidate) => candidate.number === number);
    return app === undefined ? null : copy(app);
  }

  async draftFor(
    guildId: string,
    formId: string,
    applicantId: string,
  ): Promise<ApplicationRecord | null> {
    const app = this.#guildApps(guildId).find(
      (candidate) =>
        candidate.formId === formId &&
        candidate.applicantId === applicantId &&
        candidate.status === 'draft' &&
        candidate.deletedAt === null,
    );
    return app === undefined ? null : copy(app);
  }

  async mine(guildId: string | null, applicantId: string): Promise<ApplicationRecord[]> {
    return [...this.applicationsById.values()]
      .filter(
        (app) =>
          app.applicantId === applicantId &&
          (guildId === null || app.guildId === guildId) &&
          app.deletedAt === null,
      )
      .sort(byThenId((app) => app.createdAt, -1))
      .slice(0, MINE_LIMIT)
      .map(copy);
  }

  async startDraft(
    input: StartDraftInput,
  ): Promise<{ status: 'started' | 'existing'; application: ApplicationRecord }> {
    const at = this.#at(input.now);
    const existing = this.#guildApps(input.guildId).find(
      (app) =>
        app.formId === input.formId &&
        app.applicantId === input.applicantId &&
        app.status === 'draft',
    );
    if (existing !== undefined) return { status: 'existing', application: copy(existing) };

    const latest = this.#latest(input.guildId).get(input.formId);
    if (latest === undefined) {
      throw new Error(
        `form ${input.formId} has no published version in server ${input.guildId}, so no draft can start`,
      );
    }

    const application = this.#save(
      applicationRecord({
        id: this.#id('app'),
        guildId: input.guildId,
        number: null,
        formId: input.formId,
        versionId: latest.id,
        applicantId: input.applicantId,
        applicantName: input.applicantName,
        status: 'draft',
        revision: 0,
        answers: null,
        source: input.source === 'discord' || input.source === 'web' ? input.source : null,
        submittedAt: null,
        expiresAt: input.expiresAt,
        createdAt: at,
        updatedAt: at,
      }),
    );
    return { status: 'started', application };
  }

  async saveDraft(input: SaveDraftInput): Promise<SaveDraftResult> {
    const current = this.#app(input.guildId, input.applicationId);
    if (
      current === undefined ||
      current.applicantId !== input.applicantId ||
      current.status !== 'draft' ||
      current.deletedAt !== null
    ) {
      return { status: 'gone' };
    }
    if (input.expectedRevision !== null && current.revision !== input.expectedRevision) {
      return { status: 'conflict', application: copy(current) };
    }

    const at = this.#at(input.now);
    const application = this.#save({
      ...current,
      draft: input.mode === 'merge' ? { ...current.draft, ...input.answers } : { ...input.answers },
      step: input.step ?? current.step,
      expiresAt: input.expiresAt,
      revision: current.revision + 1,
      updatedAt: at,
    });
    return { status: 'saved', application };
  }

  async discardDraft(
    guildId: string,
    applicationId: string,
    applicantId: string,
  ): Promise<boolean> {
    const app = this.#app(guildId, applicationId);
    if (app === undefined || app.applicantId !== applicantId || app.status !== 'draft') {
      return false;
    }
    this.#removeApplication(app.id);
    return true;
  }

  async submit(input: SubmitInput): Promise<SubmitResult> {
    const refuse = (
      code: SubmitRefusalCode,
      message: string,
      extra: { retryAt?: number; existingId?: string } = {},
    ): SubmitResult => ({ status: 'refused', code, message, ...extra });

    const row = this.#app(input.guildId, input.applicationId);
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

    const at = this.#at(input.now);
    const { limits } = input;
    const history = this.#guildApps(input.guildId).filter(
      (app) =>
        app.formId === row.formId &&
        app.applicantId === input.applicantId &&
        app.deletedAt === null &&
        app.number !== null,
    );

    const active = history
      .filter((app) => (ACTIVE_STATUSES as readonly string[]).includes(app.status))
      .sort(byThenId((app) => app.submittedAt, -1));
    if (active.length >= limits.maxActive) {
      const existingId = active[0]?.id;
      return refuse('active', MESSAGES.active, existingId === undefined ? {} : { existingId });
    }

    const lastAt = history
      .map((app) =>
        Math.max(
          ...[app.decidedAt, app.withdrawnAt, app.submittedAt].filter(
            (value): value is number => value !== null,
          ),
        ),
      )
      .filter((value) => Number.isFinite(value))
      .reduce<number | null>((max, value) => (max === null || value > max ? value : max), null);

    if (limits.cooldownDays > 0 && lastAt !== null) {
      const retryAt = lastAt + limits.cooldownDays * DAY_MS;
      if (retryAt > at) return refuse('cooldown', MESSAGES.cooldown, { retryAt });
    }

    if (limits.cap !== undefined) {
      const taken = this.#guildApps(input.guildId).filter(
        (app) =>
          app.formId === row.formId &&
          app.submittedAt !== null &&
          app.status !== 'withdrawn' &&
          app.deletedAt === null,
      ).length;
      if (taken >= limits.cap) return refuse('cap', MESSAGES.cap);
    }

    const number = Math.max(0, ...this.#guildApps(input.guildId).map((app) => app.number ?? 0)) + 1;

    const application = this.#save({
      ...row,
      status: 'submitted',
      number,
      revision: row.revision + 1,
      answers: input.answers,
      draft: {},
      step: 0,
      source: input.source === 'discord' || input.source === 'web' ? input.source : null,
      applicantName: input.applicantName ?? row.applicantName,
      submittedAt: at,
      reviewDueAt: input.reviewDueAt,
      expiresAt: null,
      updatedAt: at,
    });

    const plans = this.#complete(
      input.plan(copy(application), application.revision),
      application,
      input.lifecycle.actorId,
      at,
      input.lifecycle.formName,
    );
    const effects = this.#effects(application, plans, at);

    this.#event(`${application.id}:submitted:${application.revision}`, application, {
      kind: 'submitted',
      actor: { id: input.applicantId, source: input.source },
      fromStatus: 'draft',
      data: { answers: input.answers.length },
      at,
    });

    if (effects.length > 0 || application.reviewDueAt !== null) this.#wake(input.guildId, at);
    return { status: 'submitted', application: copy(application), effects };
  }

  async transition(input: TransitionInput): Promise<TransitionResult> {
    const before = this.#app(input.guildId, input.applicationId);
    if (before === undefined) return { status: 'stale', application: null };

    const replayed =
      (input.audit !== undefined && this.auditRows.has(input.audit.id)) ||
      (input.event.id !== undefined && this.eventRows.some((row) => row.id === input.event.id));
    if (replayed) return { status: 'done', application: copy(before), effects: [] };

    if (!meets(before, input.expect)) return { status: 'stale', application: copy(before) };

    const at = this.#at(input.now);
    const bump = input.bumpRevision !== false;
    const application = this.#save({
      ...applyPatch(before, input.patch),
      revision: bump ? before.revision + 1 : before.revision,
      updatedAt: at,
    });

    const eventId =
      input.event.id ??
      `${application.id}:${input.event.kind}:${application.revision}${bump ? '' : `:${this.#id('event')}`}`;

    this.#event(eventId, application, {
      kind: input.event.kind,
      actor: input.actor,
      fromStatus: before.status,
      data: {
        ...(input.event.lifecycle === undefined ? {} : { lifecycle: input.event.lifecycle }),
        ...input.event.data,
      },
      at,
    });

    if (input.thread !== undefined) {
      this.threadRows.push({
        id: `${eventId}:thread`,
        guildId: application.guildId,
        applicationId: application.id,
        kind: input.thread.kind,
        authorId: input.actor.id,
        body: input.thread.body,
        revision: application.revision,
        createdAt: at,
      });
    }

    if (input.note !== undefined) {
      this.noteRows.push({
        id: `${eventId}:note`,
        guildId: application.guildId,
        applicationId: application.id,
        authorId: input.actor.id,
        body: input.note.body,
        createdAt: at,
      });
    }

    if (input.clearVotes === true) {
      for (const [key, row] of this.voteRows) {
        if (row.applicationId === application.id) this.voteRows.delete(key);
      }
    }

    if (input.vote !== undefined) {
      const key = `${application.id}:${input.actor.id}`;
      const existing = this.voteRows.get(key);
      this.voteRows.set(key, {
        guildId: application.guildId,
        applicationId: application.id,
        reviewerId: input.actor.id,
        vote: input.vote.vote,
        score: input.vote.score,
        createdAt: existing?.createdAt ?? at,
        updatedAt: at,
      });
    }

    if (input.supersede === true) this.#supersede(application.id, at);

    const plans =
      input.plan === undefined
        ? []
        : this.#complete(
            input.plan(copy(application), application.revision),
            application,
            input.actor.id,
            at,
          );
    const effects = this.#effects(application, plans, at);

    if (input.audit !== undefined) this.#audit(input.guildId, input.audit, at);
    const due =
      (input.patch.reviewDueAt !== undefined && input.patch.reviewDueAt !== null) ||
      (input.patch.infoDueAt !== undefined && input.patch.infoDueAt !== null);
    if (effects.length > 0 || due) this.#wake(input.guildId, at);

    return { status: 'done', application: copy(application), effects };
  }

  async votes(guildId: string, applicationId: string): Promise<VoteRecord[]> {
    return this.#votes(guildId, applicationId);
  }

  async detail(guildId: string, applicationId: string): Promise<ApplicationDetailRecord | null> {
    const application = this.#app(guildId, applicationId);
    if (application === undefined) return null;

    const owned = <T extends { guildId: string; applicationId: string }>(rows: Iterable<T>) =>
      [...rows].filter((row) => row.guildId === guildId && row.applicationId === applicationId);
    const strip = <T extends { guildId: string; applicationId: string }>({
      guildId: _guild,
      applicationId: _application,
      ...rest
    }: T) => rest;

    return {
      application: copy(application),
      thread: owned(this.threadRows).map(strip).map(copy),
      notes: owned(this.noteRows).map(strip).map(copy),
      votes: this.#votes(guildId, applicationId),
      events: owned(this.eventRows).map(strip).map(copy),
      effects: owned(this.effectsById.values())
        .sort((a, b) => a.createdAt - b.createdAt)
        .map(copy),
    };
  }

  async list(guildId: string, query: ListQuery): Promise<ListResult> {
    const empty: ListResult = { items: [], total: 0, problems: new Map(), votes: new Map() };
    if (query.formId !== undefined && !query.formIds.includes(query.formId)) return empty;

    const direction = query.dir === 'asc' ? 1 : -1;
    const order =
      query.sort === 'number'
        ? byThenId((app) => app.number, direction)
        : query.sort === 'updated'
          ? byThenId((app) => app.updatedAt, direction)
          : byThenId((app) => app.submittedAt, direction);

    const matching = this.#queue(guildId, query.formIds, query.viewerId)
      .filter((app) => query.formId === undefined || app.formId === query.formId)
      .filter((app) => inView(app, query.view, false))
      .filter((app) => {
        if (query.assignee === undefined) return true;
        if (query.assignee === 'none') return app.assigneeId === null;
        return app.assigneeId === (query.assignee === 'me' ? query.viewerId : query.assignee);
      })
      .filter((app) => matches(app, query.q))
      .sort(order);

    const start = (query.page - 1) * query.pageSize;
    const items = matching.slice(start, start + query.pageSize).map(copy);
    const ids = new Set(items.map((item) => item.id));

    const problems = new Map<string, EffectRecord[]>();
    for (const effect of this.effectsById.values()) {
      if (!ids.has(effect.applicationId) || effect.status !== 'failed') continue;
      problems.set(effect.applicationId, [
        ...(problems.get(effect.applicationId) ?? []),
        copy(effect),
      ]);
    }

    const votes = new Map<string, VoteTally>();
    for (const vote of this.voteRows.values()) {
      if (!ids.has(vote.applicationId)) continue;
      const tally = votes.get(vote.applicationId) ?? { accept: 0, reject: 0 };
      tally[vote.vote] += 1;
      votes.set(vote.applicationId, tally);
    }

    return { items, total: matching.length, problems, votes };
  }

  async summary(
    guildId: string,
    formIds: readonly string[],
    viewerId: string,
  ): Promise<QueueSummary> {
    const queue = this.#queue(guildId, formIds, viewerId);
    const awaiting = queue.filter((app) => inView(app, 'awaiting', false));
    const failing = new Set(
      [...this.effectsById.values()]
        .filter((effect) => effect.status === 'failed')
        .map((effect) => effect.applicationId),
    );
    const oldest = awaiting
      .map((app) => app.submittedAt)
      .filter((at): at is number => at !== null)
      .sort((a, b) => a - b)[0];

    return {
      awaiting: awaiting.length,
      unassigned: awaiting.filter((app) => app.assigneeId === null).length,
      needsInfo: queue.filter((app) => inView(app, 'needs_info', false)).length,
      waitlisted: queue.filter((app) => inView(app, 'waitlisted', false)).length,
      problems: queue.filter((app) => failing.has(app.id)).length,
      oldestAwaitingAt: oldest ?? null,
    };
  }

  async dueWork(guildId: string, now: number, limit: number): Promise<DueWork> {
    const take = Math.max(0, Math.floor(limit));
    const leaseFree = (effect: EffectRecord) =>
      effect.leaseUntil === null || effect.leaseUntil <= now;

    const guildEffects = [...this.effectsById.values()].filter((e) => e.guildId === guildId);
    const effects = guildEffects
      .filter(
        (effect) =>
          (effect.status === 'pending' && effect.nextAttemptAt <= now && leaseFree(effect)) ||
          (LEASED.includes(effect.status) && leaseFree(effect)),
      )
      .sort((a, b) => a.nextAttemptAt - b.nextAttemptAt || a.createdAt - b.createdAt)
      .slice(0, take)
      .map(copy);

    const apps = this.#guildApps(guildId).filter((app) => app.deletedAt === null);
    const reviewDue = apps.filter(
      (app) => app.remindedAt === null && AWAITING.includes(app.status) && app.reviewDueAt !== null,
    );
    const infoDue = apps.filter((app) => app.status === 'needs_info' && app.infoDueAt !== null);

    const candidates = [
      ...guildEffects
        .filter((effect) => effect.status === 'pending')
        .map((effect) => Math.max(effect.nextAttemptAt, effect.leaseUntil ?? effect.nextAttemptAt)),
      ...guildEffects
        .filter((effect) => LEASED.includes(effect.status))
        .map((effect) => effect.leaseUntil ?? effect.updatedAt),
      ...reviewDue.map((app) => app.reviewDueAt ?? Number.POSITIVE_INFINITY),
      ...infoDue.map((app) => app.infoDueAt ?? Number.POSITIVE_INFINITY),
    ];

    return {
      effects,
      reminders: reviewDue
        .filter((app) => (app.reviewDueAt ?? Number.POSITIVE_INFINITY) <= now)
        .sort((a, b) => (a.reviewDueAt ?? 0) - (b.reviewDueAt ?? 0))
        .slice(0, take)
        .map(copy),
      infoExpiries: infoDue
        .filter((app) => (app.infoDueAt ?? Number.POSITIVE_INFINITY) <= now)
        .sort((a, b) => (a.infoDueAt ?? 0) - (b.infoDueAt ?? 0))
        .slice(0, take)
        .map(copy),
      nextDueAt: candidates.length === 0 ? null : Math.min(...candidates),
    };
  }

  async claimEffect(
    guildId: string,
    effectId: string,
    now: number,
    leaseMs: number,
  ): Promise<EffectClaim | null> {
    const effect = this.effectsById.get(effectId);
    if (effect === undefined || effect.guildId !== guildId) return null;

    const leaseFree = effect.leaseUntil === null || effect.leaseUntil <= now;
    const claimable =
      (effect.status === 'pending' && effect.nextAttemptAt <= now && leaseFree) ||
      (LEASED.includes(effect.status) && leaseFree);
    if (!claimable) return null;

    const claimed: EffectRecord = {
      ...effect,
      status: 'running',
      attempts: effect.attempts + 1,
      claimSeq: effect.claimSeq + 1,
      leaseUntil: now + leaseMs,
      updatedAt: now,
    };
    this.effectsById.set(claimed.id, claimed);
    return { effect: copy(claimed), token: claimed.claimSeq };
  }

  async finishEffect(
    guildId: string,
    effectId: string,
    token: number,
    outcome: EffectOutcome,
  ): Promise<boolean> {
    const effect = this.effectsById.get(effectId);
    if (
      effect === undefined ||
      effect.guildId !== guildId ||
      effect.claimSeq !== token ||
      !LEASED.includes(effect.status)
    ) {
      return false;
    }

    const at = this.#at();
    const next = outcome.nextAttemptAt;
    this.effectsById.set(effect.id, {
      ...effect,
      status: outcome.status,
      result: outcome.result === undefined ? effect.result : jsonb(outcome.result),
      errorCode: outcome.errorCode ?? null,
      error: outcome.error ?? null,
      leaseUntil: outcome.status === 'requested' ? (next ?? at + REQUEST_ANSWER_TIMEOUT_MS) : null,
      nextAttemptAt: outcome.status === 'pending' ? (next ?? at) : effect.nextAttemptAt,
      updatedAt: at,
    });
    return true;
  }

  async answerRequested(
    guildId: string,
    key: RequestedEffect,
    outcome: RequestAnswer,
  ): Promise<EffectRecord | null> {
    const effect = [...this.effectsById.values()].find(
      (candidate) =>
        candidate.guildId === guildId &&
        candidate.applicationId === key.applicationId &&
        ('effectKey' in key ? candidate.key === key.effectKey : candidate.id === key.effectId),
    );
    if (effect === undefined) return null;

    const settle =
      outcome.status === 'succeeded'
        ? effect.status !== 'succeeded'
        : effect.status === 'requested' ||
          effect.status === 'running' ||
          effect.status === 'pending';
    if (!settle) return copy(effect);

    const updated: EffectRecord = {
      ...effect,
      status: outcome.status,
      result: outcome.result === undefined ? effect.result : jsonb(outcome.result),
      errorCode: outcome.errorCode ?? null,
      error: outcome.error ?? null,
      leaseUntil: null,
      updatedAt: this.#at(),
    };
    this.effectsById.set(updated.id, updated);
    return copy(updated);
  }

  #settle(
    guildId: string,
    applicationId: string,
    effectId: string,
    actor: Actor,
    audit: AuditInput | undefined,
    change: 'retried' | 'cancelled',
  ): EffectRecord | null {
    const application = this.#app(guildId, applicationId);
    if (application === undefined || application.deletedAt !== null) return null;

    const effect = this.effectsById.get(effectId);
    if (
      effect === undefined ||
      effect.guildId !== guildId ||
      effect.applicationId !== applicationId
    ) {
      return null;
    }

    const allowed =
      change === 'retried' ? effect.status === 'failed' : UNFINISHED.includes(effect.status);
    if (!allowed) return null;

    const at = this.#at();
    const updated: EffectRecord =
      change === 'retried'
        ? {
            ...effect,
            status: 'pending',
            attempts: 0,
            leaseUntil: null,
            nextAttemptAt: at,
            errorCode: null,
            error: null,
            updatedAt: at,
          }
        : { ...effect, status: 'cancelled', leaseUntil: null, updatedAt: at };
    this.effectsById.set(updated.id, updated);

    const eventId = `${application.id}:effect_${change}:${effect.id}:${effect.updatedAt}`;
    this.#event(eventId, application, {
      kind: `effect_${change}`,
      actor,
      fromStatus: application.status,
      data: { effectId: effect.id, kind: effect.kind, key: effect.key },
      at,
    });
    const redraw =
      change === 'cancelled' &&
      effect.key !== CARD_KEY &&
      application.cardChannelId !== null &&
      application.cardMessageId !== null
        ? this.#effects(
            application,
            [
              {
                key: CARD_KEY,
                kind: 'card',
                trigger: 'card',
                params: { channelId: application.cardChannelId },
              },
            ],
            at,
          )
        : [];

    if (audit !== undefined) this.#audit(guildId, audit, at);
    if (change === 'retried' || redraw.length > 0) this.#wake(guildId, at);
    return copy(updated);
  }

  async retryEffect(
    guildId: string,
    applicationId: string,
    effectId: string,
    actor: Actor,
    audit?: AuditInput,
  ): Promise<EffectRecord | null> {
    return this.#settle(guildId, applicationId, effectId, actor, audit, 'retried');
  }

  async cancelEffect(
    guildId: string,
    applicationId: string,
    effectId: string,
    actor: Actor,
    audit?: AuditInput,
  ): Promise<EffectRecord | null> {
    return this.#settle(guildId, applicationId, effectId, actor, audit, 'cancelled');
  }

  async armWake(guildId: string, at: number): Promise<void> {
    this.#wake(guildId, at);
  }

  async rememberCard(
    guildId: string,
    applicationId: string,
    channelId: string,
    messageId: string,
    revision: number,
  ): Promise<boolean> {
    const app = this.#app(guildId, applicationId);
    if (app === undefined || app.deletedAt !== null) return false;
    this.#save({
      ...app,
      cardChannelId: channelId,
      cardMessageId: messageId,
      cardRevision: Math.max(app.cardRevision, revision),
    });
    return true;
  }

  async queueCardRemoval(
    guildId: string,
    applicationId: string,
    channelId: string,
    messageId: string,
  ): Promise<void> {
    const app = this.#app(guildId, applicationId);
    if (app === undefined) return;

    const at = this.#at();
    const removal: EffectPlan = {
      key: `${DELETE_CARD_KEY}:${messageId}`,
      kind: 'delete_card',
      trigger: 'card',
      params: { channelId, messageId },
    };
    if (this.#effects(app, [removal], at).length > 0) this.#wake(guildId, at);
  }

  async rememberDm(guildId: string, applicationId: string, channelId: string): Promise<void> {
    const app = this.#app(guildId, applicationId);
    if (app !== undefined) this.#save({ ...app, dmChannelId: channelId });
  }

  async recordRoleGrant(
    guildId: string,
    applicationId: string,
    userId: string,
    roleId: string,
  ): Promise<void> {
    if (this.#app(guildId, applicationId) === undefined) return;
    this.grantRows.set(`${applicationId}:${roleId}`, {
      guildId,
      applicationId,
      userId,
      roleId,
      grantedAt: this.#at(),
      removedAt: null,
    });
  }

  async grantedRoles(guildId: string, applicationId: string): Promise<string[]> {
    return [...this.grantRows.values()]
      .filter(
        (row) =>
          row.guildId === guildId && row.applicationId === applicationId && row.removedAt === null,
      )
      .sort((a, b) => a.grantedAt - b.grantedAt || (a.roleId < b.roleId ? -1 : 1))
      .map((row) => row.roleId);
  }

  async markRoleRemoved(guildId: string, applicationId: string, roleId: string): Promise<void> {
    const row = this.grantRows.get(`${applicationId}:${roleId}`);
    if (row !== undefined && row.guildId === guildId && row.removedAt === null) {
      row.removedAt = this.#at();
    }
  }

  async rememberInterview(
    guildId: string,
    applicationId: string,
    ticketId: string,
    channelId: string | null,
  ): Promise<void> {
    const app = this.#app(guildId, applicationId);
    if (app !== undefined) {
      this.#save({ ...app, interviewTicketId: ticketId, interviewChannelId: channelId });
    }
  }

  async expireIdleDrafts(now: number, limit: number): Promise<number> {
    const idle = [...this.applicationsById.values()]
      .filter((app) => app.status === 'draft' && app.expiresAt !== null && app.expiresAt <= now)
      .sort((a, b) => (a.expiresAt ?? 0) - (b.expiresAt ?? 0))
      .slice(0, Math.max(0, Math.floor(limit)));
    for (const app of idle) this.#removeApplication(app.id);
    return idle.length;
  }

  async restartDrafts(
    guildId: string,
    formId: string,
    keepVersionId: string,
    actorId: string,
  ): Promise<number> {
    const actor: Actor = { id: actorId, source: 'system' };
    return this.#restart(guildId, formId, keepVersionId, actor, this.#at());
  }

  async purgeContent(now: number, limit: number): Promise<number> {
    const due = [...this.applicationsById.values()]
      .filter(
        (app) =>
          app.contentPurgedAt === null && app.contentPurgeAt !== null && app.contentPurgeAt <= now,
      )
      .sort((a, b) => (a.contentPurgeAt ?? 0) - (b.contentPurgeAt ?? 0))
      .slice(0, Math.max(0, Math.floor(limit)));

    const actor: Actor = { id: APPLICATIONS_ACTOR, source: 'system' };
    for (const row of due) {
      const application = this.#save({
        ...row,
        answers: null,
        draft: {},
        applicantName: null,
        decisionReason: null,
        contentPurgedAt: now,
        revision: row.revision + 1,
        updatedAt: now,
      });
      this.#scrubChildren(application.id);
      this.#event(`${application.id}:content_purged:${application.revision}`, application, {
        kind: 'content_purged',
        actor,
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
      this.#effects(application, [card], now);
      this.#wake(application.guildId, now);
    }
    return due.length;
  }

  async extendInfoDeadlines(guildId: string, minDueAt: number): Promise<number> {
    let extended = 0;
    for (const app of this.#guildApps(guildId)) {
      if (
        app.deletedAt !== null ||
        app.status !== 'needs_info' ||
        app.infoDueAt === null ||
        app.infoDueAt >= minDueAt
      ) {
        continue;
      }
      this.#save({ ...app, infoDueAt: minDueAt });
      extended += 1;
    }
    return extended;
  }

  async rescheduleRetention(guildId: string, retentionDays: number): Promise<number> {
    const days = Math.floor(retentionDays);
    let rescheduled = 0;
    for (const app of this.#guildApps(guildId)) {
      if (
        app.deletedAt !== null ||
        app.contentPurgedAt !== null ||
        !(FINAL_STATUSES as readonly string[]).includes(app.status)
      ) {
        continue;
      }
      const from = app.decidedAt ?? app.withdrawnAt ?? app.updatedAt;
      this.#save({ ...app, contentPurgeAt: from + days * DAY_MS });
      rescheduled += 1;
    }
    return rescheduled;
  }

  async deleteApplication(input: DeleteApplicationInput): Promise<DeleteApplicationResult> {
    const row = this.#app(input.guildId, input.applicationId);
    if (row === undefined) return { status: 'missing' };
    if (row.deletedAt !== null) return { status: 'deleted', application: copy(row) };

    const at = this.#at(input.now);
    const application = this.#deleteOne(row, input.actor, at, input.cleanup);
    this.#audit(input.guildId, input.audit, at);
    return { status: 'deleted', application };
  }

  async deleteApplicant(input: DeleteApplicantInput): Promise<{ deleted: number }> {
    const rows = this.#guildApps(input.guildId)
      .filter((app) => app.applicantId === input.applicantId && app.deletedAt === null)
      .sort((a, b) => (a.id < b.id ? -1 : 1));
    const at = this.#at(input.now);
    for (const row of rows) this.#deleteOne(row, input.actor, at, input.cleanup);
    this.#audit(input.guildId, input.audit, at);
    return { deleted: rows.length };
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
    const rows = this.#queue(guildId, query.formIds, query.viewerId)
      .filter((app) => query.formId === undefined || app.formId === query.formId)
      .filter((app) => inView(app, query.view, true))
      .filter((app) => query.from === undefined || (app.submittedAt ?? 0) >= query.from)
      .filter(
        (app) =>
          query.to === undefined || (app.submittedAt ?? Number.POSITIVE_INFINITY) <= query.to,
      )
      .sort(byThenId((app) => app.submittedAt, 1));

    return { rows: rows.slice(0, take).map(copy), truncated: rows.length > take };
  }

  effectsOf(applicationId: string): EffectRecord[] {
    return [...this.effectsById.values()]
      .filter((effect) => effect.applicationId === applicationId)
      .map(copy);
  }

  eventsOf(applicationId: string): EventRecord[] {
    return this.eventRows
      .filter((row) => row.applicationId === applicationId)
      .map(({ guildId: _guild, applicationId: _application, ...event }) => copy(event));
  }

  seedVersion(version: FormVersionRecord): FormVersionRecord {
    this.versionsById.set(version.id, jsonb(version));
    return copy(version);
  }

  seedApplication(application: ApplicationRecord): ApplicationRecord {
    return this.#save(application);
  }
}
