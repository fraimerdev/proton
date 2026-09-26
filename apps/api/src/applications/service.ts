import {
  type ApplicationLifecycleEvent,
  type ApplicationWorkReason,
  caseQuerySchema,
  channelAudience,
  type EventBus,
  hasWithAdmin,
  memberContextFromGuildMember,
  newId,
  Permissions,
  type ProviderRegistry,
  snowflakeSchema,
} from '@proton/core';
import {
  authorizeAction,
  CAPABILITIES,
  type Capability,
  capabilitiesFor,
  isAdmin,
  type ReviewActor,
  twoReviewerCheck,
  viewableFormIds,
} from '@proton/module-applications/authorize';
import {
  type ApplicationsConfig,
  type FormConfig,
  formFor,
  questionsOf,
  type Requirements,
  reviewChannelFor,
  teamFor,
} from '@proton/module-applications/config';
import { EXPORT_ROWS_MAX } from '@proton/module-applications/constants';
import { planCard, planEffects, planTicket } from '@proton/module-applications/effects';
import {
  CASE_TYPES_COUNTED,
  evaluateEligibility,
  type RequirementIssue,
  requirementIssues,
} from '@proton/module-applications/eligibility';
import { intakeState } from '@proton/module-applications/intake';
import {
  allowedFrom,
  isActive,
  lifecycleEventFor,
  nextStatus,
} from '@proton/module-applications/status';
import type {
  ApplicationRecord,
  ApplicationStore,
  AuditInput,
  EffectRecord,
  FormVersionRecord,
  PlanEffects,
  TransitionInput,
  TransitionResult,
  VoteRecord,
  VoteTally,
} from '@proton/module-applications/store';
import { publishIssues, sameSnapshot, snapshotOf } from '@proton/module-applications/version';
import {
  type ApplicationDetail,
  type Audience,
  type DeleteApplicantBody,
  type DeleteApplicantResult,
  EFFECT_LABELS,
  EFFECT_PROBLEM_LABELS,
  type EffectProblem,
  type EligibilityPreview,
  type ExportQuery,
  type FormOverview,
  type PublishBody,
  type PublishResult,
  type QueueItem,
  type QueueQuery,
  type QueueResult,
  type QueueSummary,
  type ReviewMembers,
  type StaffActionBody,
  type StaffActionResult,
  type VersionList,
  type VersionView,
} from '@proton/module-applications/view';
import { DAY_MS, referenceOf, STATUS_LABELS } from '@proton/module-applications/web';
import type { CaseQueryService } from '../cases/service.ts';
import type { AuditWrite } from '../leveling/xp-events.ts';
import { ApplicationsError } from './errors.ts';
import { type ExportFile, exportColumns, exportFile } from './export.ts';
import type { InterviewLookup, InterviewStatus } from './interviews.ts';
import type { MemberAccess } from './member-access.ts';
import {
  APPLICATION_ID,
  type AuditLookup,
  assertGuildId,
  avatarUrlOf,
  displayNameOf,
  eligibilityDeps,
  HOUR_MS,
  isBot,
  type LoadedConfig,
  loadConfig,
  type ModulesPort,
  modulesOn,
  orphanForm,
  requestWork,
  usernameOf,
} from './shared.ts';

export const MEMBER_NAMES_MAX = 50;
const MEMBER_CONCURRENCY = 6;
const MODERATION_RECENT = 5;
const MODERATION_SCAN = 200;

const MODULE_OFF =
  'Applications is off in this server, so nothing was changed. Turn it on to review again.';
const NOT_MEMBER =
  'Discord says you aren’t a member of this server, so Proton can’t show or change its applications.';
const ROLES_UNREADABLE =
  'Proton couldn’t check your roles in this server just now, so nothing was shown or changed. ' +
  'Try again in a moment.';
const NO_TEAM = 'You aren’t on a review team for Applications in this server.';
const NOT_FOUND = 'Proton can’t find that application in this server.';
const NO_EXPORT =
  'Downloading applications needs one of the export roles in Applications settings.';
const NO_DELETE = 'Deleting applications needs one of the delete roles in Applications settings.';
const CARD_REMOVING = 'Proton is removing its review card from Discord now.';
const CARD_REMOVED_LATER =
  'Applications is off, so its review card is removed from Discord on Proton’s next check ' +
  'rather than straight away.';

function formMissing(formId: string): string {
  return (
    `Applications has no form with the ID '${formId}'. It may have been removed since this page ` +
    'was opened.'
  );
}

type Body<A extends StaffActionBody['action']> = Extract<StaffActionBody, { action: A }>;

interface Staff extends LoadedConfig {
  actor: ReviewActor;
}

interface Target {
  staff: Staff;
  application: ApplicationRecord;
  form: FormConfig | null;
  formName: string;
  capabilities: ReadonlySet<Capability>;
}

interface Acting {
  guildId: string;
  body: StaffActionBody;
  config: ApplicationsConfig;
  actor: ReviewActor;
  application: ApplicationRecord;
  form: FormConfig;
  capabilities: ReadonlySet<Capability>;
  now: number;
}

interface Step {
  action: TransitionInput['action'];
  kind: string;
  expect: TransitionInput['expect'];
  patch: TransitionInput['patch'];
  lifecycle?: ApplicationLifecycleEvent | null | undefined;
  data?: Record<string, unknown> | undefined;
  after?: Record<string, unknown> | undefined;
  thread?: TransitionInput['thread'];
  note?: TransitionInput['note'];
  vote?: TransitionInput['vote'];
  plan?: PlanEffects | undefined;
  bumpRevision?: boolean | undefined;
  clearVotes?: boolean | undefined;
  supersede?: boolean | undefined;
}

export interface ApplicationsServiceOptions {
  store: ApplicationStore;
  modules: ModulesPort;
  members: MemberAccess;
  providers: ProviderRegistry;
  audit: AuditWrite;
  audits: AuditLookup;
  cases?: Pick<CaseQueryService, 'search'>;
  interviews?: InterviewLookup;
  bus?: EventBus;
  logger?: Pick<Console, 'error' | 'warn'>;
  now?(): number;
}

export function auditIdOf(verb: string, guildId: string, requestId: string): string {
  return `applications.${verb}:${guildId}:${requestId}`;
}

function eventIdOf(applicationId: string, kind: string, requestId: string): string {
  return `${applicationId}:${kind}:dashboard:${requestId}`;
}

function blankToNull(value: string | undefined): string | null {
  return value === undefined || value === '' ? null : value;
}

function joinAnd(items: readonly string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
}

function decided(application: ApplicationRecord): boolean {
  return application.status === 'accepted' || application.status === 'rejected';
}

function alreadyReviewed(application: ApplicationRecord): string {
  return (
    'This application has already been reviewed. It was ' +
    `${STATUS_LABELS[application.status].toLowerCase()}.`
  );
}

function staleText(application: ApplicationRecord | null): string {
  if (application === null || application.deletedAt !== null) {
    return 'This application was deleted, so nothing was done.';
  }
  if (decided(application)) return alreadyReviewed(application);
  if (application.status === 'withdrawn') {
    return 'The applicant withdrew this application, so nothing was done.';
  }
  if (application.status === 'expired') return 'This application has expired, so nothing was done.';
  return (
    'This application changed while Proton was saving, so nothing was changed. Look at it again ' +
    'and retry.'
  );
}

function replayText(verb: StaffActionBody['action'], application: ApplicationRecord): string {
  const reference = referenceOf(application.number);
  if (verb === 'delete') return `Application ${reference} was already deleted.`;
  return (
    `That was already done. Application ${reference} is ` +
    `${STATUS_LABELS[application.status].toLowerCase()}.`
  );
}

function progressText(effects: readonly EffectRecord[]): string | null {
  const doing: string[] = [];
  if (effects.some((effect) => effect.kind === 'dm')) doing.push('DMing the applicant');
  if (effects.some((effect) => effect.kind === 'add_role' || effect.kind === 'remove_role')) {
    doing.push('updating their roles');
  }
  if (effects.some((effect) => effect.kind === 'xp')) doing.push('giving the XP reward');
  if (doing.length === 0) return null;
  return `Proton is ${joinAnd(doing)} now. Anything that fails shows on this page.`;
}

function problemsOf(effects: readonly EffectRecord[]): EffectProblem[] {
  return effects
    .filter((effect) => effect.status === 'failed')
    .map((effect) => ({
      effectId: effect.id,
      kind: effect.kind,
      label: EFFECT_PROBLEM_LABELS[effect.kind],
    }));
}

function tallyOf(votes: readonly Pick<VoteRecord, 'vote'>[]): VoteTally {
  const tally: VoteTally = { accept: 0, reject: 0 };
  for (const cast of votes) tally[cast.vote] += 1;
  return tally;
}

function itemOf(
  application: ApplicationRecord,
  formName: string,
  problems: readonly EffectRecord[],
  votes: VoteTally | undefined,
): QueueItem {
  return {
    id: application.id,
    number: application.number,
    formId: application.formId,
    formName,
    applicantId: application.applicantId,
    applicantName: application.applicantName,
    status: application.status,
    assigneeId: application.assigneeId,
    submittedAt: application.submittedAt,
    updatedAt: application.updatedAt,
    archived: application.archivedAt !== null,
    problems: problemsOf(problems),
    votes: votes ?? { accept: 0, reject: 0 },
  };
}

function nameOf(
  config: ApplicationsConfig,
  formId: string,
  latest: ReadonlyMap<string, FormVersionRecord>,
): string {
  return formFor(config, formId)?.name ?? latest.get(formId)?.snapshot.name ?? formId;
}

const DOWNGRADES: ReadonlySet<string> = new Set(['channel_not_private', 'audience_unknown']);

function downgradeOf(effect: { kind: string; result: Record<string, unknown> }): string | null {
  const downgraded = effect.result.downgraded;
  return effect.kind === 'card' && typeof downgraded === 'string' && DOWNGRADES.has(downgraded)
    ? downgraded
    : null;
}

const PUBLISHED_ONLY =
  'The published version still has this requirement, so members are checked against it until ' +
  'you publish.';

function liveRequirementIssues(
  saved: Requirements,
  published: Requirements | undefined,
  switches: Readonly<Record<string, boolean>>,
): RequirementIssue[] {
  const issues = requirementIssues(saved, switches);
  if (published === undefined) return issues;

  const seen = new Set(issues.map((issue) => issue.id));
  return [
    ...issues,
    ...requirementIssues(published, switches)
      .filter((issue) => !seen.has(issue.id))
      .map((issue) => ({ ...issue, humanReason: `${issue.humanReason} ${PUBLISHED_ONLY}` })),
  ];
}

function retiredIds(
  config: ApplicationsConfig,
  latest: ReadonlyMap<string, FormVersionRecord>,
): string[] {
  return [...latest.keys()].filter((formId) => formFor(config, formId) === undefined).sort();
}

function deleteCleanup(config: ApplicationsConfig): PlanEffects {
  return (application, revision) => {
    if (!isActive(application.status)) return [];
    const form = formFor(config, application.formId);
    if (form === undefined || !form.actions.removeSubmitRolesOnClose) return [];

    const roleIds = [...form.actions.onSubmit.addRoleIds];
    if (roleIds.length === 0) return [];

    return [
      {
        key: `delete:${revision}:cleanup`,
        kind: 'remove_role',
        trigger: 'delete',
        params: { fromGrants: true, roleIds, userId: application.applicantId },
      },
    ];
  };
}

function canSeeModeration(actor: ReviewActor): boolean {
  return (
    isAdmin(actor) ||
    hasWithAdmin(actor.permissions, Permissions.ModerateMembers) ||
    hasWithAdmin(actor.permissions, Permissions.KickMembers) ||
    hasWithAdmin(actor.permissions, Permissions.BanMembers)
  );
}

export class ApplicationsService {
  readonly #store: ApplicationStore;
  readonly #modules: ModulesPort;
  readonly #members: MemberAccess;
  readonly #providers: ProviderRegistry;
  readonly #audit: AuditWrite;
  readonly #audits: AuditLookup;
  readonly #cases: Pick<CaseQueryService, 'search'> | undefined;
  readonly #interviews: InterviewLookup | undefined;
  readonly #bus: EventBus | undefined;
  readonly #logger: Pick<Console, 'error' | 'warn'>;
  readonly #now: () => number;

  constructor(options: ApplicationsServiceOptions) {
    this.#store = options.store;
    this.#modules = options.modules;
    this.#members = options.members;
    this.#providers = options.providers;
    this.#audit = options.audit;
    this.#audits = options.audits;
    this.#cases = options.cases;
    this.#interviews = options.interviews;
    this.#bus = options.bus;
    this.#logger = options.logger ?? console;
    this.#now = options.now ?? Date.now;
  }

  async forms(guildId: string): Promise<FormOverview> {
    assertGuildId(guildId);
    const [{ config, on }, latest, counts, states] = await Promise.all([
      loadConfig(this.#modules, guildId),
      this.#store.latestVersions(guildId),
      this.#store.counts(guildId),
      this.#modules.moduleStates(guildId),
    ]);
    const now = this.#now();
    const switches = modulesOn(states);

    return {
      forms: config.forms.map((form) => {
        const published = latest.get(form.id) ?? null;
        const count = counts.get(form.id);

        return {
          id: form.id,
          name: form.name,
          ...(form.emoji === undefined ? {} : { emoji: form.emoji }),
          archived: form.archived,
          intake: intakeState({
            moduleOn: on,
            form,
            published: published !== null,
            submittedCount: count?.submittedForCap,
            now,
          }),
          published:
            published === null
              ? null
              : {
                  versionId: published.id,
                  version: published.version,
                  publishedAt: published.publishedAt,
                  publishedBy: published.publishedBy,
                },
          draftChanged: published === null || !sameSnapshot(snapshotOf(form), published.snapshot),
          publishIssues: publishIssues(form),
          requirementIssues: liveRequirementIssues(
            form.requirements,
            published?.snapshot.requirements,
            switches,
          ),
          counts: {
            awaiting: count?.awaiting ?? 0,
            needsInfo: count?.needsInfo ?? 0,
            drafts: count?.drafts ?? 0,
            total: count?.total ?? 0,
          },
        };
      }),
      retiredFormIds: retiredIds(config, latest),
    };
  }

  async publish(guildId: string, formId: string, body: PublishBody): Promise<PublishResult> {
    assertGuildId(guildId);
    const { config } = await loadConfig(this.#modules, guildId);

    const form = formFor(config, formId);
    if (form === undefined) throw new ApplicationsError('not_found', formMissing(formId));

    const issues = publishIssues(form);
    if (issues.length > 0) {
      throw new ApplicationsError(
        'unpublishable',
        `${form.name} can’t be published yet: ${issues.join(' ')}`,
      );
    }

    const now = this.#now();
    const latest = (await this.#store.latestVersions(guildId)).get(formId) ?? null;
    const snapshot = snapshotOf(form);

    const outcome = await this.#store.publish({
      guildId,
      formId,
      snapshot,
      draftPolicy: body.draftPolicy,
      publishedBy: body.actorId,
      audit: {
        actorId: body.actorId,
        source: 'dashboard',
        action: 'module.applications.publish',
        id: auditIdOf('publish', guildId, body.requestId),
        before: { formId, version: latest?.version ?? null },
        after: {
          formId,
          requestId: body.requestId,
          draftPolicy: body.draftPolicy,
          questions: questionsOf(snapshot).length,
        },
        ipHash: body.ipHash ?? null,
      },
      now,
    });

    if (outcome.status === 'published' || outcome.draftsExpired > 0) {
      await requestWork(this.#bus, this.#logger, now, {
        guildId,
        reason: outcome.draftsExpired > 0 ? 'draft' : 'publish',
        key: `publish:${body.requestId}`,
      });
    }

    return {
      status: outcome.status,
      version: outcome.version.version,
      versionId: outcome.version.id,
      draftsExpired: outcome.draftsExpired,
    };
  }

  async versions(guildId: string, formId: string): Promise<VersionList> {
    assertGuildId(guildId);
    const versions = await this.#store.versions(guildId, formId);

    return {
      versions: versions.map(
        ({ id, formId: form, version, draftPolicy, publishedBy, publishedAt }) => ({
          id,
          formId: form,
          version,
          draftPolicy,
          publishedBy,
          publishedAt,
        }),
      ),
    };
  }

  async version(guildId: string, formId: string, versionId: string): Promise<VersionView> {
    assertGuildId(guildId);
    const version = await this.#store.version(guildId, versionId);
    if (version === null || version.formId !== formId) {
      throw new ApplicationsError('not_found', 'Proton can’t find that version of this form.');
    }

    return {
      id: version.id,
      formId: version.formId,
      version: version.version,
      draftPolicy: version.draftPolicy,
      publishedBy: version.publishedBy,
      publishedAt: version.publishedAt,
      snapshot: version.snapshot,
    };
  }

  async eligibilityPreview(
    guildId: string,
    formId: string,
    userId: string,
  ): Promise<EligibilityPreview> {
    assertGuildId(guildId);
    const [{ config, tier }, member, latest] = await Promise.all([
      loadConfig(this.#modules, guildId),
      this.#members.read(guildId, userId),
      this.#store.latestVersions(guildId),
    ]);

    const form = formFor(config, formId);
    if (form === undefined) throw new ApplicationsError('not_found', formMissing(formId));

    if (member.state !== 'member') return { member: member.state, eligibility: null };

    const context = memberContextFromGuildMember(guildId, member.raw, new Date(this.#now()), tier);
    const deps = eligibilityDeps(this.#providers, () => this.#modules.moduleStates(guildId));
    const published = latest.get(formId);

    return {
      member: 'member',
      eligibility: await evaluateEligibility(
        deps,
        context,
        published?.snapshot.requirements ?? form.requirements,
      ),
      checked: published === undefined ? 'saved' : 'published',
    };
  }

  async audience(guildId: string, channelId: string, formId?: string): Promise<Audience> {
    assertGuildId(guildId);
    const [{ config }, channel, roster, botId] = await Promise.all([
      loadConfig(this.#modules, guildId),
      this.#members.channel(channelId),
      this.#members.roles(guildId),
      this.#members.botUserId?.() ?? Promise.resolve(null),
    ]);

    if (channel.state === 'missing' || (channel.state === 'found' && channel.guildId !== guildId)) {
      throw new ApplicationsError(
        'not_found',
        'Proton can’t see that channel in this server. It may have been deleted, or Proton may ' +
          'not be allowed to view it.',
      );
    }
    if (channel.state === 'unavailable' || roster === null) {
      throw new ApplicationsError(
        'unavailable',
        'Proton couldn’t read that channel’s permissions from Discord just now. Try again in a ' +
          'moment.',
      );
    }

    const form = formId === undefined ? undefined : formFor(config, formId);
    if (formId !== undefined && form === undefined) {
      throw new ApplicationsError('not_found', formMissing(formId));
    }

    const team = form === undefined ? config : teamFor(config, form);
    const onTeam = new Set([
      ...team.reviewerRoleIds,
      ...team.deciderRoleIds,
      ...team.viewerRoleIds,
    ]);

    const audience = channelAudience({
      roles: roster.roles,
      everyoneRoleId: roster.everyoneRoleId,
      ownerId: roster.ownerId,
      overwrites: channel.overwrites,
    });

    const proton = (roleId: string) => botId !== null && roster.botRoles.get(roleId) === botId;
    const members = audience.memberIds.filter((memberId) => memberId !== botId);

    return {
      channelId,
      everyone: audience.everyone,
      roleIds: audience.roleIds.filter((roleId) => !proton(roleId)),
      administratorRoleIds: audience.administratorRoleIds,
      memberCount: members.length,
      outsideTeam: audience.roleIds.filter((roleId) => !onTeam.has(roleId) && !proton(roleId)),
    };
  }

  async queue(guildId: string, query: QueueQuery, viewerId: string): Promise<QueueResult> {
    const staff = await this.#staff(guildId, viewerId);
    const { formIds, latest } = await this.#viewable(guildId, staff);

    const result = await this.#store.list(guildId, { ...query, formIds, viewerId });

    return {
      items: result.items.map((application) =>
        itemOf(
          application,
          nameOf(staff.config, application.formId, latest),
          result.problems.get(application.id) ?? [],
          result.votes.get(application.id),
        ),
      ),
      total: result.total,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  async summary(guildId: string, viewerId: string): Promise<QueueSummary> {
    const staff = await this.#staff(guildId, viewerId);
    const { formIds } = await this.#viewable(guildId, staff);
    return this.#store.summary(guildId, formIds, viewerId);
  }

  async detail(
    guildId: string,
    applicationId: string,
    viewerId: string,
  ): Promise<ApplicationDetail> {
    const { staff, application, form, formName, capabilities } = await this.#target(
      guildId,
      applicationId,
      viewerId,
    );

    const [record, version, moderation, interviewStatus] = await Promise.all([
      this.#store.detail(guildId, application.id),
      this.#store.version(guildId, application.versionId),
      this.#moderation(guildId, application.applicantId, staff.actor),
      this.#interviewStatus(guildId, application.interviewTicketId),
    ]);
    if (record === null) throw new ApplicationsError('not_found', NOT_FOUND);

    const current = record.application;
    const review = capabilities.has('review');

    return {
      application: {
        ...itemOf(current, formName, record.effects, tallyOf(record.votes)),
        versionId: current.versionId,
        version: version?.version ?? 1,
        decidedAt: current.decidedAt,
        decidedBy: current.decidedBy,
        decisionReason: current.decisionReason,
        reopenedCount: current.reopenedCount,
        archivedAt: current.archivedAt,
        contentPurgedAt: current.contentPurgedAt,
        deletedAt: current.deletedAt,
        interview:
          current.interviewTicketId === null
            ? null
            : {
                ticketId: current.interviewTicketId,
                channelId: current.interviewChannelId,
                status: interviewStatus,
              },
        cardUrl:
          current.cardChannelId === null || current.cardMessageId === null
            ? null
            : `https://discord.com/channels/${guildId}/${current.cardChannelId}/${current.cardMessageId}`,
      },
      answers: current.answers,
      sections: (version?.snapshot.sections ?? []).map(({ id, title }) => ({ id, title })),
      thread: record.thread.map(({ id, kind, authorId, body, createdAt }) => ({
        id,
        kind,
        authorId,
        body,
        createdAt,
      })),
      notes: review
        ? record.notes.map(({ id, authorId, body, createdAt }) => ({
            id,
            authorId,
            body,
            createdAt,
          }))
        : null,
      votes: review
        ? record.votes.map(({ reviewerId, vote, score, updatedAt }) => ({
            reviewerId,
            vote,
            score,
            updatedAt,
          }))
        : null,
      history: record.events.map(
        ({ id, kind, actorId, source, fromStatus, toStatus, createdAt }) => ({
          id,
          kind,
          actorId,
          source,
          fromStatus,
          toStatus,
          createdAt,
        }),
      ),
      effects: record.effects.map((effect) => ({
        id: effect.id,
        key: effect.key,
        kind: effect.kind,
        status: effect.status,
        attempts: effect.attempts,
        error: effect.error,
        errorCode: effect.errorCode ?? downgradeOf(effect),
        updatedAt: effect.updatedAt,
        label: EFFECT_LABELS[effect.kind],
      })),
      capabilities: CAPABILITIES.filter((capability) => capabilities.has(capability)),
      moderation,
      twoReviewers: form?.review.requireTwoReviewers ?? false,
      scoring: form?.review.scoring ?? false,
    };
  }

  async act(
    guildId: string,
    applicationId: string,
    body: StaffActionBody,
  ): Promise<StaffActionResult> {
    const { staff, application, form, formName, capabilities } = await this.#target(
      guildId,
      applicationId,
      body.actorId,
    );
    const reference = referenceOf(application.number);

    if (await this.#audits.exists(guildId, auditIdOf(body.action, guildId, body.requestId))) {
      const current = (await this.#store.get(guildId, application.id)) ?? application;
      return this.#answer(
        guildId,
        formName,
        true,
        'replayed',
        replayText(body.action, current),
        current,
      );
    }

    if (!staff.on && body.action !== 'delete') {
      throw new ApplicationsError('module_disabled', MODULE_OFF);
    }

    if (application.deletedAt !== null) {
      return this.#answer(
        guildId,
        formName,
        false,
        'deleted',
        `Application ${reference} was deleted, so nothing was done.`,
        application,
      );
    }

    const allowed = authorizeAction({
      config: staff.config,
      form: form ?? orphanForm(formName),
      actor: staff.actor,
      application,
      action: body.action,
    });
    if (!allowed.ok) {
      const message =
        allowed.code === 'wrong_status' && decided(application)
          ? alreadyReviewed(application)
          : allowed.humanReason;
      return this.#answer(guildId, formName, false, allowed.code, message, application);
    }

    if (body.action === 'delete') return this.#delete(guildId, staff, application, formName, body);

    if (form === null) {
      return this.#answer(
        guildId,
        formName,
        false,
        'form_removed',
        `The form for application ${reference} was removed from Applications settings, so it ` +
          'can only be read or deleted.',
        application,
      );
    }

    const acting: Acting = {
      guildId,
      body,
      config: staff.config,
      actor: staff.actor,
      application,
      form,
      capabilities,
      now: this.#now(),
    };

    switch (body.action) {
      case 'claim':
        return this.#claim(acting);
      case 'unclaim':
        return this.#unclaim(acting);
      case 'assign':
        return this.#assign(acting, body);
      case 'note':
        return this.#note(acting, body);
      case 'vote':
        return this.#vote(acting, body);
      case 'request_info':
        return this.#requestInfo(acting, body);
      case 'waitlist':
        return this.#waitlist(acting, body);
      case 'accept':
      case 'reject':
        return this.#decide(acting, body);
      case 'reopen':
        return this.#reopen(acting, body);
      case 'archive':
      case 'unarchive':
        return this.#archive(acting, body.action);
      case 'open_ticket':
        return this.#openTicket(acting);
      case 'retry_effect':
        return this.#settleEffect(acting, 'retry', body.effectId);
      case 'cancel_effect':
        return this.#settleEffect(acting, 'cancel', body.effectId);
      case 'repost_card':
        return this.#repostCard(acting);
    }
  }

  async export(guildId: string, query: ExportQuery, viewerId: string): Promise<ExportFile> {
    const staff = await this.#staff(guildId, viewerId);
    const { config, actor } = staff;
    const latest = await this.#store.latestVersions(guildId);

    const exportable = [
      ...config.forms
        .filter((form) => capabilitiesFor(config, form, actor).has('export'))
        .map((form) => form.id),
      ...(isAdmin(actor) ? retiredIds(config, latest) : []),
    ];

    if (query.formId !== undefined) {
      if (formFor(config, query.formId) === undefined && !latest.has(query.formId)) {
        throw new ApplicationsError('not_found', formMissing(query.formId));
      }
      if (!exportable.includes(query.formId)) throw new ApplicationsError('not_allowed', NO_EXPORT);
    }
    if (exportable.length === 0 && !isAdmin(actor)) {
      throw new ApplicationsError('not_allowed', NO_EXPORT);
    }

    const { rows, truncated } = await this.#store.exportRows(
      guildId,
      {
        formIds: exportable,
        formId: query.formId,
        view: query.view,
        from: query.from,
        to: query.to,
        viewerId,
      },
      EXPORT_ROWS_MAX,
    );

    const names = (formId: string) => nameOf(config, formId, latest);

    let questions: { id: string; label: string }[] | null = null;
    if (query.formId !== undefined) {
      const source = latest.get(query.formId)?.snapshot ?? formFor(config, query.formId);
      questions = exportColumns(
        source === undefined ? [] : questionsOf(source).map(({ id, label }) => ({ id, label })),
        rows,
      );
    }

    const now = this.#now();
    await this.#audit({
      id: `applications.export:${guildId}:${newId()}`,
      guildId,
      actorId: viewerId,
      source: 'dashboard',
      action: 'module.applications.export',
      before: null,
      after: {
        format: query.format,
        formId: query.formId ?? null,
        view: query.view,
        from: query.from ?? null,
        to: query.to ?? null,
        rows: rows.length,
        truncated,
      },
      ipHash: null,
    });

    return exportFile({
      guildId,
      format: query.format,
      rows,
      truncated,
      formName: names,
      questions,
      exportedAt: now,
    });
  }

  async members(
    guildId: string,
    userIds: readonly string[],
    viewerId: string,
  ): Promise<ReviewMembers> {
    const staff = await this.#staff(guildId, viewerId);
    this.#teamForms(staff);

    const wanted = [...new Set(userIds)]
      .filter((id) => snowflakeSchema.safeParse(id).success)
      .slice(0, MEMBER_NAMES_MAX);

    const members: ReviewMembers['members'] = [];
    for (let at = 0; at < wanted.length; at += MEMBER_CONCURRENCY) {
      const reads = await Promise.all(
        wanted.slice(at, at + MEMBER_CONCURRENCY).map((id) => this.#members.read(guildId, id)),
      );

      for (const [index, read] of reads.entries()) {
        const id = wanted[at + index];
        if (id === undefined || read.state !== 'member') continue;
        members.push({
          id,
          displayName: displayNameOf(read.raw) ?? id,
          username: usernameOf(read.raw) ?? id,
          avatarUrl: avatarUrlOf(guildId, read.raw),
          bot: isBot(read.raw),
        });
      }
    }

    return { members };
  }

  async deleteApplicant(
    guildId: string,
    applicantId: string,
    body: DeleteApplicantBody,
  ): Promise<DeleteApplicantResult> {
    const staff = await this.#staff(guildId, body.actorId);
    const probe = staff.config.forms[0] ?? orphanForm('Applications');
    if (!capabilitiesFor(staff.config, probe, staff.actor).has('delete')) {
      throw new ApplicationsError('not_allowed', NO_DELETE);
    }

    const now = this.#now();
    const result = await this.#store.deleteApplicant({
      guildId,
      applicantId,
      actor: { id: body.actorId, source: 'dashboard' },
      audit: {
        actorId: body.actorId,
        source: 'dashboard',
        action: 'module.applications.delete_applicant',
        id: auditIdOf('delete_applicant', guildId, body.requestId),
        before: { applicantId },
        after: { applicantId, requestId: body.requestId },
        ipHash: body.ipHash ?? null,
      },
      cleanup: deleteCleanup(staff.config),
      now,
    });

    if (result.deleted > 0) {
      await requestWork(this.#bus, this.#logger, now, {
        guildId,
        reason: 'delete',
        key: `delete_applicant:${body.requestId}`,
      });
    }

    return { deleted: result.deleted };
  }

  async #staff(guildId: string, viewerId: string): Promise<Staff> {
    assertGuildId(guildId);
    const [loaded, member] = await Promise.all([
      loadConfig(this.#modules, guildId),
      this.#members.read(guildId, viewerId),
    ]);

    if (member.state === 'absent') throw new ApplicationsError('not_member', NOT_MEMBER);
    if (member.state === 'unavailable') {
      throw new ApplicationsError('unavailable', ROLES_UNREADABLE);
    }

    return { ...loaded, actor: member.actor };
  }

  #teamForms(staff: Staff): string[] {
    const formIds = viewableFormIds(staff.config, staff.actor);
    if (formIds.length === 0 && !isAdmin(staff.actor)) {
      throw new ApplicationsError('not_allowed', NO_TEAM);
    }
    return formIds;
  }

  async #viewable(
    guildId: string,
    staff: Staff,
  ): Promise<{ formIds: string[]; latest: ReadonlyMap<string, FormVersionRecord> }> {
    const formIds = this.#teamForms(staff);
    if (!isAdmin(staff.actor)) return { formIds, latest: new Map() };

    const latest = await this.#store.latestVersions(guildId);
    return { formIds: [...formIds, ...retiredIds(staff.config, latest)], latest };
  }

  async #target(guildId: string, applicationId: string, viewerId: string): Promise<Target> {
    const staff = await this.#staff(guildId, viewerId);
    if (!APPLICATION_ID.test(applicationId)) throw new ApplicationsError('not_found', NOT_FOUND);

    const application = await this.#store.get(guildId, applicationId);
    if (
      application === null ||
      application.number === null ||
      application.status === 'draft' ||
      application.applicantId === viewerId
    ) {
      throw new ApplicationsError('not_found', NOT_FOUND);
    }

    const form = formFor(staff.config, application.formId) ?? null;
    const formName =
      form?.name ??
      (await this.#store.version(guildId, application.versionId))?.snapshot.name ??
      application.formId;

    const capabilities = capabilitiesFor(staff.config, form ?? orphanForm(formName), staff.actor);
    if (!capabilities.has('view')) {
      throw new ApplicationsError('not_allowed', `You aren’t on the review team for ${formName}.`);
    }

    return { staff, application, form, formName, capabilities };
  }

  async #interviewStatus(guildId: string, ticketId: string | null): Promise<InterviewStatus> {
    if (ticketId === null || this.#interviews === undefined) return 'unknown';

    try {
      return await this.#interviews.status(guildId, ticketId);
    } catch (error) {
      this.#logger.warn(`applications couldn’t read an interview ticket: ${String(error)}`);
      return 'unknown';
    }
  }

  async #moderation(
    guildId: string,
    applicantId: string,
    actor: ReviewActor,
  ): Promise<ApplicationDetail['moderation']> {
    if (this.#cases === undefined || !canSeeModeration(actor)) return null;

    try {
      const found = await this.#cases.search(
        guildId,
        caseQuerySchema.parse({
          targetId: applicantId,
          scope: 'moderation',
          pageSize: MODERATION_SCAN,
        }),
      );
      const now = this.#now();
      const counted: ReadonlySet<string> = new Set(CASE_TYPES_COUNTED);

      return {
        activeCases: found.cases.filter(
          (entry) =>
            counted.has(entry.type) &&
            !entry.dryRun &&
            entry.revertedAt === null &&
            (entry.expiresAt === null || Date.parse(entry.expiresAt) >= now),
        ).length,
        recent: found.cases.slice(0, MODERATION_RECENT).map((entry) => ({
          caseNumber: entry.caseNumber,
          type: entry.type,
          createdAt: Date.parse(entry.createdAt),
          reason: entry.reason,
        })),
      };
    } catch (error) {
      this.#logger.error(
        `applications could not read the moderation history for an application in guild ${guildId}: ${
          error instanceof Error ? error.name : 'unknown error'
        }`,
      );
      return null;
    }
  }

  async #answer(
    guildId: string,
    formName: string,
    ok: boolean,
    code: string,
    message: string,
    application: ApplicationRecord | null,
  ): Promise<StaffActionResult> {
    if (application === null) return { ok, code, message, application: null };

    const record = await this.#store.detail(guildId, application.id);
    const current = record?.application ?? application;

    return {
      ok,
      code,
      message,
      application: itemOf(current, formName, record?.effects ?? [], tallyOf(record?.votes ?? [])),
    };
  }

  #auditOf(acting: Acting, verb: string, after: Record<string, unknown>): AuditInput {
    const { application, body } = acting;
    return {
      actorId: body.actorId,
      source: 'dashboard',
      action: `module.applications.${verb}`,
      id: auditIdOf(verb, acting.guildId, body.requestId),
      before: {
        applicationId: application.id,
        number: application.number,
        formId: application.formId,
        status: application.status,
        assigneeId: application.assigneeId,
        revision: application.revision,
      },
      after: { action: verb, requestId: body.requestId, ...after },
      ipHash: body.ipHash ?? null,
    };
  }

  #plan(acting: Acting, event: ApplicationLifecycleEvent | 'card_only'): PlanEffects {
    return (application, revision) =>
      planEffects(event, {
        config: acting.config,
        form: acting.form,
        application,
        revision,
        now: acting.now,
        actorId: acting.actor.id,
      });
  }

  #transition(
    acting: Acting,
    step: Step,
    verb: string = acting.body.action,
  ): Promise<TransitionResult> {
    const { guildId, application, actor, body } = acting;

    return this.#store.transition({
      guildId,
      applicationId: application.id,
      action: step.action,
      actor: { id: actor.id, source: 'dashboard' },
      expect: step.expect,
      patch: step.patch,
      thread: step.thread,
      note: step.note,
      vote: step.vote,
      event: {
        kind: step.kind,
        id: eventIdOf(application.id, step.kind, body.requestId),
        lifecycle: step.lifecycle ?? undefined,
        data: step.data,
      },
      plan: step.plan,
      audit: this.#auditOf(acting, verb, step.after ?? {}),
      bumpRevision: step.bumpRevision,
      clearVotes: step.clearVotes,
      supersede: step.supersede,
      now: acting.now,
    });
  }

  async #finish(
    acting: Acting,
    result: TransitionResult,
    message: (application: ApplicationRecord, effects: readonly EffectRecord[]) => string,
    reason: ApplicationWorkReason,
    stale?: (fresh: ApplicationRecord | null) => string | null,
  ): Promise<StaffActionResult> {
    const formName = acting.form.name;

    if (result.status === 'stale') {
      const fresh = result.application;
      return this.#answer(
        acting.guildId,
        formName,
        false,
        'stale',
        stale?.(fresh) ?? staleText(fresh),
        fresh,
      );
    }

    if (result.effects.length > 0) {
      await this.#work(acting.guildId, result.application.id, reason, acting.body.requestId);
    }

    return this.#answer(
      acting.guildId,
      formName,
      true,
      'done',
      message(result.application, result.effects),
      result.application,
    );
  }

  #unchanged(acting: Acting, message: string): Promise<StaffActionResult> {
    return this.#answer(
      acting.guildId,
      acting.form.name,
      true,
      'unchanged',
      message,
      acting.application,
    );
  }

  #refuse(acting: Acting, code: string, message: string): Promise<StaffActionResult> {
    return this.#answer(acting.guildId, acting.form.name, false, code, message, acting.application);
  }

  async #work(
    guildId: string,
    applicationId: string,
    reason: ApplicationWorkReason,
    requestId: string,
  ): Promise<void> {
    await requestWork(this.#bus, this.#logger, this.#now(), {
      guildId,
      applicationId,
      reason,
      key: `${applicationId}:${requestId}`,
    });
  }

  async #claim(acting: Acting): Promise<StaffActionResult> {
    const { application, actor, now } = acting;
    const reference = referenceOf(application.number);

    if (application.assigneeId === actor.id) {
      return this.#unchanged(acting, `You’ve already claimed application ${reference}.`);
    }
    if (application.assigneeId !== null) {
      return this.#refuse(
        acting,
        'claimed',
        `Another reviewer has already claimed application ${reference}. Reassign it if you need ` +
          'to take it over.',
      );
    }

    const to = nextStatus('claim', application.status, true) ?? 'in_review';
    const lifecycle = lifecycleEventFor('claim', application.status, to);

    const result = await this.#transition(acting, {
      action: 'claim',
      kind: 'claimed',
      expect: { statuses: allowedFrom('claim'), assigneeId: null },
      patch: {
        status: to,
        assigneeId: actor.id,
        assignedAt: now,
        ...(to === 'in_review' && application.reviewStartedAt === null
          ? { reviewStartedAt: now }
          : {}),
      },
      lifecycle,
      plan: this.#plan(acting, lifecycle ?? 'card_only'),
      after: { status: to },
    });

    return this.#finish(
      acting,
      result,
      () => `You claimed application ${reference}.`,
      'decision',
      (fresh) =>
        fresh !== null && fresh.assigneeId !== null && fresh.assigneeId !== actor.id
          ? `Another reviewer claimed application ${reference} first.`
          : null,
    );
  }

  async #unclaim(acting: Acting): Promise<StaffActionResult> {
    const { application, actor, capabilities } = acting;
    const reference = referenceOf(application.number);

    if (application.assigneeId !== actor.id && !capabilities.has('decide')) {
      return this.#refuse(
        acting,
        'not_allowed',
        `Only the reviewer who claimed application ${reference} or a decider can unclaim it.`,
      );
    }

    const result = await this.#transition(acting, {
      action: 'unclaim',
      kind: 'unclaimed',
      expect: { statuses: allowedFrom('unclaim'), assigneeId: application.assigneeId },
      patch: { status: 'submitted', assigneeId: null, assignedAt: null },
      data: application.assigneeId === actor.id ? {} : { from: application.assigneeId },
      plan: this.#plan(acting, 'card_only'),
      after: { status: 'submitted' },
    });

    return this.#finish(
      acting,
      result,
      () => `Application ${reference} is unclaimed and back in the queue.`,
      'decision',
    );
  }

  async #assign(acting: Acting, body: Body<'assign'>): Promise<StaffActionResult> {
    const { application, config, form, now } = acting;
    const reference = referenceOf(application.number);
    const assigneeId = body.assigneeId;

    if (assigneeId === application.assigneeId) {
      return this.#unchanged(
        acting,
        assigneeId === null
          ? `Application ${reference} isn’t assigned to anyone.`
          : `Application ${reference} is already assigned to them.`,
      );
    }

    if (assigneeId !== null) {
      if (assigneeId === application.applicantId) {
        return this.#refuse(
          acting,
          'self',
          'An application can’t be assigned to the member who sent it.',
        );
      }

      const assignee = await this.#members.read(acting.guildId, assigneeId);
      if (assignee.state === 'absent') {
        return this.#refuse(
          acting,
          'not_member',
          `That member isn’t in this server any more, so application ${reference} wasn’t assigned.`,
        );
      }
      if (assignee.state === 'unavailable') {
        return this.#refuse(
          acting,
          'unavailable',
          `Proton couldn’t check that member’s roles just now, so application ${reference} ` +
            'wasn’t assigned. Try again in a moment.',
        );
      }
      if (!capabilitiesFor(config, form, assignee.actor).has('review')) {
        return this.#refuse(
          acting,
          'not_allowed',
          `That member isn’t on the review team for ${form.name}, so application ${reference} ` +
            'wasn’t assigned.',
        );
      }
    }

    const to = nextStatus('assign', application.status, assigneeId !== null) ?? application.status;
    const lifecycle = lifecycleEventFor('assign', application.status, to);

    const result = await this.#transition(acting, {
      action: 'assign',
      kind: assigneeId === null ? 'unassigned' : 'assigned',
      expect: { statuses: allowedFrom('assign'), assigneeId: application.assigneeId },
      patch: {
        status: to,
        assigneeId,
        assignedAt: assigneeId === null ? null : now,
        ...(to === 'in_review' && application.reviewStartedAt === null
          ? { reviewStartedAt: now }
          : {}),
      },
      lifecycle,
      data: { assigneeId },
      plan: this.#plan(acting, lifecycle ?? 'card_only'),
      after: { status: to, assigneeId },
    });

    return this.#finish(
      acting,
      result,
      () =>
        assigneeId === null
          ? `Application ${reference} is no longer assigned to anyone.`
          : `Assigned application ${reference}.`,
      'decision',
    );
  }

  async #note(acting: Acting, body: Body<'note'>): Promise<StaffActionResult> {
    const reference = referenceOf(acting.application.number);

    const result = await this.#transition(acting, {
      action: 'note',
      kind: 'note',
      expect: { statuses: allowedFrom('note') },
      patch: {},
      note: { body: body.body },
      data: { length: body.body.length },
      after: { length: body.body.length },
      bumpRevision: false,
    });

    return this.#finish(
      acting,
      result,
      () => `Added a note to application ${reference}. Only the review team can read it.`,
      'decision',
    );
  }

  async #vote(acting: Acting, body: Body<'vote'>): Promise<StaffActionResult> {
    const { application, actor, form } = acting;
    const reference = referenceOf(application.number);

    const score = form.review.scoring ? (body.score ?? null) : null;
    if (form.review.scoring && score === null) {
      return this.#refuse(
        acting,
        'score_required',
        'Choose a score from 1 to 5, then vote again. Nothing was changed.',
      );
    }

    const votes = await this.#store.votes(acting.guildId, application.id);
    const mine = votes.find((cast) => cast.reviewerId === actor.id);
    if (mine !== undefined && mine.vote === body.vote && mine.score === score) {
      return this.#unchanged(
        acting,
        `You’ve already voted to ${body.vote} application ${reference}.`,
      );
    }

    const result = await this.#transition(acting, {
      action: 'vote',
      kind: 'voted',
      expect: { statuses: allowedFrom('vote') },
      patch: {},
      vote: { vote: body.vote, score },
      data: { vote: body.vote, ...(score === null ? {} : { score }) },
      plan: this.#plan(acting, 'card_only'),
      after: { vote: body.vote, ...(score === null ? {} : { score }) },
    });

    return this.#finish(
      acting,
      result,
      () =>
        `Your vote to ${body.vote} application ${reference} is in. Votes inform the decision; ` +
        'they don’t make it.',
      'decision',
    );
  }

  async #requestInfo(acting: Acting, body: Body<'request_info'>): Promise<StaffActionResult> {
    const { application, config, now } = acting;
    const reference = referenceOf(application.number);
    const days = config.followUpDeadlineDays;
    const due = days > 0 ? now + days * DAY_MS : null;
    const lifecycle = 'applications.information_requested';

    const result = await this.#transition(acting, {
      action: 'request_info',
      kind: 'information_requested',
      expect: { statuses: allowedFrom('request_info') },
      patch: { status: 'needs_info', infoRequestedAt: now, infoDueAt: due },
      thread: { kind: 'info_request', body: body.message },
      lifecycle,
      data: { length: body.message.length },
      plan: this.#plan(acting, lifecycle),
      after: { status: 'needs_info', length: body.message.length },
    });

    return this.#finish(
      acting,
      result,
      (_application, effects) =>
        [
          `Asked the applicant for more information on application ${reference}.`,
          ...(due === null ? [] : [`They have ${days} ${days === 1 ? 'day' : 'days'} to answer.`]),
          ...(effects.some((effect) => effect.kind === 'dm')
            ? ['Proton is sending the question by DM as well.']
            : []),
        ].join(' '),
      'decision',
    );
  }

  async #waitlist(acting: Acting, body: Body<'waitlist'>): Promise<StaffActionResult> {
    const { application, now } = acting;
    const reference = referenceOf(application.number);
    const reason = blankToNull(body.reason);
    const lifecycle = 'applications.waitlisted';

    const result = await this.#transition(acting, {
      action: 'waitlist',
      kind: 'waitlisted',
      expect: { statuses: allowedFrom('waitlist') },
      patch: { status: 'waitlisted', waitlistedAt: now, decisionReason: reason, infoDueAt: null },
      thread: reason === null ? undefined : { kind: 'decision', body: reason },
      lifecycle,
      data: { reasonLength: reason?.length ?? 0 },
      plan: this.#plan(acting, lifecycle),
      after: { status: 'waitlisted', reasonLength: reason?.length ?? 0 },
    });

    return this.#finish(
      acting,
      result,
      (_application, effects) =>
        `Waitlisted application ${reference}.${
          effects.some((effect) => effect.kind === 'dm')
            ? ' Proton is letting the applicant know by DM.'
            : ''
        }`,
      'decision',
    );
  }

  async #decide(acting: Acting, body: Body<'accept' | 'reject'>): Promise<StaffActionResult> {
    const { application, actor, form, capabilities, config, now } = acting;
    const decision = body.action;
    const reference = referenceOf(application.number);

    const votes = await this.#store.votes(acting.guildId, application.id);
    let override = false;

    if (form.review.requireTwoReviewers) {
      const check = twoReviewerCheck({
        form,
        decision,
        deciderId: actor.id,
        votes: await this.#seconds(acting, votes, decision),
        applicantId: application.applicantId,
      });
      if (!check.ok) {
        const canOverride = capabilities.has('override');
        if (!canOverride || body.override !== true) {
          return this.#refuse(
            acting,
            'two_reviewers',
            canOverride
              ? `${check.humanReason} You can also decide without a second reviewer. That is ` +
                  'recorded in the history.'
              : check.humanReason,
          );
        }
        override = true;
      }
    }

    const reason = blankToNull(body.reason);
    const note = blankToNull(body.note);
    const status = decision === 'accept' ? 'accepted' : 'rejected';
    const lifecycle = decision === 'accept' ? 'applications.accepted' : 'applications.rejected';
    const lengths = { reasonLength: reason?.length ?? 0, noteLength: note?.length ?? 0 };
    const mine = votes.find((cast) => cast.reviewerId === actor.id);

    const result = await this.#transition(acting, {
      action: decision,
      kind: status,
      expect: {
        statuses: allowedFrom(decision),
        ...(form.review.requireTwoReviewers ? { revision: application.revision } : {}),
      },
      patch: {
        status,
        decidedAt: now,
        decidedBy: actor.id,
        decisionReason: reason,
        contentPurgeAt: now + config.retentionDays * DAY_MS,
        infoDueAt: null,
      },
      thread: reason === null ? undefined : { kind: 'decision', body: reason },
      note: note === null ? undefined : { body: note },
      vote: { vote: decision, score: mine?.score ?? null },
      lifecycle,
      data: { ...lengths, ...(override ? { override: 'two_reviewers' } : {}) },
      plan: this.#plan(acting, lifecycle),
      after: { status, ...lengths, override },
    });

    if (result.status === 'done' && override) await this.#recordOverride(acting, decision);

    return this.#finish(
      acting,
      result,
      (_application, effects) => {
        const progress = progressText(effects);
        return [
          `${decision === 'accept' ? 'Accepted' : 'Rejected'} application ${reference}.`,
          ...(override ? ['It’s recorded as decided without a second reviewer.'] : []),
          ...(progress === null ? [] : [progress]),
        ].join(' ');
      },
      'decision',
    );
  }

  async #seconds(
    acting: Acting,
    votes: readonly VoteRecord[],
    decision: 'accept' | 'reject',
  ): Promise<VoteRecord[]> {
    const { guildId, config, form, actor, application } = acting;
    const voters = [
      ...new Set(
        votes
          .filter(
            (cast) =>
              cast.vote === decision &&
              cast.reviewerId !== actor.id &&
              cast.reviewerId !== application.applicantId,
          )
          .map((cast) => cast.reviewerId),
      ),
    ];

    for (const voterId of voters) {
      const voter = await this.#members.read(guildId, voterId);
      if (voter.state === 'member' && capabilitiesFor(config, form, voter.actor).has('review')) {
        return votes.filter((cast) => cast.reviewerId === voterId);
      }
    }
    return [];
  }

  async #recordOverride(acting: Acting, decision: 'accept' | 'reject'): Promise<void> {
    const status = decision === 'accept' ? 'accepted' : 'rejected';

    try {
      await this.#transition(
        acting,
        {
          action: decision,
          kind: 'override_two_reviewers',
          expect: { statuses: [status] },
          patch: {},
          data: { decision },
          after: { decision },
          bumpRevision: false,
        },
        'override_two_reviewers',
      );
    } catch (error) {
      this.#logger.error(
        `applications could not record a two-reviewer override on ${acting.application.id} in ` +
          `guild ${acting.guildId}: ${error instanceof Error ? error.name : 'unknown error'}`,
      );
    }
  }

  async #reopen(acting: Acting, body: Body<'reopen'>): Promise<StaffActionResult> {
    const { application, config, now } = acting;
    const reference = referenceOf(application.number);

    if (application.contentPurgedAt !== null) {
      return this.#refuse(
        acting,
        'purged',
        `The answers to application ${reference} were removed after this server’s keep-for ` +
          'period, so it can’t be reopened.',
      );
    }

    const to =
      nextStatus('reopen', application.status, application.assigneeId !== null) ?? 'submitted';
    const hours = config.reviewReminderHours;
    const lifecycle = 'applications.reopened';

    const result = await this.#transition(acting, {
      action: 'reopen',
      kind: 'reopened',
      expect: { statuses: allowedFrom('reopen'), revision: application.revision },
      patch: {
        status: to,
        decidedAt: null,
        decidedBy: null,
        decisionReason: null,
        reopenedCount: application.reopenedCount + 1,
        contentPurgeAt: null,
        archivedAt: null,
        reviewDueAt: hours > 0 ? now + hours * HOUR_MS : null,
        remindedAt: null,
      },
      note: { body: body.reason },
      lifecycle,
      data: { reasonLength: body.reason.length },
      plan: this.#plan(acting, lifecycle),
      after: { status: to, reasonLength: body.reason.length },
      clearVotes: true,
      supersede: true,
    });

    return this.#finish(
      acting,
      result,
      () =>
        `Reopened application ${reference}. It’s ${STATUS_LABELS[to].toLowerCase()} again, and ` +
        'the actions from its earlier decision weren’t run again. Earlier votes were cleared, and ' +
        'the reason is saved as a note.',
      'decision',
    );
  }

  async #archive(acting: Acting, action: 'archive' | 'unarchive'): Promise<StaffActionResult> {
    const { application, now } = acting;
    const reference = referenceOf(application.number);
    const archiving = action === 'archive';

    if (archiving === (application.archivedAt !== null)) {
      return this.#unchanged(
        acting,
        archiving
          ? `Application ${reference} is already archived.`
          : `Application ${reference} isn’t archived.`,
      );
    }

    const result = await this.#transition(acting, {
      action,
      kind: archiving ? 'archived' : 'unarchived',
      expect: { statuses: allowedFrom(action) },
      patch: { archivedAt: archiving ? now : null },
      plan: this.#plan(acting, 'card_only'),
      after: {},
    });

    return this.#finish(
      acting,
      result,
      () =>
        archiving
          ? `Archived application ${reference}.`
          : `Application ${reference} is back in its list.`,
      'decision',
    );
  }

  async #openTicket(acting: Acting): Promise<StaffActionResult> {
    const { form, config, application, actor, now } = acting;
    const typeId = form.interview.ticketTypeId;

    if (typeId === undefined) {
      return this.#refuse(
        acting,
        'no_ticket_type',
        `${form.name} has no interview ticket type. You can choose one in the form’s review ` +
          'settings.',
      );
    }

    let ticketsOn: boolean | null;
    try {
      ticketsOn = (await this.#modules.moduleStates(acting.guildId)).tickets?.on === true;
    } catch {
      ticketsOn = null;
    }
    if (ticketsOn === null) {
      return this.#refuse(
        acting,
        'unavailable',
        'Proton can’t check whether Tickets is on right now, so no interview ticket was opened. ' +
          'Try again in a moment.',
      );
    }
    if (!ticketsOn) {
      return this.#refuse(
        acting,
        'tickets_off',
        'Tickets is off in this server, so Proton can’t open an interview ticket. Turn Tickets ' +
          'on first.',
      );
    }

    const result = await this.#transition(acting, {
      action: 'open_ticket',
      kind: 'ticket_requested',
      expect: { statuses: allowedFrom('open_ticket') },
      patch: {},
      data: { typeId },
      plan: (next, revision) =>
        planTicket({ config, form, application: next, revision, now, actorId: actor.id }),
      after: { typeId },
    });

    return this.#finish(
      acting,
      result,
      () =>
        application.interviewTicketId === null
          ? 'Proton asked Tickets to open an interview ticket with the applicant. It shows here ' +
            'once Tickets has made it.'
          : 'Proton asked Tickets to reopen the interview ticket with the applicant, or open a ' +
            'new one.',
      'decision',
    );
  }

  async #settleEffect(
    acting: Acting,
    change: 'retry' | 'cancel',
    effectId: string,
  ): Promise<StaffActionResult> {
    const { application, actor, guildId } = acting;
    const verb = change === 'retry' ? 'retry_effect' : 'cancel_effect';
    const audit = this.#auditOf(acting, verb, { effectId });
    const who = { id: actor.id, source: 'dashboard' as const };

    const effect =
      change === 'retry'
        ? await this.#store.retryEffect(guildId, application.id, effectId, who, audit)
        : await this.#store.cancelEffect(guildId, application.id, effectId, who, audit);

    if (effect === null) {
      return this.#refuse(
        acting,
        change === 'retry' ? 'not_retryable' : 'not_cancellable',
        change === 'retry'
          ? 'That action can’t be tried again. Only a failed action can, and it may already be ' +
              'running again.'
          : 'That action has already finished or been cancelled, so there was nothing to cancel.',
      );
    }

    await this.#work(
      guildId,
      application.id,
      change === 'retry' ? 'retry' : 'decision',
      acting.body.requestId,
    );

    const current = (await this.#store.get(guildId, application.id)) ?? application;
    return this.#answer(
      guildId,
      acting.form.name,
      true,
      'done',
      change === 'retry'
        ? `Proton will try “${EFFECT_LABELS[effect.kind]}” again in a moment.`
        : `Cancelled “${EFFECT_LABELS[effect.kind]}”. Proton won’t try it again.`,
      current,
    );
  }

  async #repostCard(acting: Acting): Promise<StaffActionResult> {
    const { config, form, actor, now } = acting;

    if (reviewChannelFor(config, form) === undefined) {
      return this.#refuse(
        acting,
        'no_review_channel',
        `${form.name} has no review channel, so there’s no card to post. Choose one in the form’s ` +
          'review settings or in Applications settings.',
      );
    }

    const result = await this.#transition(acting, {
      action: 'repost_card',
      kind: 'card_reposted',
      expect: { statuses: allowedFrom('repost_card') },
      patch: {},
      plan: (application, revision) =>
        planCard({ config, form, application, revision, now, actorId: actor.id }, 'card', {
          repost: true,
        }),
      after: {},
    });

    return this.#finish(
      acting,
      result,
      () => 'Proton will post the review card again in a moment.',
      'decision',
    );
  }

  async #delete(
    guildId: string,
    staff: Staff,
    application: ApplicationRecord,
    formName: string,
    body: Body<'delete'>,
  ): Promise<StaffActionResult> {
    const now = this.#now();
    const result = await this.#store.deleteApplication({
      guildId,
      applicationId: application.id,
      actor: { id: staff.actor.id, source: 'dashboard' },
      audit: {
        actorId: body.actorId,
        source: 'dashboard',
        action: 'module.applications.delete',
        id: auditIdOf('delete', guildId, body.requestId),
        before: {
          applicationId: application.id,
          number: application.number,
          formId: application.formId,
          status: application.status,
        },
        after: { action: 'delete', requestId: body.requestId },
        ipHash: body.ipHash ?? null,
      },
      cleanup: deleteCleanup(staff.config),
      now,
    });
    if (result.status === 'missing') throw new ApplicationsError('not_found', NOT_FOUND);

    await this.#work(guildId, application.id, 'delete', body.requestId);

    const card = application.cardChannelId !== null && application.cardMessageId !== null;
    return this.#answer(
      guildId,
      formName,
      true,
      'done',
      [
        `Deleted application ${referenceOf(application.number)} and its answers.`,
        ...(card ? [staff.on ? CARD_REMOVING : CARD_REMOVED_LATER] : []),
        'Copies someone already downloaded can’t be recalled.',
      ].join(' '),
      result.application,
    );
  }
}
