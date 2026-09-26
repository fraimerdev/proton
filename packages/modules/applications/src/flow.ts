import {
  type ActionRequest,
  type ActionResult,
  deferEphemeral,
  deferUpdate,
  editOriginal,
  errorStatus,
  type FollowUpTo,
  followUp,
  type InteractionBase,
  type InteractionMessage,
  interactionRef,
  labelOf,
  MESSAGE_FLAG_EPHEMERAL,
  MESSAGE_FLAG_IS_COMPONENTS_V2,
  type MemberContext,
  type ModuleContext,
  openModal,
  type ProtonCustomId,
  type ProtonEvent,
  type RespondTo,
  readComponentInteraction,
  readModalInteraction,
  replyEphemeral,
  type StatusBody,
} from '@proton/core';
import { ButtonStyle } from 'discord-api-types/v10';
import { answerPages } from './answers-view.ts';
import { type ApplicationsConfig, type FormConfig, formFor, type Section } from './config.ts';
import { MODULE_ID, SLUG } from './constants.ts';
import type { BoundApplicationsDeps } from './deps.ts';
import { planEffects } from './effects.ts';
import type { Eligibility } from './eligibility.ts';
import { intakeSentence, intakeState, whoCanRead } from './intake.ts';
import { APPLICANT_ACTION, customId } from './interface.ts';
import { applicantNameOf, eligibilityFor, memberContextOf } from './member.ts';
import {
  buildRespondModal,
  buildStepModal,
  type ModalAnswers,
  readResponse,
  readStepAnswers,
} from './modal.ts';
import {
  answerButton,
  answersScreen,
  button,
  buttonRows,
  type Component,
  cancelConfirmScreen,
  conflictScreen,
  FRESH_START,
  type MineEntry,
  mineButton,
  mineScreen,
  noticeScreen,
  overviewScreen,
  reviewBudget,
  reviewButton,
  reviewScreen,
  sentScreen,
  startButton,
  statusScreen,
  stepButton,
  stepScreen,
  timestamp,
  v2Message,
  viewButton,
  withdrawButton,
  withdrawConfirmScreen,
} from './overview.ts';
import {
  type AnswerProblem,
  checkAnswers,
  type DraftAnswers,
  type Step,
  stepsFor,
} from './questions.ts';
import { requestWork } from './runner.ts';
import { ACTIVE_STATUSES, isActive, nextStatus, STATUS_LABELS } from './status.ts';
import type { ApplicationRecord, FormVersionRecord, SubmitResult } from './store.ts';
import { canRespond, canWithdraw, DAY_MS, dayCount, referenceOf } from './web.ts';

const HOUR_MS = 60 * 60 * 1000;
const MODAL_BUDGET_MS = 2_500;
const ANSWER = 'answer';

const APPLICATION_ID = /^[A-Za-z0-9_-]{1,64}$/;
const INDEX = /^\d{1,3}$/;
const REVISION = /^\d{1,10}$/;

const KEEPABLE: ReadonlySet<string> = new Set([
  'closed',
  'not_yet_open',
  'deadline_passed',
  'full',
]);
const DECIDED: ReadonlySet<string> = new Set(['accepted', 'rejected', 'waitlisted']);

const FORM_GONE =
  'That form no longer exists in this server. Ask a server admin to post the application panel again.';
const NOT_YOURS = 'This application belongs to someone else, so I can’t open it for you.';
const OUTDATED = 'This button is out of date. Open the application panel again.';
const NOT_WAITING = 'Staff aren’t waiting for an answer on this application any more.';
const RESTARTED =
  'Your saved answers were cleared because this form changed after you started. Start again to apply.';
const VERSION_GONE =
  'I can’t find the version of this form your answers belong to. Start again from the application panel.';

type Acked = 'none' | 'update' | 'ephemeral';

interface Facts extends InteractionBase {
  customId: string;
  values: string[];
  modal: ModalAnswers | null;
  messageId: string | null;
  privateSource: boolean;
}

interface Press {
  event: ProtonEvent;
  ctx: ModuleContext<ApplicationsConfig>;
  deps: BoundApplicationsDeps;
  facts: Facts;
  to: RespondTo;
  follow: FollowUpTo;
  acked: Acked;
  now: number;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function sourceFlags(event: ProtonEvent): number {
  const flags = record(record(event.payload)?.message)?.flags;
  return typeof flags === 'number' ? flags : 0;
}

function readFacts(event: ProtonEvent): Facts | null {
  if (event.type === 'interaction.modal') {
    const modal = readModalInteraction(event);
    if (!modal) return null;
    return {
      ...modal,
      values: [],
      modal: { fields: modal.fields, values: modal.values, checks: modal.checks },
      privateSource:
        modal.messageId !== null && (sourceFlags(event) & MESSAGE_FLAG_EPHEMERAL) !== 0,
    };
  }

  const component = readComponentInteraction(event);
  if (!component) return null;
  return {
    ...component,
    modal: null,
    privateSource: ((component.messageFlags ?? 0) & MESSAGE_FLAG_EPHEMERAL) !== 0,
  };
}

function failed(result: ActionResult): boolean {
  return result.status === 'failed_precheck' || result.status === 'failed_api';
}

function codeOf(error: unknown): string | null {
  for (let at: unknown = error, depth = 0; at && depth < 5; depth += 1) {
    const code = (at as { code?: unknown }).code;
    if (typeof code === 'string') return code;
    at = (at as { cause?: unknown }).cause;
  }
  return null;
}

// First line only: a failed query's later lines list its parameters, which can be answers.
export function errorSummary(error: unknown): string {
  if (!(error instanceof Error)) return 'a non-error value was thrown';
  const line = (error.message.split('\n')[0] ?? '').slice(0, 200);
  const code = codeOf(error);
  return `${error.name}: ${line}${code === null ? '' : ` (code ${code})`}`;
}

async function run(press: Press, request: ActionRequest, what: string): Promise<ActionResult> {
  const result = await press.ctx.executor.execute(request);
  if (failed(result)) {
    press.ctx.logger.warn(
      `applications could not ${what}: ${result.failure?.humanReason ?? 'unknown reason'}`,
      { guildId: press.ctx.guildId, moduleId: MODULE_ID, code: result.failure?.code },
    );
  }
  return result;
}

async function ack(press: Press): Promise<void> {
  if (press.acked !== 'none') return;

  if (press.facts.privateSource) {
    press.acked = 'update';
    await run(press, deferUpdate(press.to), 'acknowledge a press');
    return;
  }

  press.acked = 'ephemeral';
  await run(press, deferEphemeral(press.to), 'acknowledge a press');
}

// One key for every final answer, so a redelivered event can only repeat what was already said.
async function answer(press: Press, message: InteractionMessage): Promise<void> {
  if (press.acked === 'none') {
    await run(press, replyEphemeral(press.to, message), 'answer a press');
    return;
  }

  const v2 = ((message.flags ?? 0) & MESSAGE_FLAG_IS_COMPONENTS_V2) !== 0;
  if (press.acked === 'update' && !v2) {
    await run(press, followUp(press.follow, { ...message, ephemeral: true }, ANSWER), 'answer');
    return;
  }

  const edited = await press.ctx.executor.execute(editOriginal(press.follow, message, ANSWER));
  if (!failed(edited)) return;

  await run(press, followUp(press.follow, { ...message, ephemeral: true }, ANSWER), 'answer');
}

function screen(press: Press, components: Component[]): Promise<void> {
  return answer(press, v2Message(components));
}

export function offSentence(
  guildId: string,
  dashboardUrl: string | undefined,
  what = 'this button doesn’t work',
): string {
  const base = dashboardUrl?.replace(/\/$/, '');
  const where =
    base === undefined || base === ''
      ? 'in the Proton dashboard'
      : `at <${base}/dashboard/${guildId}/${MODULE_ID}> using the switch at the top of the page`;
  return `**Applications** is off in this server, so ${what}. A server admin can turn it on ${where}.`;
}

export function statusMessage(body: StatusBody, buttons: readonly Component[]): InteractionMessage {
  return {
    ...body,
    ...(buttons.length > 0 ? { components: buttonRows(buttons) } : {}),
    allowedMentions: { parse: [] },
  };
}

function refuse(press: Press, sentence: string, buttons: readonly Component[] = []): Promise<void> {
  return answer(press, statusMessage(errorStatus(sentence), buttons));
}

function work(press: Press, applicationId: string): Promise<void> {
  return requestWork(press.ctx, press.deps, applicationId);
}

function expiresAt(press: Press): number {
  return press.now + press.ctx.config.draftExpiryDays * DAY_MS;
}

function statusUrlOf(deps: BoundApplicationsDeps, application: ApplicationRecord): string | null {
  return deps.dashboardUrl === null
    ? null
    : `${deps.dashboardUrl}/applications/${application.guildId}/${application.id}`;
}

function goneSentence(ctx: ModuleContext<ApplicationsConfig>): string {
  return (
    'I can’t find those saved answers. Unsent answers are deleted after a while without ' +
    `changes, or when you cancel them. Start again from the application panel or with \`${labelOf(
      ctx,
      'apply',
      'start',
    )}\`.`
  );
}

function parseIndex(raw: string | undefined): number | null {
  return raw !== undefined && INDEX.test(raw) ? Number(raw) : null;
}

function parseRevision(raw: string | undefined): number | null {
  return raw !== undefined && REVISION.test(raw) ? Number(raw) : null;
}

function sameAnswer(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

function alreadySaved(draft: DraftAnswers, answers: DraftAnswers): boolean {
  return Object.entries(answers).every(([id, value]) =>
    sameAnswer(Object.hasOwn(draft, id) ? draft[id] : undefined, value),
  );
}

export interface Resume {
  steps: Step[];
  index: number;
  complete: boolean;
}

export function resumeAt(sections: readonly Section[], draft: DraftAnswers, saved: number): Resume {
  const steps = stepsFor(sections, draft);
  if (steps.length === 0) return { steps, index: 0, complete: false };

  const checked = checkAnswers(sections, draft, { partial: false });
  if (!checked.ok) {
    const wanting = new Set(checked.problems.map((problem) => problem.questionId));
    const first = steps.find((step) => step.questions.some((question) => wanting.has(question.id)));
    if (first !== undefined) return { steps, index: first.index, complete: false };
  }

  return {
    steps,
    index: Math.min(Math.max(0, saved), steps.length - 1),
    complete: checked.ok,
  };
}

function stepProblems(
  sections: readonly Section[],
  draft: DraftAnswers,
  step: Step,
): AnswerProblem[] {
  const checked = checkAnswers(sections, draft, { partial: false });
  if (checked.ok) return [];

  const ids = new Set(step.questions.map((question) => question.id));
  return checked.problems.filter((problem) => ids.has(problem.questionId));
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

export interface Standing {
  draft: ApplicationRecord | null;
  active: ApplicationRecord[];
  retryAt: number | null;
  cooling: boolean;
  full: boolean;
  restarted: boolean;
}

export function standingOf(input: {
  rows: readonly ApplicationRecord[];
  form: FormConfig;
  latest: FormVersionRecord | null;
  draftExpiryDays: number;
  now: number;
}): Standing {
  const { form, latest, now } = input;
  const own = input.rows.filter((row) => row.formId === form.id && row.deletedAt === null);
  const draft = own.find((row) => row.status === 'draft') ?? null;
  const active = own
    .filter((row) => isActive(row.status))
    .sort((a, b) => (b.submittedAt ?? 0) - (a.submittedAt ?? 0));
  const retryAt = cooldownUntil(own, form.intake.cooldownDays);
  const newest = own.reduce<ApplicationRecord | null>(
    (found, row) => (found === null || row.createdAt > found.createdAt ? row : found),
    null,
  );

  return {
    draft,
    active,
    retryAt,
    cooling: retryAt !== null && retryAt > now,
    full: active.length >= form.intake.maxActive,
    restarted:
      draft === null &&
      latest !== null &&
      newest !== null &&
      newest.status === 'expired' &&
      newest.number === null &&
      newest.updatedAt >= latest.publishedAt &&
      now - newest.updatedAt < input.draftExpiryDays * DAY_MS,
  };
}

function activeSentence(standing: Standing): string {
  return standing.active.length === 1
    ? 'You can apply again once it’s decided or withdrawn.'
    : 'You can apply again once one of them is decided or withdrawn.';
}

export interface OverviewRequest {
  ctx: ModuleContext<ApplicationsConfig>;
  deps: BoundApplicationsDeps;
  userId: string;
  formId: string;
  member: MemberContext | null;
  now: number;
}

export type OverviewResult =
  | { ok: true; components: Component[] }
  | { ok: false; humanReason: string };

export async function overviewFor(input: OverviewRequest): Promise<OverviewResult> {
  const { ctx, deps, now } = input;
  const { config } = ctx;

  const form = formFor(config, input.formId);
  if (form === undefined) return { ok: false, humanReason: FORM_GONE };

  const [latestVersions, counts, mine] = await Promise.all([
    deps.store.latestVersions(ctx.guildId),
    deps.store.counts(ctx.guildId),
    deps.store.mine(ctx.guildId, input.userId),
  ]);

  const latest = latestVersions.get(form.id) ?? null;
  const standing = standingOf({
    rows: mine,
    form,
    latest,
    draftExpiryDays: config.draftExpiryDays,
    now,
  });
  const { draft, active, retryAt, cooling, full, restarted } = standing;

  const pinned =
    draft === null || draft.versionId === latest?.id
      ? latest
      : await deps.store.version(ctx.guildId, draft.versionId);
  const snapshot = pinned?.snapshot ?? null;

  const intake = intakeState({
    moduleOn: config.enabled,
    form,
    published: latest !== null,
    submittedCount: counts.get(form.id)?.submittedForCap,
    now,
  });
  const eligibility =
    snapshot === null ? null : await eligibilityFor(deps, input.member, snapshot.requirements);

  const name = snapshot?.name ?? form.name;
  const keepable = intake.state === 'open' || KEEPABLE.has(intake.reason);

  const notices: string[] = [];
  for (const row of active.slice(0, 3)) {
    notices.push(
      `You already have an application for this form: **${referenceOf(row.number)}** · ${STATUS_LABELS[row.status]}.`,
    );
  }
  if (full) {
    notices.push(activeSentence(standing));
  } else if (cooling && retryAt !== null) {
    notices.push(`You can apply to this form again ${timestamp(retryAt)}.`);
  }
  if (restarted) notices.push(RESTARTED);
  if (draft !== null && intake.state === 'closed' && keepable) {
    notices.push(
      'You can keep editing your saved answers, but you can’t send them until the form opens again.',
    );
  }
  if (eligibility?.state === 'ineligible') {
    notices.push('You don’t meet every requirement above, so you can’t apply right now.');
  } else if (eligibility?.state === 'blocked') {
    notices.push('I can’t start your application until every requirement can be checked.');
  }

  const buttons: Component[] = [];
  if (draft !== null && snapshot !== null) {
    if (keepable && eligibility?.state !== 'ineligible' && !full) {
      const resume = resumeAt(snapshot.sections, draft.draft, draft.step);
      if (resume.complete) {
        buttons.push(
          button({
            label: 'Review answers',
            customId: customId(APPLICANT_ACTION.review, draft.id, '0'),
            style: ButtonStyle.Primary,
          }),
        );
      } else {
        buttons.push(
          startButton(form.id, `Continue (step ${resume.index + 1} of ${resume.steps.length})`),
        );
        if (Object.keys(draft.draft).length > 0) buttons.push(reviewButton(draft.id));
      }
    }
  } else if (
    snapshot !== null &&
    intake.state === 'open' &&
    eligibility?.state === 'eligible' &&
    !full &&
    !cooling
  ) {
    buttons.push(startButton(form.id, 'Start', restarted));
  }
  const newest = active[0];
  if (newest !== undefined) {
    buttons.push(viewButton(newest.id));
    if (canRespond(newest.status)) buttons.push(answerButton(newest.id));
    buttons.push(withdrawButton(newest.id));
  }
  buttons.push(mineButton());

  return {
    ok: true,
    components: overviewScreen({
      name,
      description: snapshot?.description ?? form.description,
      intro: snapshot?.intro ?? '',
      emoji: snapshot?.emoji ?? form.emoji,
      eligibility,
      intakeLine: intakeSentence(
        intake,
        { name, messages: form.messages },
        {
          field: 'discord_text',
          now,
        },
      ),
      notices,
      whoCanRead: whoCanRead(config, form, config.retentionDays),
      buttons,
    }),
  };
}

export function mineEntries(
  config: ApplicationsConfig,
  rows: readonly ApplicationRecord[],
): MineEntry[] {
  return rows
    .filter((row) => row.deletedAt === null && (row.status === 'draft' || row.number !== null))
    .map((row) => ({
      id: row.id,
      formId: row.formId,
      formName: formFor(config, row.formId)?.name ?? row.formId,
      status: row.status,
      number: row.number,
      submittedAt: row.submittedAt,
      updatedAt: row.updatedAt,
    }));
}

export function mineLink(deps: BoundApplicationsDeps, guildId: string): string | null {
  return deps.dashboardUrl === null ? null : `${deps.dashboardUrl}/apply/${guildId}`;
}

async function formNameOf(press: Press, application: ApplicationRecord): Promise<string> {
  const version = await press.deps.store.version(press.ctx.guildId, application.versionId);
  return (
    version?.snapshot.name ??
    formFor(press.ctx.config, application.formId)?.name ??
    application.formId
  );
}

async function latestRequest(press: Press, application: ApplicationRecord): Promise<string | null> {
  const detail = await press.deps.store.detail(press.ctx.guildId, application.id);
  const asked = (detail?.thread ?? [])
    .filter((entry) => entry.kind === 'info_request' && entry.body !== null)
    .sort((a, b) => a.createdAt - b.createdAt)
    .at(-1);
  return asked?.body ?? null;
}

async function statusComponents(
  press: Press,
  application: ApplicationRecord,
  notice?: string,
): Promise<Component[]> {
  const formName = await formNameOf(press, application);
  const request =
    application.status === 'needs_info' ? await latestRequest(press, application) : null;

  return statusScreen({
    applicationId: application.id,
    formName,
    number: application.number,
    status: application.status,
    submittedAt: application.submittedAt,
    decidedAt: DECIDED.has(application.status) ? application.decidedAt : null,
    decisionReason: DECIDED.has(application.status) ? application.decisionReason : null,
    request,
    infoDueAt: application.infoDueAt,
    statusUrl: statusUrlOf(press.deps, application),
    notice,
  });
}

async function ownApplication(
  press: Press,
  applicationId: string | undefined,
): Promise<ApplicationRecord | null> {
  if (applicationId === undefined || !APPLICATION_ID.test(applicationId)) {
    await refuse(press, OUTDATED);
    return null;
  }

  const application = await press.deps.store.get(press.ctx.guildId, applicationId);
  if (application === null || application.deletedAt !== null) {
    await refuse(press, goneSentence(press.ctx));
    return null;
  }
  if (application.applicantId !== press.facts.userId) {
    await refuse(press, NOT_YOURS);
    return null;
  }
  return application;
}

async function refuseNotDraft(press: Press, application: ApplicationRecord): Promise<void> {
  if (application.number !== null) {
    await refuse(press, 'This application has already been sent, so its answers can’t change.', [
      viewButton(application.id),
    ]);
    return;
  }

  const form = formFor(press.ctx.config, application.formId);
  if (application.status === 'expired' && form !== undefined && !form.archived) {
    await refuse(press, RESTARTED, [startButton(form.id, 'Start again', true)]);
    return;
  }
  await refuse(press, goneSentence(press.ctx));
}

async function ownDraft(
  press: Press,
  applicationId: string | undefined,
): Promise<ApplicationRecord | null> {
  const application = await ownApplication(press, applicationId);
  if (application === null) return null;
  if (application.status === 'draft') return application;

  await refuseNotDraft(press, application);
  return null;
}

async function versionOf(
  press: Press,
  application: ApplicationRecord,
): Promise<FormVersionRecord | null> {
  const version = await press.deps.store.version(press.ctx.guildId, application.versionId);
  if (version === null) await refuse(press, VERSION_GONE);
  return version;
}

function lateForModal(press: Press): boolean {
  const at = press.event.occurredAt;
  return Number.isFinite(at) && press.deps.now() - at > MODAL_BUDGET_MS;
}

async function openStepModal(
  press: Press,
  application: ApplicationRecord,
  version: FormVersionRecord,
  steps: readonly Step[],
  wanted: number,
): Promise<void> {
  if (steps.length === 0) {
    await refuse(press, 'This form has no questions to answer yet. Ask a server admin about it.');
    return;
  }

  const index = Math.min(Math.max(0, wanted), steps.length - 1);
  const step = steps[index];
  if (step === undefined) return;

  const ready = [stepButton(application.id, index, `Open step ${index + 1} of ${steps.length}`)];

  if (lateForModal(press)) {
    await screen(
      press,
      noticeScreen('Ready when you are', 'Press the button to open the next step.', ready),
    );
    return;
  }

  const opened = await run(
    press,
    openModal(
      press.to,
      buildStepModal({
        applicationId: application.id,
        revision: application.revision,
        draft: application.draft,
        formName: version.snapshot.name,
        step,
        stepCount: steps.length,
      }),
    ),
    'open a step of an application',
  );
  if (failed(opened)) await refuse(press, 'I couldn’t open that step just now. Try again.', ready);
}

async function openOverview(press: Press, formId: string | undefined): Promise<void> {
  await ack(press);

  if (formId === undefined || !SLUG.test(formId)) {
    await refuse(press, 'Choose a form first.');
    return;
  }

  const overview = await overviewFor({
    ctx: press.ctx,
    deps: press.deps,
    userId: press.facts.userId,
    formId,
    member: memberContextOf(press.event, press.ctx.guildId, press.now, press.ctx.tier ?? 'free'),
    now: press.now,
  });

  if (!overview.ok) {
    await refuse(press, overview.humanReason);
    return;
  }
  await screen(press, overview.components);
}

function startRefusal(
  standing: Standing,
  form: FormConfig,
  fresh: boolean,
): { sentence: string; buttons: Component[] } | null {
  const newest = standing.active[0];
  if (standing.full && newest !== undefined) {
    return {
      sentence: `You already have an application for **${form.name}** waiting for a decision. ${activeSentence(standing)}`,
      buttons: [viewButton(newest.id)],
    };
  }
  if (standing.cooling && standing.retryAt !== null) {
    return {
      sentence: `You applied to **${form.name}** recently. You can apply again ${timestamp(standing.retryAt)}.`,
      buttons: [],
    };
  }
  if (standing.restarted && !fresh) {
    return { sentence: RESTARTED, buttons: [startButton(form.id, 'Start again', true)] };
  }
  return null;
}

async function startOrContinue(
  press: Press,
  formId: string | undefined,
  flag: string | undefined,
): Promise<void> {
  const { ctx, deps } = press;
  const form = formId === undefined ? undefined : formFor(ctx.config, formId);
  if (form === undefined) {
    await refuse(press, FORM_GONE);
    return;
  }

  const [rows, latestVersions] = await Promise.all([
    deps.store.mine(ctx.guildId, press.facts.userId),
    deps.store.latestVersions(ctx.guildId),
  ]);
  const latest = latestVersions.get(form.id) ?? null;
  const standing = standingOf({
    rows,
    form,
    latest,
    draftExpiryDays: ctx.config.draftExpiryDays,
    now: press.now,
  });

  let application = standing.draft;
  let version: FormVersionRecord | null;

  if (application === null) {
    const intake = intakeState({
      moduleOn: ctx.config.enabled,
      form,
      published: latest !== null,
      now: press.now,
    });
    if (intake.state === 'closed' || latest === null) {
      await refuse(press, intakeSentence(intake, form, { field: 'discord_text', now: press.now }));
      return;
    }

    const refusal = startRefusal(standing, form, flag === FRESH_START);
    if (refusal !== null) {
      await refuse(press, refusal.sentence, refusal.buttons);
      return;
    }

    try {
      const started = await deps.store.startDraft({
        guildId: ctx.guildId,
        formId: form.id,
        versionId: latest.id,
        applicantId: press.facts.userId,
        applicantName: applicantNameOf(press.event),
        expiresAt: expiresAt(press),
        source: 'discord',
      });
      application = started.application;
    } catch (error) {
      ctx.logger.error(
        `applications could not start a draft for form ${form.id}: ${errorSummary(error)}`,
        { guildId: ctx.guildId, moduleId: MODULE_ID },
      );
      await refuse(press, 'I couldn’t start your application just now. Try again in a moment.', [
        startButton(form.id, 'Try again', flag === FRESH_START),
      ]);
      return;
    }

    version =
      application.versionId === latest.id
        ? latest
        : await deps.store.version(ctx.guildId, application.versionId);
  } else {
    const intake = intakeState({
      moduleOn: ctx.config.enabled,
      form,
      published: true,
      now: press.now,
    });
    if (intake.state === 'closed' && !KEEPABLE.has(intake.reason)) {
      await refuse(press, intakeSentence(intake, form, { field: 'discord_text', now: press.now }));
      return;
    }
    version = await deps.store.version(ctx.guildId, application.versionId);
  }

  if (version === null) {
    await refuse(press, VERSION_GONE);
    return;
  }

  const resume = resumeAt(version.snapshot.sections, application.draft, application.step);
  await openStepModal(press, application, version, resume.steps, resume.index);
}

async function openStep(
  press: Press,
  applicationId: string | undefined,
  raw: string | undefined,
): Promise<void> {
  const application = await ownDraft(press, applicationId);
  if (application === null) return;

  const form = formFor(press.ctx.config, application.formId);
  if (form === undefined || form.archived) {
    await refuse(press, 'This form is no longer taking applications.');
    return;
  }

  const version = await versionOf(press, application);
  if (version === null) return;

  const steps = stepsFor(version.snapshot.sections, application.draft);
  await openStepModal(press, application, version, steps, parseIndex(raw) ?? application.step);
}

async function saveStep(
  press: Press,
  applicationId: string | undefined,
  rawStep: string | undefined,
  rawRevision: string | undefined,
): Promise<void> {
  await ack(press);

  const modal = press.facts.modal;
  const index = parseIndex(rawStep);
  const revision = parseRevision(rawRevision);
  if (modal === null || index === null || revision === null) {
    await refuse(press, OUTDATED);
    return;
  }

  const application = await ownDraft(press, applicationId);
  if (application === null) return;

  const version = await versionOf(press, application);
  if (version === null) return;

  const { sections } = version.snapshot;
  const step = stepsFor(sections, application.draft)[index];
  if (step === undefined) {
    await screen(press, conflictScreen({ applicationId: application.id, step: 0 }));
    return;
  }

  const answers = readStepAnswers(step, modal);
  let saved = application;

  if (application.revision !== revision) {
    if (!alreadySaved(application.draft, answers)) {
      await screen(press, conflictScreen({ applicationId: application.id, step: index }));
      return;
    }
  } else {
    const merged = { ...application.draft, ...answers };
    const after = stepsFor(sections, merged)[index] ?? step;
    const next = stepProblems(sections, merged, after).length > 0 ? index : index + 1;

    const result = await press.deps.store.saveDraft({
      guildId: press.ctx.guildId,
      applicationId: application.id,
      applicantId: press.facts.userId,
      expectedRevision: revision,
      answers,
      mode: 'merge',
      step: next,
      expiresAt: expiresAt(press),
    });

    if (result.status === 'gone') {
      await refuse(press, goneSentence(press.ctx));
      return;
    }
    if (result.status === 'conflict' && !alreadySaved(result.application.draft, answers)) {
      await screen(press, conflictScreen({ applicationId: application.id, step: index }));
      return;
    }
    saved = result.application;
  }

  const steps = stepsFor(sections, saved.draft);
  const shown = steps[index] ?? step;
  const problems = stepProblems(sections, saved.draft, shown);

  await screen(
    press,
    stepScreen({
      applicationId: saved.id,
      formName: version.snapshot.name,
      saved: shown,
      stepCount: steps.length,
      problems,
      next: problems.length > 0 ? null : (steps[index + 1] ?? null),
    }),
  );
}

async function reviewComponents(
  application: ApplicationRecord,
  version: FormVersionRecord,
  page: number,
  notice?: string,
): Promise<Component[]> {
  const { sections, name } = version.snapshot;
  const checked = checkAnswers(sections, application.draft, { partial: false });
  const problems = checked.ok ? [] : checked.problems;

  return reviewScreen({
    applicationId: application.id,
    revision: application.revision,
    formName: name,
    pages: answerPages(checked.answers, reviewBudget(problems)),
    page,
    problems,
    steps: stepsFor(sections, application.draft),
    notice,
  });
}

async function showReview(
  press: Press,
  applicationId: string | undefined,
  rawPage: string | undefined,
): Promise<void> {
  await ack(press);

  const application = await ownApplication(press, applicationId);
  if (application === null) return;
  const page = parseIndex(rawPage) ?? 0;

  if (application.status === 'draft') {
    const version = await versionOf(press, application);
    if (version === null) return;
    await screen(press, await reviewComponents(application, version, page));
    return;
  }

  if (application.number === null) {
    await refuseNotDraft(press, application);
    return;
  }

  await screen(
    press,
    answersScreen({
      applicationId: application.id,
      formName: await formNameOf(press, application),
      number: application.number,
      pages: application.answers === null ? null : answerPages(application.answers),
      page,
    }),
  );
}

async function sentComponents(
  press: Press,
  application: ApplicationRecord,
  form: FormConfig | undefined,
): Promise<Component[]> {
  const version = await press.deps.store.version(press.ctx.guildId, application.versionId);

  return sentScreen({
    applicationId: application.id,
    number: application.number ?? 0,
    formName: version?.snapshot.name ?? form?.name ?? application.formId,
    confirmation: version?.snapshot.confirmation ?? '',
    statusCommand: labelOf(press.ctx, 'apply', 'status'),
    statusUrl: statusUrlOf(press.deps, application),
    dm: form?.notify.dm ?? false,
  });
}

function eligibilityRefusal(eligibility: Eligibility, name: string): string {
  if (eligibility.state === 'ineligible') {
    return [
      `Your application for **${name}** wasn’t sent because you don’t meet its requirements:`,
      ...eligibility.lines.filter((line) => line.passed === false).map((line) => `✗ ${line.text}`),
      'Your answers are saved.',
    ].join('\n');
  }

  const issues = eligibility.state === 'blocked' ? eligibility.issues : [];
  return [
    `Your application for **${name}** wasn’t sent because I couldn’t check every requirement:`,
    ...[...new Set(issues.map((issue) => issue.humanReason))].map((reason) => `- ${reason}`),
    'Your answers are saved. Try again in a moment.',
  ].join('\n');
}

async function refuseSubmit(
  press: Press,
  result: Extract<SubmitResult, { status: 'refused' }>,
  application: ApplicationRecord,
  form: FormConfig,
  version: FormVersionRecord,
): Promise<void> {
  const name = version.snapshot.name;

  switch (result.code) {
    case 'cap':
      await refuse(
        press,
        `**${name}** has all the applications it can take right now, so yours wasn’t sent. Your answers are saved.`,
      );
      return;
    case 'cooldown':
      await refuse(
        press,
        `You applied to **${name}** recently, so you can send this application ${
          result.retryAt === undefined ? 'later' : timestamp(result.retryAt)
        }. Your answers are saved.`,
      );
      return;
    case 'active':
      await refuse(
        press,
        `You already have an application for **${name}** waiting for a decision, so this one wasn’t sent. You can apply again once it’s decided or withdrawn. Your answers are saved.`,
        result.existingId === undefined ? [] : [viewButton(result.existingId)],
      );
      return;
    case 'conflict': {
      const fresh = await press.deps.store.get(press.ctx.guildId, application.id);
      if (fresh === null || fresh.status !== 'draft') {
        if (fresh !== null && fresh.number !== null) {
          await screen(press, await sentComponents(press, fresh, form));
          return;
        }
        await refuse(press, goneSentence(press.ctx));
        return;
      }
      await screen(
        press,
        await reviewComponents(
          fresh,
          version,
          0,
          'Your answers changed somewhere else since you opened this review. Check them, then submit again.',
        ),
      );
      return;
    }
    case 'not_draft': {
      const fresh = await press.deps.store.get(press.ctx.guildId, application.id);
      if (fresh !== null && fresh.number !== null && fresh.applicantId === press.facts.userId) {
        await screen(press, await sentComponents(press, fresh, form));
        return;
      }
      if (fresh !== null) {
        await refuseNotDraft(press, fresh);
        return;
      }
      await refuse(press, goneSentence(press.ctx));
    }
  }
}

async function submitApplication(
  press: Press,
  applicationId: string | undefined,
  rawRevision: string | undefined,
): Promise<void> {
  await ack(press);

  const { ctx, deps } = press;
  const application = await ownApplication(press, applicationId);
  if (application === null) return;

  const form = formFor(ctx.config, application.formId);
  if (application.status !== 'draft') {
    if (application.number !== null) {
      await screen(press, await sentComponents(press, application, form));
      return;
    }
    await refuseNotDraft(press, application);
    return;
  }

  if (form === undefined) {
    await refuse(press, FORM_GONE);
    return;
  }

  const version = await versionOf(press, application);
  if (version === null) return;
  const { snapshot } = version;

  const intake = intakeState({
    moduleOn: ctx.config.enabled,
    form,
    published: true,
    now: press.now,
  });
  if (intake.state === 'closed') {
    const sentence = intakeSentence(intake, form, { field: 'discord_text', now: press.now });
    await refuse(
      press,
      KEEPABLE.has(intake.reason)
        ? `${sentence} Your answers are saved, so you can send them once it opens again.`
        : sentence,
    );
    return;
  }

  const revision = parseRevision(rawRevision) ?? application.revision;
  if (revision !== application.revision) {
    await screen(
      press,
      await reviewComponents(
        application,
        version,
        0,
        'Your answers changed since you opened this review. Check them, then submit again.',
      ),
    );
    return;
  }

  const member = memberContextOf(press.event, ctx.guildId, press.now, ctx.tier ?? 'free');
  const eligibility = await eligibilityFor(deps, member, snapshot.requirements);
  if (eligibility.state !== 'eligible') {
    await refuse(press, eligibilityRefusal(eligibility, snapshot.name));
    return;
  }

  const checked = checkAnswers(snapshot.sections, application.draft, { partial: false });
  if (!checked.ok) {
    await screen(
      press,
      await reviewComponents(
        application,
        version,
        0,
        'Some answers need fixing before you can submit.',
      ),
    );
    return;
  }

  const now = press.now;
  const result = await deps.store.submit({
    guildId: ctx.guildId,
    applicationId: application.id,
    applicantId: press.facts.userId,
    expectedRevision: revision,
    answers: checked.answers,
    source: 'discord',
    applicantName: applicantNameOf(press.event),
    limits: {
      cap: form.intake.cap,
      cooldownDays: form.intake.cooldownDays,
      maxActive: form.intake.maxActive,
    },
    reviewDueAt:
      ctx.config.reviewReminderHours > 0 ? now + ctx.config.reviewReminderHours * HOUR_MS : null,
    plan: (submitted, next) =>
      planEffects('applications.submitted', {
        config: ctx.config,
        form,
        application: submitted,
        revision: next,
        now,
        actorId: press.facts.userId,
      }),
    lifecycle: {
      guildId: ctx.guildId,
      applicationId: application.id,
      formId: form.id,
      formName: form.name,
      versionId: application.versionId,
      applicantId: press.facts.userId,
      actorId: press.facts.userId,
    },
  });

  if (result.status === 'refused') {
    await refuseSubmit(press, result, application, form, version);
    return;
  }

  await screen(press, await sentComponents(press, result.application, form));
  await work(press, result.application.id);
}

async function showMine(press: Press): Promise<void> {
  await ack(press);

  const rows = await press.deps.store.mine(press.ctx.guildId, press.facts.userId);
  await screen(
    press,
    mineScreen({
      title: 'Your applications',
      empty: 'You haven’t applied to anything in this server yet.',
      entries: mineEntries(press.ctx.config, rows),
      link: mineLink(press.deps, press.ctx.guildId),
    }),
  );
}

async function showStatus(press: Press, applicationId: string | undefined): Promise<void> {
  await ack(press);

  const application = await ownApplication(press, applicationId);
  if (application === null) return;

  if (application.status === 'draft') {
    const version = await versionOf(press, application);
    if (version === null) return;
    await screen(press, await reviewComponents(application, version, 0));
    return;
  }
  if (application.number === null) {
    await refuseNotDraft(press, application);
    return;
  }

  await screen(press, await statusComponents(press, application));
}

async function confirmWithdraw(press: Press, applicationId: string | undefined): Promise<void> {
  await ack(press);

  const application = await ownApplication(press, applicationId);
  if (application === null) return;

  if (!canWithdraw(application.status)) {
    await refuse(
      press,
      `This application is ${STATUS_LABELS[application.status].toLowerCase()}, so it can’t be withdrawn.`,
      [viewButton(application.id)],
    );
    return;
  }

  await screen(
    press,
    withdrawConfirmScreen({
      applicationId: application.id,
      formName: await formNameOf(press, application),
      number: application.number,
    }),
  );
}

async function withdraw(press: Press, applicationId: string | undefined): Promise<void> {
  await ack(press);

  const { ctx, deps } = press;
  const application = await ownApplication(press, applicationId);
  if (application === null) return;

  const form = formFor(ctx.config, application.formId);
  const now = press.now;
  const result = await deps.store.transition({
    guildId: ctx.guildId,
    applicationId: application.id,
    action: 'withdraw',
    actor: { id: press.facts.userId, source: 'discord' },
    expect: { statuses: ACTIVE_STATUSES },
    patch: {
      status: 'withdrawn',
      withdrawnAt: now,
      contentPurgeAt: now + ctx.config.retentionDays * DAY_MS,
    },
    event: {
      kind: 'withdrawn',
      id: `${application.id}:withdrawn:${press.event.id}`,
      lifecycle: 'applications.withdrawn',
    },
    ...(form === undefined
      ? {}
      : {
          plan: (withdrawn: ApplicationRecord, revision: number) =>
            planEffects('applications.withdrawn', {
              config: ctx.config,
              form,
              application: withdrawn,
              revision,
              now,
              actorId: press.facts.userId,
            }),
        }),
  });

  if (result.status === 'done') {
    await screen(
      press,
      await statusComponents(press, result.application, '✓ You withdrew your application.'),
    );
    await work(press, result.application.id);
    return;
  }

  const current = result.application;
  if (current === null) {
    await refuse(press, goneSentence(ctx));
    return;
  }
  if (current.status === 'withdrawn') {
    await screen(press, await statusComponents(press, current));
    return;
  }
  await refuse(
    press,
    `This application is ${STATUS_LABELS[current.status].toLowerCase()}, so it can’t be withdrawn.`,
    [viewButton(current.id)],
  );
}

async function openRespond(press: Press, applicationId: string | undefined): Promise<void> {
  const application = await ownApplication(press, applicationId);
  if (application === null) return;

  if (!canRespond(application.status)) {
    await refuse(press, NOT_WAITING, [viewButton(application.id)]);
    return;
  }

  if (lateForModal(press)) {
    await screen(
      press,
      noticeScreen('Ready when you are', 'Press the button to write your answer.', [
        answerButton(application.id),
      ]),
    );
    return;
  }

  const opened = await run(
    press,
    openModal(
      press.to,
      buildRespondModal({
        applicationId: application.id,
        revision: application.revision,
        formName: formFor(press.ctx.config, application.formId)?.name ?? 'your application',
      }),
    ),
    'open the answer window',
  );
  if (failed(opened)) {
    await refuse(press, 'I couldn’t open the answer window just now. Try again.', [
      viewButton(application.id),
    ]);
  }
}

async function saveResponse(press: Press, applicationId: string | undefined): Promise<void> {
  await ack(press);

  const { ctx, deps } = press;
  const modal = press.facts.modal;
  if (modal === null) {
    await refuse(press, OUTDATED);
    return;
  }

  let current = await ownApplication(press, applicationId);
  if (current === null) return;

  const body = readResponse(modal);
  if (body === '') {
    await refuse(press, 'Write an answer before you send it.', [viewButton(current.id)]);
    return;
  }

  const form = formFor(ctx.config, current.formId);
  const now = press.now;
  const hours = ctx.config.reviewReminderHours;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const assigneeId: string | null = current.assigneeId;
    const status = nextStatus('respond', 'needs_info', assigneeId !== null) ?? 'submitted';

    const result = await deps.store.transition({
      guildId: ctx.guildId,
      applicationId: current.id,
      action: 'respond',
      actor: { id: press.facts.userId, source: 'discord' },
      expect: { statuses: ['needs_info'], assigneeId },
      patch: {
        status,
        infoDueAt: null,
        reviewDueAt: hours > 0 ? now + hours * HOUR_MS : null,
        remindedAt: null,
      },
      thread: { kind: 'info_response', body },
      event: {
        kind: 'information_provided',
        id: `${current.id}:information_provided:${press.event.id}`,
        lifecycle: 'applications.information_provided',
        data: { length: body.length },
      },
      ...(form === undefined
        ? {}
        : {
            plan: (answered: ApplicationRecord, revision: number) =>
              planEffects('applications.information_provided', {
                config: ctx.config,
                form,
                application: answered,
                revision,
                now,
                actorId: press.facts.userId,
              }),
          }),
    });

    if (result.status === 'done') {
      await screen(
        press,
        await statusComponents(press, result.application, '✓ Your answer was sent to staff.'),
      );
      await work(press, result.application.id);
      return;
    }

    if (result.application === null) {
      await refuse(press, goneSentence(ctx));
      return;
    }
    current = result.application;
    if (current.status !== 'needs_info') break;
  }

  await refuse(press, `${NOT_WAITING} Your answer wasn’t sent.`, [viewButton(current.id)]);
}

async function saveForLater(press: Press, applicationId: string | undefined): Promise<void> {
  await ack(press);

  const application = await ownDraft(press, applicationId);
  if (application === null) return;

  const { ctx } = press;
  await screen(
    press,
    noticeScreen(
      'Your answers are saved',
      `Your answers for **${await formNameOf(press, application)}** are saved. Continue any time ` +
        `from the application panel or with \`${labelOf(ctx, 'apply', 'resume')}\`. Unsent ` +
        `answers are deleted after ${dayCount(ctx.config.draftExpiryDays)} without changes.`,
      [startButton(application.formId, 'Continue'), mineButton()],
    ),
  );
}

async function confirmCancel(press: Press, applicationId: string | undefined): Promise<void> {
  await ack(press);

  const application = await ownDraft(press, applicationId);
  if (application === null) return;

  await screen(
    press,
    cancelConfirmScreen({
      applicationId: application.id,
      formName: await formNameOf(press, application),
    }),
  );
}

async function discard(press: Press, applicationId: string | undefined): Promise<void> {
  await ack(press);

  const { ctx, deps } = press;
  const deleted = (name: string | null) =>
    screen(
      press,
      noticeScreen(
        'Your saved answers were deleted',
        `${name === null ? 'Your draft is gone.' : `Your draft for **${name}** is gone.`} You can ` +
          `start again from the application panel or with \`${labelOf(ctx, 'apply', 'start')}\`.`,
        [mineButton()],
      ),
    );

  if (applicationId === undefined || !APPLICATION_ID.test(applicationId)) {
    await refuse(press, OUTDATED);
    return;
  }

  const application = await deps.store.get(ctx.guildId, applicationId);
  if (application === null || application.deletedAt !== null) {
    await deleted(null);
    return;
  }
  if (application.applicantId !== press.facts.userId) {
    await refuse(press, NOT_YOURS);
    return;
  }
  if (application.status !== 'draft') {
    await refuseNotDraft(press, application);
    return;
  }

  const name = await formNameOf(press, application);
  await deps.store.discardDraft(ctx.guildId, application.id, press.facts.userId);
  await deleted(name);
}

const MODAL_ACTIONS: ReadonlySet<string> = new Set([
  APPLICANT_ACTION.answer,
  APPLICANT_ACTION.respondModal,
]);

export async function handleApplicantInteraction(
  event: ProtonEvent,
  ctx: ModuleContext<ApplicationsConfig>,
  deps: BoundApplicationsDeps,
  parsed: ProtonCustomId,
): Promise<void> {
  const facts = readFacts(event);
  if (facts === null) return;

  const press: Press = {
    event,
    ctx,
    deps,
    facts,
    to: {
      guildId: ctx.guildId,
      moduleId: MODULE_ID,
      actorId: facts.userId,
      interaction: interactionRef(facts),
      idempotencyKey: `${MODULE_ID}:${event.id}`,
    },
    follow: {
      guildId: ctx.guildId,
      moduleId: MODULE_ID,
      actorId: facts.userId,
      interaction: interactionRef(facts),
      idempotencyKey: `${MODULE_ID}:${event.id}`,
      applicationId: deps.applicationId,
    },
    acked: 'none',
    now: deps.now(),
  };

  const fromModal = facts.modal !== null;
  if (fromModal !== MODAL_ACTIONS.has(parsed.action)) {
    await refuse(press, OUTDATED);
    return;
  }

  const [first, second, third] = parsed.args;

  switch (parsed.action) {
    case APPLICANT_ACTION.open:
      return openOverview(press, second);
    case APPLICANT_ACTION.openSelect:
      return openOverview(press, facts.values[0]);
    case APPLICANT_ACTION.mine:
      return showMine(press);
    case APPLICANT_ACTION.start:
      return startOrContinue(press, first, second);
    case APPLICANT_ACTION.step:
      return openStep(press, first, second ?? facts.values[0]);
    case APPLICANT_ACTION.answer:
      return saveStep(press, first, second, third);
    case APPLICANT_ACTION.review:
      return showReview(press, first, second);
    case APPLICANT_ACTION.submit:
      return submitApplication(press, first, second);
    case APPLICANT_ACTION.later:
      return saveForLater(press, first);
    case APPLICANT_ACTION.cancel:
      return confirmCancel(press, first);
    case APPLICANT_ACTION.cancelConfirm:
      return discard(press, first);
    case APPLICANT_ACTION.view:
      return showStatus(press, first);
    case APPLICANT_ACTION.withdraw:
      return confirmWithdraw(press, first);
    case APPLICANT_ACTION.withdrawConfirm:
      return withdraw(press, first);
    case APPLICANT_ACTION.respond:
      return openRespond(press, first);
    case APPLICANT_ACTION.respondModal:
      return saveResponse(press, first);
    default:
      await refuse(press, OUTDATED);
  }
}
