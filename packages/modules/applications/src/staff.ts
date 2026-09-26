import {
  type ActionRequest,
  type ActionResult,
  type ApplicationLifecycleEvent,
  type ComponentInteraction,
  deferEphemeral,
  deferUpdate,
  editOriginal,
  errorStatus,
  type FollowUpTo,
  followUp,
  type InteractionMessage,
  interactionRef,
  MAX_MODAL_TITLE_LENGTH,
  MESSAGE_FLAG_EPHEMERAL,
  type Modal,
  type ModalInteraction,
  type ModuleContext,
  openModal,
  type ProtonCustomId,
  type ProtonEvent,
  type RespondTo,
  readComponentInteraction,
  readMemberPermissions,
  readModalInteraction,
  replyEphemeral,
  type StatusBody,
  successStatus,
} from '@proton/core';
import { ButtonStyle, ComponentType, TextInputStyle } from 'discord-api-types/v10';
import { answerPages } from './answers-view.ts';
import {
  authorizeAction,
  type Capability,
  capabilitiesFor,
  type ReviewActor,
  twoReviewerCheck,
  viewableFormIds,
} from './authorize.ts';
import {
  actorMention,
  buildReviewCard,
  cardMessage,
  clip,
  effectProblems,
  relative,
  STATUS_ACCENTS,
  voteTally,
} from './card.ts';
import {
  type ApplicationsConfig,
  type FormConfig,
  formFor,
  reviewSchema,
  teamFor,
} from './config.ts';
import { INFO_REQUEST_MAX, MODULE_ID, NOTE_MAX, REASON_MAX } from './constants.ts';
import type { BoundApplicationsDeps } from './deps.ts';
import { type EffectPlan, planEffects, planTicket } from './effects.ts';
import { CustomIdTooLongError, customId, MORE_CHOICES, STAFF_ACTION } from './interface.ts';
import { reviewActorFor } from './member.ts';
import { requestWork } from './runner.ts';
import {
  allowedFrom,
  lifecycleEventFor,
  nextStatus,
  STATUS_LABELS,
  type StaffAction,
} from './status.ts';
import type {
  ApplicationRecord,
  AuditInput,
  EffectRecord,
  PlanEffects,
  TransitionResult,
  VoteChoice,
  VoteRecord,
} from './store.ts';
import { DAY_MS, referenceOf } from './web.ts';

type Ctx = ModuleContext<ApplicationsConfig>;
type Answering = Pick<Ctx, 'guildId' | 'executor' | 'logger'>;
type Component = Record<string, unknown>;

export const REVIEW_FIELDS = {
  reason: 'reason',
  note: 'note',
  message: 'message',
  score: 'score',
  override: 'override',
} as const;

export const SCORES = [1, 2, 3, 4, 5] as const;

const SCORE_LABELS: Readonly<Record<(typeof SCORES)[number], string>> = {
  1: '1 · Weak',
  2: '2',
  3: '3 · Mixed',
  4: '4',
  5: '5 · Strong',
};

const APPLICATION_ID = /^[A-Za-z0-9_-]{1,64}$/;
const LABEL_MAX = 45;
const DESCRIPTION_MAX = 100;
const NAME_SHOWN_MAX = 60;
const VOTER_BUDGET_MS = 1_500;

export const MODULE_OFF =
  'Applications is off in this server, so this button doesn’t work. A server admin can turn it ' +
  'on in the dashboard.';
export const STALE_BUTTON =
  'I can’t find the application this button belongs to any more, so nothing was done.';
const NO_MEMBER = 'I couldn’t read your roles in this server, so nothing was done.';
const UNKNOWN_PRESS = 'This button is from an older version of Proton. Open the application again.';
const TICKETS_OFF = 'Tickets is off in this server, so I can’t open an interview ticket.';
const TICKETS_UNKNOWN =
  'I can’t check whether Tickets is on right now, so no interview ticket was opened. Try again ' +
  'in a moment.';
const INFO_EMPTY = 'Write what you need to know, then send it again. Nothing was changed.';
const NOTE_EMPTY = 'The note was empty, so nothing was added.';
const FORM_REMOVED =
  'The form this was sent on was removed from Applications settings, so it can only be read.';

export function reviewActorOf(event: ProtonEvent): ReviewActor | null {
  const facts =
    event.type === 'interaction.modal'
      ? readModalInteraction(event)
      : readComponentInteraction(event);
  if (facts === null || facts.roleIds === null) return null;

  // Discord already folds ownership into member.permissions, so owner stays false here.
  return {
    id: facts.userId,
    roleIds: facts.roleIds,
    permissions: readMemberPermissions(event),
    owner: false,
  };
}

export function statusMessage(body: StatusBody): InteractionMessage {
  return { content: body.content, embeds: body.embeds, allowedMentions: { parse: [] } };
}

function failed(result: ActionResult): boolean {
  return result.status === 'failed_precheck' || result.status === 'failed_api';
}

export async function respond(ctx: Answering, request: ActionRequest): Promise<ActionResult> {
  const result = await ctx.executor.execute(request);
  if (failed(result)) {
    ctx.logger.warn(
      `applications could not answer a review interaction: ${
        result.failure?.humanReason ?? 'Discord gave no reason.'
      }`,
      { guildId: ctx.guildId, moduleId: MODULE_ID, kind: request.kind, code: result.failure?.code },
    );
  }
  return result;
}

export async function settle(
  ctx: Answering,
  follow: FollowUpTo,
  message: InteractionMessage,
): Promise<void> {
  const edited = await respond(ctx, editOriginal(follow, message, 'result'));
  if (!failed(edited)) return;

  await respond(ctx, followUp(follow, { ...message, ephemeral: true }, 'result'));
}

export function alreadyReviewed(application: ApplicationRecord): string {
  const verb = STATUS_LABELS[application.status].toLowerCase();
  const by = application.decidedBy === null ? '' : ` by ${actorMention(application.decidedBy)}`;
  const when = application.decidedAt === null ? '' : ` ${relative(application.decidedAt)}`;
  return `This application has already been reviewed. It was ${verb}${by}${when}.`;
}

function decided(application: ApplicationRecord): boolean {
  return application.status === 'accepted' || application.status === 'rejected';
}

function staleText(application: ApplicationRecord | null): string {
  if (application === null || application.deletedAt !== null) return STALE_BUTTON;
  if (decided(application)) return alreadyReviewed(application);
  if (application.status === 'withdrawn') return 'The applicant withdrew this application.';
  if (application.status === 'expired') return 'This application has expired.';
  return (
    'This application changed while I was saving, so nothing was changed. Look at it again and ' +
    'retry.'
  );
}

function formGone(application: ApplicationRecord): string {
  return (
    `The form for application ${referenceOf(application.number)} was removed from Applications ` +
    'settings, so it can’t be reviewed here. Its answers can still be read.'
  );
}

function orphanForm(name: string): Pick<FormConfig, 'name' | 'review' | 'interview'> {
  return { name, review: reviewSchema.parse({}), interview: {} };
}

async function formNameOf(
  deps: BoundApplicationsDeps,
  application: ApplicationRecord,
  form: FormConfig | null,
): Promise<string> {
  if (form !== null) return form.name;

  const version = await deps.store.version(application.guildId, application.versionId);
  return version?.snapshot.name ?? 'Application';
}

export interface ReviewTarget {
  application: ApplicationRecord;
  form: FormConfig | null;
  formName: string;
  actor: ReviewActor;
  capabilities: ReadonlySet<Capability>;
}

interface Acting extends ReviewTarget {
  form: FormConfig;
}

type Loaded<T> = { ok: true; value: T } | { ok: false; humanReason: string; hidden?: true };

export function notOpenable(number: number): string {
  return `There’s no application #${number} you can open.`;
}

export function mayViewAny(config: ApplicationsConfig, actor: ReviewActor): boolean {
  return (
    viewableFormIds(config, actor).length > 0 ||
    capabilitiesFor(config, orphanForm('Application'), actor).has('view')
  );
}

async function loadRecord(
  ctx: Ctx,
  deps: BoundApplicationsDeps,
  actor: ReviewActor | null,
  applicationId: string | undefined,
): Promise<Loaded<ReviewTarget>> {
  if (applicationId === undefined || !APPLICATION_ID.test(applicationId)) {
    return { ok: false, humanReason: STALE_BUTTON, hidden: true };
  }

  const application = await deps.store.get(ctx.guildId, applicationId);
  if (application === null || application.number === null || application.status === 'draft') {
    return { ok: false, humanReason: STALE_BUTTON, hidden: true };
  }
  if (actor === null) return { ok: false, humanReason: NO_MEMBER };

  const form = formFor(ctx.config, application.formId) ?? null;
  const formName = await formNameOf(deps, application, form);
  const capabilities = capabilitiesFor(ctx.config, form ?? orphanForm(formName), actor);

  if (application.deletedAt !== null) {
    return capabilities.has('view')
      ? {
          ok: false,
          humanReason: `Application ${referenceOf(application.number)} was deleted, so nothing was done.`,
        }
      : { ok: false, humanReason: STALE_BUTTON, hidden: true };
  }

  return { ok: true, value: { application, form, formName, actor, capabilities } };
}

export async function loadForView(
  ctx: Ctx,
  deps: BoundApplicationsDeps,
  actor: ReviewActor | null,
  applicationId: string | undefined,
): Promise<Loaded<ReviewTarget>> {
  const loaded = await loadRecord(ctx, deps, actor, applicationId);
  if (!loaded.ok) return loaded;

  const { application, capabilities, formName } = loaded.value;
  if (!capabilities.has('view')) {
    return {
      ok: false,
      humanReason: `You aren’t on the review team for ${formName}.`,
      hidden: true,
    };
  }
  if (application.applicantId === loaded.value.actor.id && application.number !== null) {
    return { ok: false, humanReason: notOpenable(application.number), hidden: true };
  }
  return loaded;
}

async function loadForAction(
  ctx: Ctx,
  deps: BoundApplicationsDeps,
  actor: ReviewActor | null,
  applicationId: string | undefined,
  action: StaffAction,
): Promise<Loaded<Acting>> {
  const loaded = await loadRecord(ctx, deps, actor, applicationId);
  if (!loaded.ok) return loaded;

  const { application, form } = loaded.value;
  if (form === null) {
    const outsider = !loaded.value.capabilities.has('view');
    return {
      ok: false,
      humanReason: outsider
        ? `You aren’t on the review team for ${loaded.value.formName}.`
        : formGone(application),
    };
  }

  const allowed = authorizeAction({
    config: ctx.config,
    form,
    actor: loaded.value.actor,
    application,
    action,
  });
  if (!allowed.ok) {
    const humanReason =
      allowed.code === 'wrong_status' && decided(application)
        ? alreadyReviewed(application)
        : allowed.humanReason;
    return { ok: false, humanReason };
  }

  return { ok: true, value: { ...loaded.value, form } };
}

export async function privateCard(
  ctx: Ctx,
  deps: BoundApplicationsDeps,
  record: ReviewTarget,
): Promise<InteractionMessage> {
  const { application, form, formName, capabilities } = record;
  const detail = await deps.store.detail(ctx.guildId, application.id);

  const card = buildReviewCard({
    application: detail?.application ?? application,
    form: form ?? orphanForm(formName),
    formName,
    votes: voteTally(detail?.votes ?? []),
    problems: effectProblems(detail?.effects ?? []),
    dashboardUrl: deps.dashboardUrl,
    mode: form?.review.cardAnswers ?? 'summary',
    now: deps.now(),
    readOnly: form === null || !capabilities.has('review'),
    ...(form === null ? { notice: FORM_REMOVED } : {}),
  });

  return card.ok ? cardMessage(card.components) : statusMessage(errorStatus(card.humanReason));
}

interface Press {
  event: ProtonEvent;
  ctx: Ctx;
  deps: BoundApplicationsDeps;
  parsed: ProtonCustomId;
  component: ComponentInteraction | null;
  modal: ModalInteraction | null;
  interactionId: string;
  to: RespondTo;
  follow: FollowUpTo;
}

function actorOf(press: Press): ReviewActor | null {
  return reviewActorOf(press.event);
}

async function refuseNow(press: Press, humanReason: string): Promise<void> {
  await respond(press.ctx, replyEphemeral(press.to, statusMessage(errorStatus(humanReason))));
}

async function defer(press: Press): Promise<void> {
  await respond(press.ctx, deferEphemeral(press.to));
}

async function fail(press: Press, humanReason: string): Promise<void> {
  await settle(press.ctx, press.follow, statusMessage(errorStatus(humanReason)));
}

async function done(press: Press, text: string): Promise<void> {
  await settle(press.ctx, press.follow, statusMessage(successStatus(text)));
}

async function work(press: Press, result: TransitionResult, repair = false): Promise<void> {
  if (result.status !== 'done' || (result.effects.length === 0 && !repair)) return;
  await requestWork(press.ctx, press.deps, result.application.id);
}

function eventId(press: Press, applicationId: string, kind: string): string {
  return `${applicationId}:${kind}:${press.interactionId}`;
}

function audit(
  press: Press,
  actor: ReviewActor,
  verb: string,
  after: Record<string, unknown>,
): AuditInput {
  return {
    actorId: actor.id,
    source: 'command',
    action: `module.applications.${verb}`,
    id: `applications.${verb}:${press.ctx.guildId}:${press.interactionId}`,
    after,
  };
}

function plan(
  press: Press,
  form: FormConfig,
  event: ApplicationLifecycleEvent | 'card_only',
  actorId: string,
  now: number,
): PlanEffects {
  return (application, revision): EffectPlan[] =>
    planEffects(event, { config: press.ctx.config, form, application, revision, now, actorId });
}

function discordActor(actor: ReviewActor): { id: string; source: 'discord' } {
  return { id: actor.id, source: 'discord' };
}

function textField(modal: ModalInteraction, key: string): string | null {
  const value = modal.fields[key]?.trim() ?? '';
  return value === '' ? null : value;
}

function tooLong(what: string, max: number): string {
  return `${what} can be up to ${max} characters, so nothing was changed.`;
}

function joinAnd(items: readonly string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
}

function tallyText(votes: readonly Pick<VoteRecord, 'vote'>[]): string {
  const tally = voteTally(votes);
  return `${tally.accept} accept · ${tally.reject} reject`;
}

function labelled(label: string, description: string, component: Component): Component {
  return {
    type: ComponentType.Label,
    label: clip(label, LABEL_MAX),
    description: clip(description, DESCRIPTION_MAX),
    component,
  };
}

function paragraph(custom: string, max: number, required: boolean): Component {
  return {
    type: ComponentType.TextInput,
    custom_id: custom,
    style: TextInputStyle.Paragraph,
    required,
    ...(required ? { min_length: 1 } : {}),
    max_length: max,
  };
}

function scoreGroup(required: boolean): Component {
  return {
    type: ComponentType.RadioGroup,
    custom_id: REVIEW_FIELDS.score,
    required,
    options: SCORES.map((score) => ({ value: String(score), label: SCORE_LABELS[score] })),
  };
}

function modalOf(
  action: (typeof STAFF_ACTION)[keyof typeof STAFF_ACTION],
  args: string[],
  title: string,
  components: Component[],
): Modal {
  return {
    customId: customId(action, ...args),
    title: clip(title, MAX_MODAL_TITLE_LENGTH),
    components,
  };
}

export function decisionModal(input: {
  application: Pick<ApplicationRecord, 'id' | 'number'>;
  decision: 'accept' | 'reject';
  scoring: boolean;
  offerOverride: boolean;
}): Modal {
  const { application, decision } = input;
  const reference = referenceOf(application.number);

  return modalOf(
    decision === 'accept' ? STAFF_ACTION.acceptModal : STAFF_ACTION.rejectModal,
    [application.id],
    `${decision === 'accept' ? 'Accept' : 'Reject'} application ${reference}`,
    [
      labelled(
        'Reason for the applicant',
        'Optional. Sent to the applicant with the decision.',
        paragraph(REVIEW_FIELDS.reason, REASON_MAX, false),
      ),
      labelled(
        'Internal note',
        'Optional. Only the review team can read it.',
        paragraph(REVIEW_FIELDS.note, NOTE_MAX, false),
      ),
      ...(input.scoring
        ? [labelled('Score', 'Optional. 1 is the weakest, 5 the strongest.', scoreGroup(false))]
        : []),
      ...(input.offerOverride
        ? [
            labelled(
              'Decide without a second reviewer',
              'Nobody else has voted the same way yet. This is recorded in the history.',
              { type: ComponentType.Checkbox, custom_id: REVIEW_FIELDS.override },
            ),
          ]
        : []),
    ],
  );
}

function infoModal(application: ApplicationRecord): Modal {
  return modalOf(
    STAFF_ACTION.infoModal,
    [application.id],
    `Ask about application ${referenceOf(application.number)}`,
    [
      labelled(
        'What do you need to know?',
        'Sent to the applicant. They answer on their application.',
        paragraph(REVIEW_FIELDS.message, INFO_REQUEST_MAX, true),
      ),
    ],
  );
}

function waitlistModal(application: ApplicationRecord): Modal {
  return modalOf(
    STAFF_ACTION.waitlistModal,
    [application.id],
    `Waitlist application ${referenceOf(application.number)}`,
    [
      labelled(
        'Reason for the applicant',
        'Optional. Sent to the applicant.',
        paragraph(REVIEW_FIELDS.reason, REASON_MAX, false),
      ),
    ],
  );
}

function noteModal(application: ApplicationRecord): Modal {
  return modalOf(
    STAFF_ACTION.noteModal,
    [application.id],
    `Note on application ${referenceOf(application.number)}`,
    [
      labelled(
        'Note',
        'Only the review team can read notes.',
        paragraph(REVIEW_FIELDS.note, NOTE_MAX, true),
      ),
    ],
  );
}

function voteModal(application: ApplicationRecord, vote: VoteChoice): Modal {
  return modalOf(
    STAFF_ACTION.voteModal,
    [application.id, vote],
    `Vote to ${vote} application ${referenceOf(application.number)}`,
    [labelled('Your score', '1 is the weakest, 5 the strongest.', scoreGroup(true))],
  );
}

async function openWith(press: Press, build: () => Modal): Promise<void> {
  let modal: Modal;
  try {
    modal = build();
  } catch (error) {
    if (error instanceof CustomIdTooLongError) return refuseNow(press, error.message);
    throw error;
  }
  await respond(press.ctx, openModal(press.to, modal));
}

function whoCanVote(config: ApplicationsConfig, form: FormConfig): string {
  const team = teamFor(config, form);
  const roleIds = [...new Set([...team.reviewerRoleIds, ...team.deciderRoleIds])];
  if (roleIds.length === 0) {
    return 'Only server admins are on its review team, so another admin has to vote.';
  }
  const roles = joinAnd(roleIds.map((roleId) => `<@&${roleId}>`));
  return `Anyone else with ${roles} can vote from **More actions** on the card.`;
}

export function twoReviewerText(input: {
  config: ApplicationsConfig;
  form: FormConfig;
  humanReason: string;
  votes: readonly VoteRecord[];
  deciderId: string;
  applicantId: string;
  canOverride: boolean;
}): string {
  const { votes, deciderId, applicantId } = input;
  const others = votes.filter(
    (vote) => vote.reviewerId !== deciderId && vote.reviewerId !== applicantId,
  );

  const lines = [input.humanReason, whoCanVote(input.config, input.form)];
  if (others.length > 0) {
    lines.push(
      `Votes so far: ${others.map((vote) => `${actorMention(vote.reviewerId)} ${vote.vote}`).join(', ')}.`,
    );
  }
  if (input.canOverride) lines.push('You can also decide without them from the decision form.');
  return lines.join(' ');
}

async function within<T>(work: Promise<T>, ms: number, late: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(late), ms);
  });
  try {
    return await Promise.race([work, expired]);
  } finally {
    clearTimeout(timer);
  }
}

async function standingVotes(
  press: Press,
  form: FormConfig,
  application: ApplicationRecord,
  deciderId: string,
  budgetMs?: number,
): Promise<VoteRecord[]> {
  const { ctx, deps } = press;
  const votes = await deps.store.votes(ctx.guildId, application.id);
  const others = votes.filter(
    (vote) => vote.reviewerId !== deciderId && vote.reviewerId !== application.applicantId,
  );

  const standing = new Set<string>();
  await Promise.all(
    [...new Set(others.map((vote) => vote.reviewerId))].map(async (voterId) => {
      const read = reviewActorFor(deps, ctx.guildId, voterId);
      const voter = budgetMs === undefined ? await read : await within(read, budgetMs, null);
      if (voter !== null && capabilitiesFor(ctx.config, form, voter).has('review')) {
        standing.add(voterId);
      }
    }),
  );
  return others.filter((vote) => standing.has(vote.reviewerId));
}

async function openDecision(press: Press, decision: 'accept' | 'reject'): Promise<void> {
  const { ctx, deps } = press;
  const loaded = await loadForAction(ctx, deps, actorOf(press), press.parsed.args[0], decision);
  if (!loaded.ok) return refuseNow(press, loaded.humanReason);

  const { application, form, actor, capabilities } = loaded.value;
  let offerOverride = false;

  if (form.review.requireTwoReviewers) {
    // A modal can't wait for a deferral, so a voter who can't be read in time doesn't count.
    const votes = await standingVotes(press, form, application, actor.id, VOTER_BUDGET_MS);
    const check = twoReviewerCheck({
      form,
      decision,
      deciderId: actor.id,
      votes,
      applicantId: application.applicantId,
    });
    if (!check.ok) {
      if (!capabilities.has('override')) {
        return refuseNow(
          press,
          twoReviewerText({
            config: ctx.config,
            form,
            humanReason: check.humanReason,
            votes,
            deciderId: actor.id,
            applicantId: application.applicantId,
            canOverride: false,
          }),
        );
      }
      offerOverride = true;
    }
  }

  await openWith(press, () =>
    decisionModal({ application, decision, scoring: form.review.scoring, offerOverride }),
  );
}

type DecisionInput =
  | {
      ok: true;
      reason: string | null;
      note: string | null;
      score: number | null;
      override: boolean;
    }
  | { ok: false; humanReason: string };

function readScore(raw: string | undefined): number | null | undefined {
  const value = raw?.trim() ?? '';
  if (value === '') return null;
  return /^[1-5]$/.test(value) ? Number(value) : undefined;
}

function readDecision(modal: ModalInteraction, form: FormConfig): DecisionInput {
  const reason = textField(modal, REVIEW_FIELDS.reason);
  if (reason !== null && reason.length > REASON_MAX) {
    return { ok: false, humanReason: tooLong('The reason for the applicant', REASON_MAX) };
  }

  const note = textField(modal, REVIEW_FIELDS.note);
  if (note !== null && note.length > NOTE_MAX) {
    return { ok: false, humanReason: tooLong('The internal note', NOTE_MAX) };
  }

  const score = form.review.scoring ? readScore(modal.fields[REVIEW_FIELDS.score]) : null;
  if (score === undefined) {
    return {
      ok: false,
      humanReason: 'A score is a whole number from 1 to 5. Nothing was changed.',
    };
  }

  return { ok: true, reason, note, score, override: modal.checks[REVIEW_FIELDS.override] === true };
}

function decidedText(
  application: ApplicationRecord,
  decision: 'accept' | 'reject',
  effects: readonly EffectRecord[],
  override: boolean,
): string {
  const reference = referenceOf(application.number);
  const parts = [
    decision === 'accept'
      ? `Accepted application ${reference}.`
      : `Rejected application ${reference}.`,
  ];
  if (override) parts.push('It’s recorded as deciding without a second reviewer.');

  const doing: string[] = [];
  if (effects.some((effect) => effect.kind === 'dm')) doing.push('DMing the applicant');
  if (effects.some((effect) => effect.kind === 'add_role' || effect.kind === 'remove_role')) {
    doing.push('updating their roles');
  }
  if (effects.some((effect) => effect.kind === 'xp')) doing.push('giving the XP reward');
  if (doing.length > 0) {
    parts.push(
      `I’m ${joinAnd(doing)} now. Anything that fails shows on the card and in the dashboard.`,
    );
  }

  return parts.join(' ');
}

async function recordOverride(
  press: Press,
  application: ApplicationRecord,
  decision: 'accept' | 'reject',
  actor: ReviewActor,
  now: number,
): Promise<void> {
  try {
    await press.deps.store.transition({
      guildId: press.ctx.guildId,
      applicationId: application.id,
      action: decision,
      actor: discordActor(actor),
      expect: { statuses: [application.status] },
      patch: {},
      event: {
        kind: 'override_two_reviewers',
        id: eventId(press, application.id, 'override_two_reviewers'),
        data: { decision },
      },
      audit: audit(press, actor, 'override_two_reviewers', { decision }),
      bumpRevision: false,
      now,
    });
  } catch (error) {
    press.ctx.logger.error('applications could not record a two-reviewer override', {
      guildId: press.ctx.guildId,
      moduleId: MODULE_ID,
      applicationId: application.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function repeated(
  press: Press,
  userId: string,
  decision: 'accept' | 'reject',
): Promise<boolean> {
  const applicationId = press.parsed.args[0];
  if (applicationId === undefined || !APPLICATION_ID.test(applicationId)) return false;

  const current = await press.deps.store.get(press.ctx.guildId, applicationId);
  const status = decision === 'accept' ? 'accepted' : 'rejected';
  if (current === null || current.deletedAt !== null) return false;
  if (current.status !== status || current.decidedBy !== userId) return false;

  await done(
    press,
    `You already ${status} application ${referenceOf(current.number)}. Nothing else was changed.`,
  );
  await work(press, { status: 'done', application: current, effects: [] }, true);
  return true;
}

async function decide(
  press: Press,
  modal: ModalInteraction,
  decision: 'accept' | 'reject',
): Promise<void> {
  const { ctx, deps } = press;
  await defer(press);

  const loaded = await loadForAction(ctx, deps, actorOf(press), press.parsed.args[0], decision);
  if (!loaded.ok) {
    if (await repeated(press, modal.userId, decision)) return;
    return fail(press, loaded.humanReason);
  }
  const { application, form, actor, capabilities } = loaded.value;

  const input = readDecision(modal, form);
  if (!input.ok) return fail(press, input.humanReason);

  let override = false;
  if (form.review.requireTwoReviewers) {
    const votes = await standingVotes(press, form, application, actor.id);
    const check = twoReviewerCheck({
      form,
      decision,
      deciderId: actor.id,
      votes,
      applicantId: application.applicantId,
    });
    if (!check.ok) {
      const canOverride = capabilities.has('override');
      if (!canOverride || !input.override) {
        return fail(
          press,
          twoReviewerText({
            config: ctx.config,
            form,
            humanReason: check.humanReason,
            votes,
            deciderId: actor.id,
            applicantId: application.applicantId,
            canOverride,
          }),
        );
      }
      override = true;
    }
  }

  const now = deps.now();
  const lifecycle = decision === 'accept' ? 'applications.accepted' : 'applications.rejected';
  const kind = decision === 'accept' ? 'accepted' : 'rejected';

  const result = await deps.store.transition({
    guildId: ctx.guildId,
    applicationId: application.id,
    action: decision,
    actor: discordActor(actor),
    expect: {
      statuses: allowedFrom(decision),
      ...(form.review.requireTwoReviewers ? { revision: application.revision } : {}),
    },
    patch: {
      status: kind,
      decidedAt: now,
      decidedBy: actor.id,
      decisionReason: input.reason,
      contentPurgeAt: now + ctx.config.retentionDays * DAY_MS,
      infoDueAt: null,
    },
    ...(input.reason === null ? {} : { thread: { kind: 'decision' as const, body: input.reason } }),
    ...(input.note === null ? {} : { note: { body: input.note } }),
    vote: { vote: decision, score: input.score },
    event: {
      kind,
      id: eventId(press, application.id, kind),
      lifecycle,
      data: {
        reasonLength: input.reason?.length ?? 0,
        noteLength: input.note?.length ?? 0,
        ...(input.score === null ? {} : { score: input.score }),
        ...(override ? { override: 'two_reviewers' } : {}),
      },
    },
    plan: plan(press, form, lifecycle, actor.id, now),
    audit: audit(press, actor, decision, {
      status: kind,
      reasonLength: input.reason?.length ?? 0,
      noteLength: input.note?.length ?? 0,
      override,
    }),
    now,
  });

  if (result.status === 'stale') return fail(press, staleText(result.application));
  if (override) await recordOverride(press, result.application, decision, actor, now);

  await done(press, decidedText(result.application, decision, result.effects, override));
  await work(press, result);
}

async function claim(press: Press): Promise<void> {
  const { ctx, deps } = press;
  await defer(press);

  const loaded = await loadForAction(ctx, deps, actorOf(press), press.parsed.args[0], 'claim');
  if (!loaded.ok) return fail(press, loaded.humanReason);
  const { application, form, actor } = loaded.value;
  const reference = referenceOf(application.number);

  if (application.assigneeId === actor.id) {
    return done(press, `You’ve already claimed application ${reference}.`);
  }
  if (application.assigneeId !== null) {
    return fail(
      press,
      `${actorMention(application.assigneeId)} has already claimed application ${reference}. ` +
        'Ask them to unclaim it, or reassign it in the dashboard.',
    );
  }

  const now = deps.now();
  const to = nextStatus('claim', application.status, true) ?? 'in_review';
  const lifecycle = lifecycleEventFor('claim', application.status, to);

  const result = await deps.store.transition({
    guildId: ctx.guildId,
    applicationId: application.id,
    action: 'claim',
    actor: discordActor(actor),
    expect: { statuses: allowedFrom('claim'), assigneeId: null },
    patch: {
      status: to,
      assigneeId: actor.id,
      assignedAt: now,
      ...(to === 'in_review' && application.reviewStartedAt === null
        ? { reviewStartedAt: now }
        : {}),
    },
    event: {
      kind: 'claimed',
      id: eventId(press, application.id, 'claimed'),
      lifecycle: lifecycle ?? undefined,
    },
    plan: plan(press, form, lifecycle ?? 'card_only', actor.id, now),
    audit: audit(press, actor, 'claim', { status: to }),
    now,
  });

  if (result.status === 'stale') {
    const fresh = result.application;
    if (fresh !== null && fresh.assigneeId !== null && fresh.assigneeId !== actor.id) {
      return fail(
        press,
        `${actorMention(fresh.assigneeId)} claimed application ${reference} first.`,
      );
    }
    return fail(press, staleText(fresh));
  }

  await done(press, `You claimed application ${reference}.`);
  await work(press, result);
}

async function unclaim(press: Press): Promise<void> {
  const { ctx, deps } = press;
  await defer(press);

  const loaded = await loadForAction(ctx, deps, actorOf(press), press.parsed.args[0], 'unclaim');
  if (!loaded.ok) return fail(press, loaded.humanReason);
  const { application, form, actor, capabilities } = loaded.value;
  const reference = referenceOf(application.number);

  if (application.assigneeId !== actor.id && !capabilities.has('decide')) {
    return fail(
      press,
      `Only ${actorMention(application.assigneeId)} or a decider can unclaim application ${reference}.`,
    );
  }

  const now = deps.now();
  const result = await deps.store.transition({
    guildId: ctx.guildId,
    applicationId: application.id,
    action: 'unclaim',
    actor: discordActor(actor),
    expect: { statuses: allowedFrom('unclaim'), assigneeId: application.assigneeId },
    patch: { status: 'submitted', assigneeId: null, assignedAt: null },
    event: {
      kind: 'unclaimed',
      id: eventId(press, application.id, 'unclaimed'),
      data: application.assigneeId === actor.id ? {} : { from: application.assigneeId },
    },
    plan: plan(press, form, 'card_only', actor.id, now),
    audit: audit(press, actor, 'unclaim', { status: 'submitted' }),
    now,
  });

  if (result.status === 'stale') return fail(press, staleText(result.application));

  await done(press, `Unclaimed application ${reference}. It’s back in the queue.`);
  await work(press, result);
}

async function recordVote(press: Press, vote: VoteChoice, score: number | null): Promise<void> {
  const { ctx, deps } = press;
  const loaded = await loadForAction(ctx, deps, actorOf(press), press.parsed.args[0], 'vote');
  if (!loaded.ok) return fail(press, loaded.humanReason);
  const { application, form, actor } = loaded.value;
  const reference = referenceOf(application.number);

  const before = await deps.store.votes(ctx.guildId, application.id);
  const mine = before.find((cast) => cast.reviewerId === actor.id);
  if (mine !== undefined && mine.vote === vote && mine.score === score) {
    return done(
      press,
      `You’ve already voted to ${vote} application ${reference}. Votes so far: ${tallyText(before)}.`,
    );
  }

  const now = deps.now();
  const result = await deps.store.transition({
    guildId: ctx.guildId,
    applicationId: application.id,
    action: 'vote',
    actor: discordActor(actor),
    expect: { statuses: allowedFrom('vote') },
    patch: {},
    vote: { vote, score },
    event: {
      kind: 'voted',
      id: eventId(press, application.id, 'voted'),
      data: { vote, ...(score === null ? {} : { score }) },
    },
    plan: plan(press, form, 'card_only', actor.id, now),
    audit: audit(press, actor, 'vote', { vote, ...(score === null ? {} : { score }) }),
    now,
  });

  if (result.status === 'stale') return fail(press, staleText(result.application));

  const after = await deps.store.votes(ctx.guildId, application.id);
  const scored = score === null ? '' : ` with a score of ${score}`;
  await done(
    press,
    `Your vote to ${vote} application ${reference}${scored} is in. Votes so far: ` +
      `${tallyText(after)}. Votes inform the decision; they don’t make it.`,
  );
  await work(press, result);
}

async function vote(press: Press, choice: VoteChoice): Promise<void> {
  const { ctx, deps } = press;
  const loaded = await loadForAction(ctx, deps, actorOf(press), press.parsed.args[0], 'vote');
  if (!loaded.ok) return refuseNow(press, loaded.humanReason);

  const { application, form } = loaded.value;
  if (form.review.scoring) return openWith(press, () => voteModal(application, choice));

  await defer(press);
  await recordVote(press, choice, null);
}

async function voteSubmit(press: Press, modal: ModalInteraction): Promise<void> {
  await defer(press);

  const choice = press.parsed.args[1];
  if (choice !== 'accept' && choice !== 'reject') return fail(press, UNKNOWN_PRESS);

  const score = readScore(modal.fields[REVIEW_FIELDS.score]);
  if (score === undefined || score === null) {
    return fail(press, 'Choose a score from 1 to 5, then vote again. Nothing was changed.');
  }

  await recordVote(press, choice, score);
}

async function openSimple(
  press: Press,
  action: StaffAction,
  build: (application: ApplicationRecord) => Modal,
): Promise<void> {
  const { ctx, deps } = press;
  const loaded = await loadForAction(ctx, deps, actorOf(press), press.parsed.args[0], action);
  if (!loaded.ok) return refuseNow(press, loaded.humanReason);

  const { application } = loaded.value;
  await openWith(press, () => build(application));
}

async function requestInfo(press: Press, modal: ModalInteraction): Promise<void> {
  const { ctx, deps } = press;
  await defer(press);

  const loaded = await loadForAction(
    ctx,
    deps,
    actorOf(press),
    press.parsed.args[0],
    'request_info',
  );
  if (!loaded.ok) return fail(press, loaded.humanReason);
  const { application, form, actor } = loaded.value;

  const message = textField(modal, REVIEW_FIELDS.message);
  if (message === null) return fail(press, INFO_EMPTY);
  if (message.length > INFO_REQUEST_MAX) {
    return fail(press, tooLong('A question for the applicant', INFO_REQUEST_MAX));
  }

  const now = deps.now();
  const days = ctx.config.followUpDeadlineDays;
  const due = days > 0 ? now + days * DAY_MS : null;
  const lifecycle = 'applications.information_requested';

  const result = await deps.store.transition({
    guildId: ctx.guildId,
    applicationId: application.id,
    action: 'request_info',
    actor: discordActor(actor),
    expect: { statuses: allowedFrom('request_info') },
    patch: { status: 'needs_info', infoRequestedAt: now, infoDueAt: due },
    thread: { kind: 'info_request', body: message },
    event: {
      kind: 'information_requested',
      id: eventId(press, application.id, 'information_requested'),
      lifecycle,
      data: { length: message.length },
    },
    plan: plan(press, form, lifecycle, actor.id, now),
    audit: audit(press, actor, 'request_info', { status: 'needs_info', length: message.length }),
    now,
  });

  if (result.status === 'stale') return fail(press, staleText(result.application));

  const parts = [
    `Asked ${actorMention(application.applicantId)} for more information on application ` +
      `${referenceOf(application.number)}.`,
  ];
  if (due !== null) parts.push(`They have until <t:${Math.floor(due / 1000)}:f> to answer.`);
  if (result.effects.some((effect) => effect.kind === 'dm')) {
    parts.push('I’m sending the question by DM as well.');
  }
  parts.push('They can answer from My applications or their application’s status page.');

  await done(press, parts.join(' '));
  await work(press, result);
}

async function waitlist(press: Press, modal: ModalInteraction): Promise<void> {
  const { ctx, deps } = press;
  await defer(press);

  const loaded = await loadForAction(ctx, deps, actorOf(press), press.parsed.args[0], 'waitlist');
  if (!loaded.ok) return fail(press, loaded.humanReason);
  const { application, form, actor } = loaded.value;

  const reason = textField(modal, REVIEW_FIELDS.reason);
  if (reason !== null && reason.length > REASON_MAX) {
    return fail(press, tooLong('The reason for the applicant', REASON_MAX));
  }

  const now = deps.now();
  const lifecycle = 'applications.waitlisted';
  const result = await deps.store.transition({
    guildId: ctx.guildId,
    applicationId: application.id,
    action: 'waitlist',
    actor: discordActor(actor),
    expect: { statuses: allowedFrom('waitlist') },
    patch: { status: 'waitlisted', waitlistedAt: now, decisionReason: reason, infoDueAt: null },
    ...(reason === null ? {} : { thread: { kind: 'decision' as const, body: reason } }),
    event: {
      kind: 'waitlisted',
      id: eventId(press, application.id, 'waitlisted'),
      lifecycle,
      data: { reasonLength: reason?.length ?? 0 },
    },
    plan: plan(press, form, lifecycle, actor.id, now),
    audit: audit(press, actor, 'waitlist', {
      status: 'waitlisted',
      reasonLength: reason?.length ?? 0,
    }),
    now,
  });

  if (result.status === 'stale') return fail(press, staleText(result.application));

  const told = result.effects.some((effect) => effect.kind === 'dm')
    ? ' I’m letting the applicant know by DM.'
    : '';
  await done(press, `Waitlisted application ${referenceOf(application.number)}.${told}`);
  await work(press, result);
}

async function addNote(press: Press, modal: ModalInteraction): Promise<void> {
  const { ctx, deps } = press;
  await defer(press);

  const loaded = await loadForAction(ctx, deps, actorOf(press), press.parsed.args[0], 'note');
  if (!loaded.ok) return fail(press, loaded.humanReason);
  const { application, actor } = loaded.value;

  const body = textField(modal, REVIEW_FIELDS.note);
  if (body === null) return fail(press, NOTE_EMPTY);
  if (body.length > NOTE_MAX) return fail(press, tooLong('A note', NOTE_MAX));

  const result = await deps.store.transition({
    guildId: ctx.guildId,
    applicationId: application.id,
    action: 'note',
    actor: discordActor(actor),
    expect: { statuses: allowedFrom('note') },
    patch: {},
    note: { body },
    event: {
      kind: 'note',
      id: eventId(press, application.id, 'note'),
      data: { length: body.length },
    },
    audit: audit(press, actor, 'note', { length: body.length }),
    bumpRevision: false,
    now: deps.now(),
  });

  if (result.status === 'stale') return fail(press, staleText(result.application));

  await done(
    press,
    `Added a note to application ${referenceOf(application.number)}. Only the review team can ` +
      'read it.',
  );
}

async function ticketsOn(press: Press): Promise<boolean | null> {
  const { availability } = press.deps;
  if (availability === null) return null;

  try {
    return await availability.isEnabled(press.ctx.guildId, 'tickets');
  } catch {
    return null;
  }
}

async function openTicket(press: Press): Promise<void> {
  const { ctx, deps } = press;
  await defer(press);

  const loaded = await loadForAction(
    ctx,
    deps,
    actorOf(press),
    press.parsed.args[0],
    'open_ticket',
  );
  if (!loaded.ok) return fail(press, loaded.humanReason);
  const { application, form, actor } = loaded.value;

  const typeId = form.interview.ticketTypeId;
  if (typeId === undefined) {
    return fail(
      press,
      `${form.name} has no interview ticket type. A server admin can choose one in the form’s ` +
        'review settings in the dashboard.',
    );
  }

  const on = await ticketsOn(press);
  if (on === false) return fail(press, TICKETS_OFF);
  if (on === null) return fail(press, TICKETS_UNKNOWN);

  const now = deps.now();
  const result = await deps.store.transition({
    guildId: ctx.guildId,
    applicationId: application.id,
    action: 'open_ticket',
    actor: discordActor(actor),
    expect: { statuses: allowedFrom('open_ticket') },
    patch: {},
    event: {
      kind: 'ticket_requested',
      id: eventId(press, application.id, 'ticket_requested'),
      data: { typeId },
    },
    plan: (next, revision) =>
      planTicket({
        config: ctx.config,
        form,
        application: next,
        revision,
        now,
        actorId: actor.id,
      }),
    audit: audit(press, actor, 'open_ticket', { typeId }),
    now,
  });

  if (result.status === 'stale') return fail(press, staleText(result.application));

  const existing = application.interviewChannelId;
  await done(
    press,
    existing === null
      ? `Opening an interview ticket with ${actorMention(application.applicantId)}. It shows on ` +
          'the card once Tickets has made it.'
      : `Asked Tickets to reopen the interview ticket <#${existing}> with ` +
          `${actorMention(application.applicantId)}, or open a new one.`,
  );
  await work(press, result);
}

function pageOf(raw: string | undefined): number {
  const page = Number(raw ?? '0');
  return Number.isSafeInteger(page) && page >= 0 ? page : 0;
}

function pagerButton(label: string, applicationId: string, page: number, off: boolean): Component {
  return {
    type: ComponentType.Button,
    style: ButtonStyle.Secondary,
    label,
    custom_id: customId(STAFF_ACTION.read, applicationId, String(page)),
    ...(off ? { disabled: true } : {}),
  };
}

export function answersScreen(input: {
  application: ApplicationRecord;
  formName: string;
  pages: readonly string[];
  page: number;
}): Component[] {
  const { application, pages } = input;
  const last = Math.max(0, pages.length - 1);
  const page = Math.min(Math.max(0, input.page), last);

  const heading = `## ${clip(input.formName, NAME_SHOWN_MAX)} ${referenceOf(application.number)}`;
  const where = pages.length > 1 ? `\n-# Answers, page ${page + 1} of ${pages.length}` : '';

  const children: Component[] = [
    { type: ComponentType.TextDisplay, content: `${heading.trim()}${where}` },
    { type: ComponentType.Separator, divider: true, spacing: 1 },
    { type: ComponentType.TextDisplay, content: pages[page] ?? 'No questions were answered.' },
  ];

  if (pages.length > 1) {
    children.push({
      type: ComponentType.ActionRow,
      components: [
        pagerButton('Previous', application.id, Math.max(0, page - 1), page === 0),
        pagerButton('Next', application.id, Math.min(last, page + 1), page === last),
      ],
    });
  }

  return [
    {
      type: ComponentType.Container,
      accent_color: STATUS_ACCENTS[application.status],
      components: children,
    },
  ];
}

// Only the pager carries a page, and only it may replace the message it sits on.
async function readAnswers(press: Press, rawPage: string | undefined): Promise<void> {
  const { ctx, deps, component } = press;
  const flags = component?.messageFlags ?? null;
  const inPlace = rawPage !== undefined && flags !== null && (flags & MESSAGE_FLAG_EPHEMERAL) !== 0;

  await respond(ctx, inPlace ? deferUpdate(press.to) : deferEphemeral(press.to));

  const refuse = async (humanReason: string): Promise<void> => {
    if (!inPlace) return fail(press, humanReason);
    await respond(
      ctx,
      followUp(press.follow, { ...statusMessage(errorStatus(humanReason)), ephemeral: true }),
    );
  };

  const loaded = await loadForView(ctx, deps, actorOf(press), press.parsed.args[0]);
  if (!loaded.ok) return refuse(loaded.humanReason);
  const { application, formName } = loaded.value;

  if (application.answers === null) {
    const when =
      application.contentPurgedAt === null ? '' : ` ${relative(application.contentPurgedAt)}`;
    return refuse(
      `The answers to application ${referenceOf(application.number)} were removed${when}, after ` +
        'this server’s keep-for period.',
    );
  }

  let screen: Component[];
  try {
    screen = answersScreen({
      application,
      formName,
      pages: answerPages(application.answers),
      page: pageOf(rawPage),
    });
  } catch (error) {
    if (error instanceof CustomIdTooLongError) return refuse(error.message);
    throw error;
  }

  await settle(ctx, press.follow, cardMessage(screen));
}

async function showCard(press: Press): Promise<void> {
  const { ctx, deps } = press;
  await defer(press);

  const loaded = await loadForView(ctx, deps, actorOf(press), press.parsed.args[0]);
  if (!loaded.ok) return fail(press, loaded.humanReason);

  await settle(ctx, press.follow, await privateCard(ctx, deps, loaded.value));
}

async function onMore(press: Press, choice: string | undefined): Promise<void> {
  switch (choice) {
    case MORE_CHOICES.info:
      return openSimple(press, 'request_info', infoModal);
    case MORE_CHOICES.waitlist:
      return openSimple(press, 'waitlist', waitlistModal);
    case MORE_CHOICES.note:
      return openSimple(press, 'note', noteModal);
    case MORE_CHOICES.voteAccept:
      return vote(press, 'accept');
    case MORE_CHOICES.voteReject:
      return vote(press, 'reject');
    case MORE_CHOICES.ticket:
      return openTicket(press);
    case MORE_CHOICES.read:
      return readAnswers(press, undefined);
    default:
      return refuseNow(press, UNKNOWN_PRESS);
  }
}

async function onComponent(press: Press, component: ComponentInteraction): Promise<void> {
  switch (press.parsed.action) {
    case STAFF_ACTION.claim:
      return claim(press);
    case STAFF_ACTION.unclaim:
      return unclaim(press);
    case STAFF_ACTION.accept:
      return openDecision(press, 'accept');
    case STAFF_ACTION.reject:
      return openDecision(press, 'reject');
    case STAFF_ACTION.more:
      return onMore(press, component.values[0]);
    case STAFF_ACTION.read:
      return readAnswers(press, press.parsed.args[1]);
    case STAFF_ACTION.card:
      return showCard(press);
    default:
      return refuseNow(press, UNKNOWN_PRESS);
  }
}

async function onModal(press: Press, modal: ModalInteraction): Promise<void> {
  switch (press.parsed.action) {
    case STAFF_ACTION.acceptModal:
      return decide(press, modal, 'accept');
    case STAFF_ACTION.rejectModal:
      return decide(press, modal, 'reject');
    case STAFF_ACTION.infoModal:
      return requestInfo(press, modal);
    case STAFF_ACTION.waitlistModal:
      return waitlist(press, modal);
    case STAFF_ACTION.noteModal:
      return addNote(press, modal);
    case STAFF_ACTION.voteModal:
      return voteSubmit(press, modal);
    default:
      return refuseNow(press, UNKNOWN_PRESS);
  }
}

export async function handleStaffInteraction(
  event: ProtonEvent,
  ctx: Ctx,
  deps: BoundApplicationsDeps,
  parsed: ProtonCustomId,
): Promise<void> {
  if (parsed.moduleId !== MODULE_ID) return;

  const component = event.type === 'interaction.component' ? readComponentInteraction(event) : null;
  const modal = event.type === 'interaction.modal' ? readModalInteraction(event) : null;
  const facts = component ?? modal;
  if (facts === null) return;

  const to: RespondTo = {
    guildId: ctx.guildId,
    moduleId: MODULE_ID,
    actorId: facts.userId,
    interaction: interactionRef(facts),
    idempotencyKey: `${MODULE_ID}:${event.id}`,
  };
  const press: Press = {
    event,
    ctx,
    deps,
    parsed,
    component,
    modal,
    interactionId: facts.interactionId,
    to,
    follow: { ...to, applicationId: facts.applicationId ?? deps.applicationId },
  };

  if (!ctx.config.enabled) return refuseNow(press, MODULE_OFF);

  if (component !== null) return onComponent(press, component);
  if (modal !== null) return onModal(press, modal);
}
