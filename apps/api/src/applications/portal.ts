import { type EventBus, memberContextFromGuildMember, type ProviderRegistry } from '@proton/core';
import type { ServerFacts } from '@proton/core/placeholders';
import {
  type FormConfig,
  formFor,
  questionsOf,
  type Requirements,
} from '@proton/module-applications/config';
import { planEffects } from '@proton/module-applications/effects';
import { type Eligibility, evaluateEligibility } from '@proton/module-applications/eligibility';
import { intakeSentence, intakeState, whoCanRead } from '@proton/module-applications/intake';
import { checkAnswers, type DraftAnswers } from '@proton/module-applications/questions';
import { ACTIVE_STATUSES, isActive, nextStatus } from '@proton/module-applications/status';
import type {
  ApplicationRecord,
  ApplicationStore,
  FormVersionRecord,
  SubmitResult,
} from '@proton/module-applications/store';
import { stableStringify } from '@proton/module-applications/version';
import type {
  DraftSaveBody,
  DraftSaveResult,
  MyApplications,
  PortalApplication,
  PortalDiscardResult,
  PortalForm,
  PortalGuild,
  PortalRespondBody,
  PortalSubmitBody,
  PortalSubmitResult,
  PortalWithdrawBody,
} from '@proton/module-applications/view';
import {
  applicantThread,
  canRespond,
  canWithdraw,
  DAY_MS,
  STATUS_LABELS,
} from '@proton/module-applications/web';
import { ApplicationsError } from './errors.ts';
import type { GuildRoster, MemberAccess, MemberAccessRead } from './member-access.ts';
import {
  APPLICATION_ID,
  assertGuildId,
  displayNameOf,
  eligibilityDeps,
  guildIconUrl,
  HOUR_MS,
  type LoadedConfig,
  loadConfig,
  type ModulesPort,
  requestWork,
} from './shared.ts';

export const RESUBMIT_WINDOW_MS = 10 * 60_000;

const KEEPABLE: ReadonlySet<string> = new Set([
  'closed',
  'not_yet_open',
  'deadline_passed',
  'full',
]);

const OFF_SAVE = 'Applications is off in this server right now, so your answers weren’t saved.';
const OFF_SUBMIT =
  'Applications is off in this server right now, so your application wasn’t sent. Your answers ' +
  'are saved.';
const OFF_CHANGE = 'Applications is off in this server right now, so nothing was changed.';
const NOT_MEMBER = 'You need to be a member of this server to apply to its forms.';
const MEMBERSHIP_UNKNOWN =
  'Proton couldn’t check that you’re in this server just now. Try again in a moment.';
const FORM_UNAVAILABLE = 'This form isn’t available. It may not be open yet, or it was removed.';
const FORM_RETIRED = 'This form is no longer taking applications.';
const APPLICATION_MISSING = 'Proton can’t find that application.';
const GONE =
  'These answers were already sent or cleared, maybe on another device. Reload the page to see ' +
  'where your application stands.';
const VERSION_GONE =
  'Proton can’t find the version of this form your answers belong to. Start again to apply.';
const NOT_WAITING = 'Staff aren’t waiting for an answer on this application any more.';
const START_FAILED = 'Proton couldn’t start your application just now. Try again in a moment.';
const FORM_UPDATED = 'This form was updated. Reload the page to see the new questions.';

const PLAIN_DATE = new Intl.DateTimeFormat('en-GB', {
  dateStyle: 'long',
  timeStyle: 'short',
  timeZone: 'UTC',
});

function plainDate(ms: number): string {
  return `${PLAIN_DATE.format(ms)} UTC`;
}

type Member = Extract<MemberAccessRead, { state: 'member' }>;

type Started =
  | { ok: true; status: 'started' | 'existing'; application: ApplicationRecord }
  | { ok: false; message: string };

export interface PortalServiceOptions {
  store: ApplicationStore;
  modules: ModulesPort;
  members: Pick<MemberAccess, 'read' | 'roles'>;
  providers: ProviderRegistry;
  bus?: EventBus;
  logger?: Pick<Console, 'error' | 'warn'>;
  now?(): number;
}

function refused(message: string): { status: 'refused'; message: string } {
  return { status: 'refused', message };
}

function knownAnswers(
  snapshot: FormVersionRecord['snapshot'],
  answers: DraftAnswers,
): DraftAnswers {
  const known = new Set(questionsOf(snapshot).map((question) => question.id));
  return Object.fromEntries(Object.entries(answers).filter(([id]) => known.has(id)));
}

function sameAnswers(a: DraftAnswers, b: DraftAnswers): boolean {
  return stableStringify(a) === stableStringify(b);
}

function saved(application: ApplicationRecord): DraftSaveResult {
  return { status: 'saved', revision: application.revision, savedAt: application.updatedAt };
}

function conflict(application: ApplicationRecord): DraftSaveResult {
  return {
    status: 'conflict',
    draft: {
      revision: application.revision,
      answers: application.draft,
      updatedAt: application.updatedAt,
    },
  };
}

function eligibilityRefusal(eligibility: Eligibility, name: string, tail: string): string {
  return eligibility.state === 'ineligible'
    ? `You don’t meet every requirement for ${name}, so ${tail} The form page lists what’s needed.`
    : `Proton couldn’t check every requirement for ${name} just now, so ${tail} Try again in a ` +
        'moment.';
}

function cooldownUntil(rows: readonly ApplicationRecord[], days: number): number | null {
  if (days <= 0) return null;

  let last: number | null = null;
  for (const row of rows) {
    if (row.number === null) continue;
    for (const at of [row.decidedAt, row.withdrawnAt, row.submittedAt]) {
      if (at !== null && (last === null || at > last)) last = at;
    }
  }
  return last === null ? null : last + days * DAY_MS;
}

export class PortalService {
  readonly #store: ApplicationStore;
  readonly #modules: ModulesPort;
  readonly #members: Pick<MemberAccess, 'read' | 'roles'>;
  readonly #providers: ProviderRegistry;
  readonly #bus: EventBus | undefined;
  readonly #logger: Pick<Console, 'error' | 'warn'>;
  readonly #now: () => number;

  constructor(options: PortalServiceOptions) {
    this.#store = options.store;
    this.#modules = options.modules;
    this.#members = options.members;
    this.#providers = options.providers;
    this.#bus = options.bus;
    this.#logger = options.logger ?? console;
    this.#now = options.now ?? Date.now;
  }

  async mine(applicantId: string): Promise<MyApplications> {
    const rows = await this.#store.mine(null, applicantId);
    return { items: await this.#items(rows) };
  }

  async guildForms(guildId: string, userId: string): Promise<PortalGuild> {
    assertGuildId(guildId);
    const [loaded, member] = await Promise.all([
      this.#config(guildId),
      this.#members.read(guildId, userId),
    ]);
    this.#requireMember(member);

    const [roster, latest, counts, rows] = await Promise.all([
      this.#members.roles(guildId),
      this.#store.latestVersions(guildId),
      this.#store.counts(guildId),
      this.#store.mine(guildId, userId),
    ]);
    const now = this.#now();
    const server = this.#server(guildId, roster);

    const forms = (loaded?.config.forms ?? []).flatMap((form) => {
      const version = latest.get(form.id);
      if (form.archived || version === undefined || loaded === null) return [];

      const intake = intakeState({
        moduleOn: loaded.on,
        form,
        published: true,
        submittedCount: counts.get(form.id)?.submittedForCap,
        now,
      });
      const draft = rows.find((row) => row.formId === form.id && row.status === 'draft');

      return [
        {
          id: form.id,
          name: version.snapshot.name,
          description: version.snapshot.description,
          ...(version.snapshot.emoji === undefined ? {} : { emoji: version.snapshot.emoji }),
          intake,
          intakeSentence: intakeSentence(intake, form, { field: 'plain_text', server, now }),
          draft: draft === undefined ? null : { id: draft.id, updatedAt: draft.updatedAt },
        },
      ];
    });

    return {
      guild: this.#guildRef(guildId, roster),
      moduleOn: loaded?.on ?? false,
      forms,
      applications: await this.#items(rows),
    };
  }

  async form(guildId: string, formId: string, userId: string): Promise<PortalForm> {
    assertGuildId(guildId);
    const loaded = await this.#config(guildId);
    const form = loaded === null ? undefined : formFor(loaded.config, formId);
    if (loaded === null || form === undefined) {
      throw new ApplicationsError('not_found', FORM_UNAVAILABLE);
    }

    const [latestVersions, counts, rows, member] = await Promise.all([
      this.#store.latestVersions(guildId),
      this.#store.counts(guildId),
      this.#store.mine(guildId, userId),
      this.#members.read(guildId, userId),
    ]);
    const present = this.#requireMember(member);

    const latest = latestVersions.get(formId);
    if (latest === undefined) throw new ApplicationsError('not_found', FORM_UNAVAILABLE);

    const draft = rows.find((row) => row.formId === formId && row.status === 'draft') ?? null;
    const pinned =
      draft === null || draft.versionId === latest.id
        ? latest
        : ((await this.#store.version(guildId, draft.versionId)) ?? latest);

    const now = this.#now();
    const roster = await this.#members.roles(guildId);
    const intake = intakeState({
      moduleOn: loaded.on,
      form,
      published: true,
      submittedCount: counts.get(formId)?.submittedForCap,
      now,
    });

    return {
      guild: this.#guildRef(guildId, roster),
      form: { ...pinned.snapshot, id: form.id },
      versionId: pinned.id,
      intake,
      intakeSentence: intakeSentence(intake, form, {
        field: 'plain_text',
        server: this.#server(guildId, roster),
        now,
      }),
      whoCanRead: whoCanRead(loaded.config, form, loaded.config.retentionDays),
      eligibility: await this.#eligibility(guildId, loaded, present, pinned.snapshot.requirements),
      draft:
        draft === null
          ? null
          : {
              id: draft.id,
              revision: draft.revision,
              answers: draft.draft,
              updatedAt: draft.updatedAt,
              versionId: draft.versionId,
              stale: draft.versionId !== latest.id,
            },
      active: rows
        .filter((row) => row.formId === formId && isActive(row.status))
        .map((row) => ({ id: row.id, number: row.number, status: row.status })),
    };
  }

  async saveDraft(guildId: string, formId: string, body: DraftSaveBody): Promise<DraftSaveResult> {
    assertGuildId(guildId);
    const loaded = await this.#config(guildId);
    if (loaded === null || !loaded.on) return refused(OFF_SAVE);

    const form = formFor(loaded.config, formId);
    if (form === undefined || form.archived) return refused(FORM_RETIRED);

    const now = this.#now();
    const expiresAt = now + loaded.config.draftExpiryDays * DAY_MS;
    let draft = await this.#store.draftFor(guildId, formId, body.userId);
    let expected = body.expectedRevision;

    if (draft === null) {
      if (body.expectedRevision !== null) return refused(GONE);

      const started = await this.#start(
        guildId,
        loaded,
        form,
        body.userId,
        now,
        expiresAt,
        body.versionId,
      );
      if (!started.ok) return refused(started.message);

      draft = started.application;
      if (started.status === 'existing') {
        const answers = await this.#known(guildId, draft, body.answers);
        if (answers === null) return refused(VERSION_GONE);
        return sameAnswers(draft.draft, answers) ? saved(draft) : conflict(draft);
      }
      expected = draft.revision;
    }

    const answers = await this.#known(guildId, draft, body.answers);
    if (answers === null) return refused(VERSION_GONE);

    if (expected === null) {
      return sameAnswers(draft.draft, answers) ? saved(draft) : conflict(draft);
    }

    const result = await this.#store.saveDraft({
      guildId,
      applicationId: draft.id,
      applicantId: body.userId,
      expectedRevision: expected,
      answers,
      mode: 'replace',
      expiresAt,
      now,
    });

    switch (result.status) {
      case 'saved':
        return saved(result.application);
      case 'conflict':
        return sameAnswers(result.application.draft, answers)
          ? saved(result.application)
          : conflict(result.application);
      case 'gone':
        return refused(GONE);
    }
  }

  async submit(
    guildId: string,
    formId: string,
    body: PortalSubmitBody,
  ): Promise<PortalSubmitResult> {
    assertGuildId(guildId);
    const loaded = await this.#config(guildId);
    if (loaded === null || !loaded.on) return refused(OFF_SUBMIT);

    const form = formFor(loaded.config, formId);
    if (form === undefined) return refused(FORM_UNAVAILABLE);

    const now = this.#now();
    const draft = await this.#store.draftFor(guildId, formId, body.userId);
    if (draft === null) return this.#resubmitted(guildId, formId, body.userId, now);

    const version = await this.#store.version(guildId, draft.versionId);
    if (version === null) return refused(VERSION_GONE);
    if (body.expectedRevision !== draft.revision) {
      return { status: 'conflict', revision: draft.revision };
    }

    const intake = intakeState({ moduleOn: loaded.on, form, published: true, now });
    if (intake.state === 'closed') {
      const sentence = intakeSentence(intake, form, { field: 'plain_text', now });
      return refused(
        KEEPABLE.has(intake.reason)
          ? `${sentence} Your answers are saved, so you can send them once it opens again.`
          : sentence,
      );
    }

    const member = await this.#members.read(guildId, body.userId);
    if (member.state === 'absent') return refused(NOT_MEMBER);
    if (member.state === 'unavailable') {
      return refused(`${MEMBERSHIP_UNKNOWN} Your answers are saved.`);
    }

    const name = version.snapshot.name;
    const eligibility = await this.#eligibility(
      guildId,
      loaded,
      member,
      version.snapshot.requirements,
    );
    if (eligibility.state !== 'eligible') {
      return refused(
        eligibilityRefusal(
          eligibility,
          name,
          'your application wasn’t sent. Your answers are saved.',
        ),
      );
    }

    const checked = checkAnswers(version.snapshot.sections, draft.draft, { partial: false });
    if (!checked.ok) return { status: 'invalid', problems: checked.problems };

    const hours = loaded.config.reviewReminderHours;
    const result = await this.#store.submit({
      guildId,
      applicationId: draft.id,
      applicantId: body.userId,
      expectedRevision: draft.revision,
      answers: checked.answers,
      source: 'web',
      applicantName: displayNameOf(member.raw),
      limits: {
        cap: form.intake.cap,
        cooldownDays: form.intake.cooldownDays,
        maxActive: form.intake.maxActive,
      },
      reviewDueAt: hours > 0 ? now + hours * HOUR_MS : null,
      plan: (submitted, revision) =>
        planEffects('applications.submitted', {
          config: loaded.config,
          form,
          application: submitted,
          revision,
          now,
          actorId: body.userId,
        }),
      lifecycle: {
        guildId,
        applicationId: draft.id,
        formId: form.id,
        formName: form.name,
        versionId: draft.versionId,
        applicantId: body.userId,
        actorId: body.userId,
      },
      now,
    });

    if (result.status === 'refused') {
      return this.#submitRefusal(guildId, formId, body, result, name);
    }

    await requestWork(this.#bus, this.#logger, now, {
      guildId,
      applicationId: result.application.id,
      reason: 'submission',
      key: `${result.application.id}:submit:${body.requestId}`,
    });

    return {
      status: 'submitted',
      applicationId: result.application.id,
      number: result.application.number ?? 0,
    };
  }

  async discard(
    guildId: string,
    formId: string,
    body: PortalWithdrawBody,
  ): Promise<PortalDiscardResult> {
    assertGuildId(guildId);
    const draft = await this.#store.draftFor(guildId, formId, body.userId);
    if (draft === null) return { discarded: false };

    return { discarded: await this.#store.discardDraft(guildId, draft.id, body.userId) };
  }

  async application(
    guildId: string,
    applicationId: string,
    userId: string,
  ): Promise<PortalApplication> {
    assertGuildId(guildId);
    const application = await this.#own(guildId, applicationId, userId);

    const [record, version, loaded] = await Promise.all([
      this.#store.detail(guildId, application.id),
      this.#store.version(guildId, application.versionId),
      this.#config(guildId),
    ]);
    const current = record?.application ?? application;
    const formName =
      version?.snapshot.name ??
      (loaded === null ? undefined : formFor(loaded.config, current.formId)?.name) ??
      current.formId;

    return {
      id: current.id,
      number: current.number,
      guildId,
      formId: current.formId,
      formName,
      status: current.status,
      statusLabel: STATUS_LABELS[current.status],
      submittedAt: current.submittedAt,
      decidedAt: current.decidedAt,
      decisionReason: current.decisionReason,
      answers: current.answers,
      thread: applicantThread(record?.thread ?? []).flatMap((entry) =>
        entry.kind === 'reopened'
          ? []
          : [
              {
                id: entry.id,
                kind: entry.kind,
                authorId: entry.kind === 'info_response' ? userId : 'staff',
                body: entry.body,
                createdAt: entry.createdAt,
              },
            ],
      ),
      canWithdraw: canWithdraw(current.status),
      canRespond: canRespond(current.status),
      confirmation: version?.snapshot.confirmation ?? '',
    };
  }

  async withdraw(
    guildId: string,
    applicationId: string,
    body: PortalWithdrawBody,
  ): Promise<PortalApplication> {
    assertGuildId(guildId);
    const loaded = await this.#config(guildId);
    if (loaded === null || !loaded.on) throw new ApplicationsError('module_disabled', OFF_CHANGE);

    const application = await this.#own(guildId, applicationId, body.userId);
    if (application.status === 'withdrawn') {
      return this.application(guildId, application.id, body.userId);
    }
    if (!canWithdraw(application.status)) {
      throw new ApplicationsError(
        'stale',
        `This application is ${STATUS_LABELS[application.status].toLowerCase()}, so it can’t be ` +
          'withdrawn.',
      );
    }

    const form = formFor(loaded.config, application.formId);
    const now = this.#now();

    const result = await this.#store.transition({
      guildId,
      applicationId: application.id,
      action: 'withdraw',
      actor: { id: body.userId, source: 'web' },
      expect: { statuses: ACTIVE_STATUSES },
      patch: {
        status: 'withdrawn',
        withdrawnAt: now,
        contentPurgeAt: now + loaded.config.retentionDays * DAY_MS,
      },
      event: {
        kind: 'withdrawn',
        id: `${application.id}:withdrawn:web:${body.requestId}`,
        lifecycle: 'applications.withdrawn',
      },
      plan:
        form === undefined
          ? undefined
          : (withdrawn, revision) =>
              planEffects('applications.withdrawn', {
                config: loaded.config,
                form,
                application: withdrawn,
                revision,
                now,
                actorId: body.userId,
              }),
      now,
    });

    if (result.status === 'stale') {
      const current = result.application;
      if (current !== null && current.status === 'withdrawn') {
        return this.application(guildId, current.id, body.userId);
      }
      const label = current === null ? 'gone' : STATUS_LABELS[current.status].toLowerCase();
      throw new ApplicationsError(
        'stale',
        `This application is ${label}, so it can’t be withdrawn.`,
      );
    }

    if (result.effects.length > 0) {
      await requestWork(this.#bus, this.#logger, now, {
        guildId,
        applicationId: application.id,
        reason: 'decision',
        key: `${application.id}:withdraw:${body.requestId}`,
      });
    }

    return this.application(guildId, application.id, body.userId);
  }

  async respond(
    guildId: string,
    applicationId: string,
    body: PortalRespondBody,
  ): Promise<PortalApplication> {
    assertGuildId(guildId);
    const loaded = await this.#config(guildId);
    if (loaded === null || !loaded.on) throw new ApplicationsError('module_disabled', OFF_CHANGE);

    let current = await this.#own(guildId, applicationId, body.userId);
    const eventId = `${current.id}:information_provided:web:${body.requestId}`;

    if (!canRespond(current.status)) {
      const record = await this.#store.detail(guildId, current.id);
      if (record?.thread.some((entry) => entry.id === `${eventId}:thread`)) {
        return this.application(guildId, current.id, body.userId);
      }
      throw new ApplicationsError('stale', NOT_WAITING);
    }

    const form = formFor(loaded.config, current.formId);
    const now = this.#now();
    const hours = loaded.config.reviewReminderHours;

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const assigneeId = current.assigneeId;
      const status = nextStatus('respond', 'needs_info', assigneeId !== null) ?? 'submitted';

      const result = await this.#store.transition({
        guildId,
        applicationId: current.id,
        action: 'respond',
        actor: { id: body.userId, source: 'web' },
        expect: { statuses: ['needs_info'], assigneeId },
        patch: {
          status,
          infoDueAt: null,
          reviewDueAt: hours > 0 ? now + hours * HOUR_MS : null,
          remindedAt: null,
        },
        thread: { kind: 'info_response', body: body.message },
        event: {
          kind: 'information_provided',
          id: eventId,
          lifecycle: 'applications.information_provided',
          data: { length: body.message.length },
        },
        plan:
          form === undefined
            ? undefined
            : (answered, revision) =>
                planEffects('applications.information_provided', {
                  config: loaded.config,
                  form,
                  application: answered,
                  revision,
                  now,
                  actorId: body.userId,
                }),
        now,
      });

      if (result.status === 'done') {
        if (result.effects.length > 0) {
          await requestWork(this.#bus, this.#logger, now, {
            guildId,
            applicationId: current.id,
            reason: 'decision',
            key: `${current.id}:respond:${body.requestId}`,
          });
        }
        return this.application(guildId, current.id, body.userId);
      }

      if (result.application === null) {
        throw new ApplicationsError('not_found', APPLICATION_MISSING);
      }
      current = result.application;
      if (current.status !== 'needs_info') break;
    }

    throw new ApplicationsError('stale', `${NOT_WAITING} Your answer wasn’t sent.`);
  }

  async #config(guildId: string): Promise<LoadedConfig | null> {
    try {
      return await loadConfig(this.#modules, guildId);
    } catch {
      return null;
    }
  }

  #requireMember(member: MemberAccessRead): Member {
    if (member.state === 'absent') throw new ApplicationsError('not_member', NOT_MEMBER);
    if (member.state === 'unavailable') {
      throw new ApplicationsError('unavailable', MEMBERSHIP_UNKNOWN);
    }
    return member;
  }

  async #own(guildId: string, applicationId: string, userId: string): Promise<ApplicationRecord> {
    if (!APPLICATION_ID.test(applicationId)) {
      throw new ApplicationsError('not_found', APPLICATION_MISSING);
    }

    const application = await this.#store.get(guildId, applicationId);
    if (
      application === null ||
      application.deletedAt !== null ||
      application.applicantId !== userId ||
      application.number === null
    ) {
      throw new ApplicationsError('not_found', APPLICATION_MISSING);
    }
    return application;
  }

  #server(guildId: string, roster: GuildRoster | null): ServerFacts {
    return {
      id: guildId,
      ...(roster?.name ? { name: roster.name } : {}),
      ...(roster === null ? {} : { ownerId: roster.ownerId, iconHash: roster.iconHash }),
    };
  }

  #guildRef(guildId: string, roster: GuildRoster | null): PortalForm['guild'] {
    return {
      id: guildId,
      name: roster?.name ?? 'Discord server',
      iconUrl: guildIconUrl(guildId, roster?.iconHash ?? null),
    };
  }

  async #eligibility(
    guildId: string,
    loaded: LoadedConfig,
    member: Member,
    requirements: Requirements,
  ): Promise<Eligibility> {
    const context = memberContextFromGuildMember(
      guildId,
      member.raw,
      new Date(this.#now()),
      loaded.tier,
    );
    const deps = eligibilityDeps(this.#providers, () => this.#modules.moduleStates(guildId));
    return evaluateEligibility(deps, context, requirements);
  }

  async #known(
    guildId: string,
    draft: ApplicationRecord,
    answers: DraftAnswers,
  ): Promise<DraftAnswers | null> {
    const version = await this.#store.version(guildId, draft.versionId);
    return version === null ? null : knownAnswers(version.snapshot, answers);
  }

  async #start(
    guildId: string,
    loaded: LoadedConfig,
    form: FormConfig,
    userId: string,
    now: number,
    expiresAt: number,
    shownVersionId?: string,
  ): Promise<Started> {
    const [latestVersions, counts, rows] = await Promise.all([
      this.#store.latestVersions(guildId),
      this.#store.counts(guildId),
      this.#store.mine(guildId, userId),
    ]);

    const latest = latestVersions.get(form.id);
    if (latest === undefined) return { ok: false, message: FORM_UNAVAILABLE };
    if (shownVersionId !== undefined && shownVersionId !== latest.id) {
      return { ok: false, message: FORM_UPDATED };
    }
    const name = latest.snapshot.name;

    const intake = intakeState({
      moduleOn: loaded.on,
      form,
      published: true,
      submittedCount: counts.get(form.id)?.submittedForCap,
      now,
    });
    if (intake.state === 'closed') {
      return {
        ok: false,
        message: `${intakeSentence(intake, form, { field: 'plain_text', now })} Your answers weren’t saved.`,
      };
    }

    const own = rows.filter((row) => row.formId === form.id);
    if (own.filter((row) => isActive(row.status)).length >= form.intake.maxActive) {
      return {
        ok: false,
        message:
          `You already have an application for ${name} waiting for a decision. You can apply ` +
          'again once it’s decided or withdrawn.',
      };
    }

    const retryAt = cooldownUntil(own, form.intake.cooldownDays);
    if (retryAt !== null && retryAt > now) {
      return {
        ok: false,
        message: `You applied to ${name} recently. You can apply again on ${plainDate(retryAt)}.`,
      };
    }

    const member = await this.#members.read(guildId, userId);
    if (member.state === 'absent') return { ok: false, message: NOT_MEMBER };
    if (member.state === 'unavailable') {
      return { ok: false, message: `${MEMBERSHIP_UNKNOWN} Your answers weren’t saved.` };
    }

    const eligibility = await this.#eligibility(
      guildId,
      loaded,
      member,
      latest.snapshot.requirements,
    );
    if (eligibility.state !== 'eligible') {
      return {
        ok: false,
        message: eligibilityRefusal(eligibility, name, 'your answers weren’t saved.'),
      };
    }

    try {
      const started = await this.#store.startDraft({
        guildId,
        formId: form.id,
        versionId: latest.id,
        applicantId: userId,
        applicantName: displayNameOf(member.raw),
        expiresAt,
        source: 'web',
        now,
      });
      return { ok: true, ...started };
    } catch (error) {
      this.#logger.error(
        `applications could not start a web draft for form ${form.id} in guild ${guildId}: ${
          error instanceof Error ? error.name : 'unknown error'
        }`,
      );
      return { ok: false, message: START_FAILED };
    }
  }

  async #resubmitted(
    guildId: string,
    formId: string,
    userId: string,
    now: number,
  ): Promise<PortalSubmitResult> {
    const rows = await this.#store.mine(guildId, userId);
    const recent = rows.find(
      (row) =>
        row.formId === formId &&
        row.number !== null &&
        row.source === 'web' &&
        row.submittedAt !== null &&
        now - row.submittedAt < RESUBMIT_WINDOW_MS,
    );

    return recent === undefined || recent.number === null
      ? refused(GONE)
      : { status: 'submitted', applicationId: recent.id, number: recent.number };
  }

  async #submitRefusal(
    guildId: string,
    formId: string,
    body: PortalSubmitBody,
    result: Extract<SubmitResult, { status: 'refused' }>,
    name: string,
  ): Promise<PortalSubmitResult> {
    switch (result.code) {
      case 'cap':
        return refused(
          `${name} has all the applications it can take right now, so yours wasn’t sent. Your ` +
            'answers are saved.',
        );
      case 'cooldown':
        return refused(
          `You applied to ${name} recently, so you can send this application ${
            result.retryAt === undefined ? 'later' : `on ${plainDate(result.retryAt)}`
          }. Your answers are saved.`,
        );
      case 'active':
        return refused(
          `You already have an application for ${name} waiting for a decision, so this one ` +
            'wasn’t sent. You can apply again once it’s decided or withdrawn. Your answers are saved.',
        );
      case 'conflict': {
        const fresh = await this.#store.draftFor(guildId, formId, body.userId);
        return fresh === null ? refused(GONE) : { status: 'conflict', revision: fresh.revision };
      }
      case 'not_draft': {
        if (result.existingId !== undefined) {
          const sent = await this.#store.get(guildId, result.existingId);
          if (sent !== null && sent.applicantId === body.userId && sent.number !== null) {
            return { status: 'submitted', applicationId: sent.id, number: sent.number };
          }
        }
        return refused(GONE);
      }
    }
  }

  async #items(rows: readonly ApplicationRecord[]): Promise<MyApplications['items']> {
    const shown = rows.filter(
      (row) => row.deletedAt === null && (row.number !== null || row.status === 'draft'),
    );

    const names = new Map<string, string>();
    for (const row of shown) {
      const key = `${row.guildId}:${row.versionId}`;
      if (names.has(key)) continue;
      const version = await this.#store.version(row.guildId, row.versionId);
      names.set(key, version?.snapshot.name ?? row.formId);
    }

    return shown.map((row) => ({
      id: row.id,
      number: row.number,
      guildId: row.guildId,
      formId: row.formId,
      formName: names.get(`${row.guildId}:${row.versionId}`) ?? row.formId,
      status: row.status,
      statusLabel: STATUS_LABELS[row.status],
      submittedAt: row.submittedAt,
      updatedAt: row.updatedAt,
    }));
  }
}
