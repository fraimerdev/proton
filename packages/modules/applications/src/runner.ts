import {
  type ActionFailure,
  type ActionResult,
  APPLICATION_LIFECYCLE_EVENTS,
  type ApplicationLifecycleEvent,
  type ApplicationStatus,
  applicationActionFailedSchema,
  applicationLifecycleSchema,
  applicationWorkRequestedSchema,
  channelAudience,
  type EventType,
  type GuildState,
  isScopedActionExecutor,
  MESSAGE_FLAG_IS_COMPONENTS_V2,
  type ModuleContext,
  roleGrantRefusal,
  ticketOpenRequestedSchema,
  xpGrantRequestedSchema,
} from '@proton/core';
import { ChannelType, RESTJSONErrorCodes } from 'discord-api-types/v10';
import { buildReviewCard, type CardMode, clip, effectProblems, voteTally } from './card.ts';
import {
  type ApplicationsConfig,
  type FormConfig,
  formFor,
  type OutcomeKey,
  reviewChannelFor,
  reviewSchema,
  teamFor,
} from './config.ts';
import {
  APPLICATIONS_ACTOR,
  EFFECT_ATTEMPTS_MAX,
  EFFECT_LEASE_MS,
  MODULE_ID,
} from './constants.ts';
import type { BoundApplicationsDeps } from './deps.ts';
import { type DmMessage, xpGrantId } from './effects.ts';
import {
  applicantDmFacts,
  DM_UNCONFIRMED,
  DMS_CLOSED,
  deliverApplicantDm,
  NO_MUTUAL_SERVER,
  renderApplicantDm,
} from './notify.ts';
import { ACTIVE_STATUSES, isActive } from './status.ts';
import {
  type ApplicationDetailRecord,
  type ApplicationRecord,
  type EffectOutcome,
  type EffectRecord,
  SWEEP_JOB,
  WAKE_KEY,
  wakeSlot,
} from './store.ts';
import { DAY_MS, dayCount, referenceOf } from './web.ts';

type Ctx = ModuleContext<ApplicationsConfig>;

export const WORK_BATCH = 50;
export const PURGE_TRIGGER = 'purge';

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const BACKOFF_CAP_MINUTES = 30;
const CONTEXT_VALUE_MAX = 1024;
const SUBJECT_MAX = 200;
const XP_REASON_MAX = 200;

export const CHANGED = 'Skipped because the application changed after this was queued.';
export const NO_REVIEW_CHANNEL = 'No review channel is set.';
export const ALREADY_HAD = 'They already had this role.';
export const DID_NOT_HAVE = 'They didn’t have this role.';
export const NOT_A_MEMBER = 'They’re no longer a member of this server.';
export const LEVELING_OFF = 'Leveling is off in this server.';
export const TICKETS_OFF = 'Tickets is off in this server, so no interview ticket was opened.';
export const XP_UNANSWERED = 'Leveling didn’t confirm the XP reward.';
export const TICKET_UNANSWERED = 'Tickets didn’t answer the request to open the interview ticket.';
export const ROLE_UNCONFIRMED = 'Couldn’t confirm the role change. Proton will try again.';
export const RANKED_TARGET =
  'Proton doesn’t change roles for the server owner or members ranked at or above Proton.';
export const DELETED = 'Skipped because the application was deleted.';
export const FORM_REMOVED =
  'The form this was sent on was removed from Applications settings, so it can only be read.';
export const DOWNGRADE_NOTICE =
  'Answers aren’t shown because members outside the review team can read this channel.';
export const AUDIENCE_UNKNOWN_NOTICE =
  'Answers aren’t shown because Proton couldn’t check who can read this channel.';

const FORM_GONE = 'Skipped because the form was removed from Applications settings.';
const ROLE_UNCONFIGURED = 'Skipped because this role is no longer in the form’s outcome actions.';
const NOTHING_GRANTED =
  'Proton gave none of these roles for this application, so none were removed.';
const DMS_OFF = 'Skipped because DMs to applicants are turned off for this form.';
const XP_TURNED_OFF = 'Skipped because the XP reward was turned off for this form.';
const NO_PINGS = 'Skipped because no roles are set to be pinged for this form.';
const MEMBER_UNKNOWN = 'Couldn’t read the applicant’s roles, so the role change is waiting.';
const CARD_UNCONFIRMED = 'Couldn’t confirm the review card was posted. Proton will try again.';
const NO_PUBLISH = 'Proton couldn’t pass this on to other modules right now.';

const NO_ROLE: EffectOutcome = {
  status: 'failed',
  errorCode: 'invalid_effect',
  error: 'This role change names no role.',
};

const TRANSIENT_CODES: ReadonlySet<string> = new Set([
  'guild_state_unavailable',
  'target_state_unavailable',
  'transport_failure',
]);

const MAY_HAVE_LANDED: ReadonlySet<string> = new Set([
  'unconfirmed',
  'transport_failure',
  'internal_error',
]);

const PERMANENT_DISCORD_CODES: ReadonlySet<number> = new Set([
  RESTJSONErrorCodes.UnknownChannel,
  RESTJSONErrorCodes.UnknownMember,
  RESTJSONErrorCodes.UnknownMessage,
  RESTJSONErrorCodes.UnknownRole,
  RESTJSONErrorCodes.MissingAccess,
  RESTJSONErrorCodes.MissingPermissions,
]);

const GONE_CODES: ReadonlySet<number> = new Set([
  RESTJSONErrorCodes.UnknownMessage,
  RESTJSONErrorCodes.UnknownChannel,
]);

const THREAD_TYPES: ReadonlySet<number> = new Set([
  ChannelType.AnnouncementThread,
  ChannelType.PublicThread,
  ChannelType.PrivateThread,
]);

const TRIGGER_STATUSES: Readonly<Record<string, readonly ApplicationStatus[]>> = {
  submitted: ACTIVE_STATUSES,
  info: ['needs_info'],
  waitlisted: ['waitlisted'],
  accepted: ['accepted'],
  rejected: ['rejected'],
  withdrawn: ['withdrawn'],
  expired: ['expired'],
  reminder: ['submitted', 'in_review'],
};

const RECONCILED: ReadonlySet<string> = new Set([
  'dm',
  'ping',
  'add_role',
  'remove_role',
  'xp',
  'reminder',
]);

const OUTCOME_OF: Readonly<Record<string, OutcomeKey>> = {
  submitted: 'onSubmit',
  accepted: 'onAccept',
  rejected: 'onReject',
  waitlisted: 'onWaitlist',
  withdrawn: 'onWithdraw',
};

const OUTCOME_HOLDING: Readonly<Partial<Record<ApplicationStatus, OutcomeKey>>> = {
  accepted: 'onAccept',
  rejected: 'onReject',
  waitlisted: 'onWaitlist',
  withdrawn: 'onWithdraw',
};

const VERBS: Readonly<Record<string, string>> = {
  submitted: 'sent',
  accepted: 'accepted',
  rejected: 'rejected',
  waitlisted: 'waitlisted',
  withdrawn: 'withdrawn',
  expired: 'expired',
  delete: 'deleted',
};

export type Downgrade = 'channel_not_private' | 'audience_unknown';

export interface Subject {
  application: ApplicationRecord;
  form: FormConfig | null;
  formName: string;
  detail: ApplicationDetailRecord;
}

interface Run {
  ctx: Ctx;
  deps: BoundApplicationsDeps;
  subjects: Map<string, Subject | null>;
  state: Promise<GuildState | null> | undefined;
  refresh: Map<string, string>;
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function snowflake(value: unknown): value is string {
  return typeof value === 'string' && /^\d{17,20}$/.test(value);
}

function snowflakes(value: unknown): string[] {
  return Array.isArray(value) ? value.filter(snowflake) : [];
}

function failedResult(result: ActionResult): boolean {
  return result.status === 'failed_precheck' || result.status === 'failed_api';
}

function failureOf(result: ActionResult): ActionFailure {
  return (
    result.failure ?? { code: 'unknown', humanReason: 'Discord refused this without saying why.' }
  );
}

function messageIdOf(result: ActionResult): string | null {
  return str((result.body as { id?: unknown } | undefined)?.id);
}

function gone(failure: ActionFailure): boolean {
  return failure.discordCode === undefined
    ? failure.code === 'discord_404'
    : GONE_CODES.has(failure.discordCode);
}

export function backoffAt(now: number, attempts: number): number {
  return now + Math.min(2 ** Math.max(attempts, 0), BACKOFF_CAP_MINUTES) * MINUTE_MS;
}

export function isTransient(failure: ActionFailure): boolean {
  if (TRANSIENT_CODES.has(failure.code)) return true;
  if (failure.discordCode !== undefined && PERMANENT_DISCORD_CODES.has(failure.discordCode)) {
    return false;
  }

  const status = /^discord_(\d{3})$/.exec(failure.code)?.[1];
  if (status === undefined) return false;
  const code = Number(status);
  return code === 429 || code >= 500;
}

function retryOr(
  effect: EffectRecord,
  now: number,
  give: { errorCode: string; error: string },
): EffectOutcome {
  if (effect.attempts >= EFFECT_ATTEMPTS_MAX) return { status: 'failed', ...give };
  return { status: 'pending', ...give, nextAttemptAt: backoffAt(now, effect.attempts) };
}

function failureOutcome(effect: EffectRecord, failure: ActionFailure, now: number): EffectOutcome {
  if (!isTransient(failure)) {
    return { status: 'failed', errorCode: failure.code, error: failure.humanReason };
  }
  return retryOr(effect, now, {
    errorCode: failure.code,
    error:
      effect.attempts >= EFFECT_ATTEMPTS_MAX
        ? `Proton tried ${EFFECT_ATTEMPTS_MAX} times and couldn’t finish this: ${failure.humanReason}`
        : failure.humanReason,
  });
}

function roleFailure(effect: EffectRecord, failure: ActionFailure, now: number): EffectOutcome {
  const ranked =
    failure.code === 'target_is_owner' ||
    (failure.code === 'role_hierarchy' && !failure.humanReason.includes('<@&'));
  if (ranked) return { status: 'failed', errorCode: failure.code, error: RANKED_TARGET };
  return failureOutcome(effect, failure, now);
}

function gaveUp(effect: EffectRecord): EffectOutcome {
  const error =
    effect.kind === 'xp'
      ? XP_UNANSWERED
      : effect.kind === 'ticket'
        ? TICKET_UNANSWERED
        : effect.kind === 'dm'
          ? DM_UNCONFIRMED
          : `Proton couldn’t finish this after ${EFFECT_ATTEMPTS_MAX} tries.`;
  return { status: 'failed', errorCode: 'unconfirmed', error };
}

function orphanForm(): Pick<FormConfig, 'review' | 'interview'> {
  return { review: reviewSchema.parse({}), interview: {} };
}

function keyOf(application: Pick<ApplicationRecord, 'id'>, ...parts: (string | number)[]): string {
  return [MODULE_ID, application.id, ...parts].join(':');
}

export async function loadSubject(
  ctx: Ctx,
  deps: BoundApplicationsDeps,
  applicationId: string,
): Promise<Subject | null> {
  const detail = await deps.store.detail(ctx.guildId, applicationId);
  if (detail === null) return null;

  const { application } = detail;
  const form = formFor(ctx.config, application.formId) ?? null;
  const formName =
    (await deps.store.version(ctx.guildId, application.versionId))?.snapshot.name ??
    form?.name ??
    'Application';

  return { application, form, formName, detail };
}

async function subjectOf(run: Run, applicationId: string): Promise<Subject | null> {
  if (run.subjects.has(applicationId)) return run.subjects.get(applicationId) ?? null;
  const subject = await loadSubject(run.ctx, run.deps, applicationId);
  run.subjects.set(applicationId, subject);
  return subject;
}

async function readState(ctx: Ctx, deps: BoundApplicationsDeps): Promise<GuildState | null> {
  if (deps.guildState === null) return null;
  try {
    return await deps.guildState.get(ctx.guildId);
  } catch (error) {
    ctx.logger.warn(`applications could not read the server’s cached state: ${reasonOf(error)}`, {
      guildId: ctx.guildId,
      moduleId: MODULE_ID,
    });
    return null;
  }
}

function stateOf(run: Run): Promise<GuildState | null> {
  run.state ??= readState(run.ctx, run.deps);
  return run.state;
}

function privacyOf(
  config: ApplicationsConfig,
  form: Pick<FormConfig, 'review'>,
  channelId: string,
  state: GuildState | null,
  botUserId: string,
): Downgrade | null {
  if (state === null) return 'audience_unknown';

  const channel = state.channels.get(channelId);
  const thread = channel?.type !== undefined && THREAD_TYPES.has(channel.type);
  const source = thread && channel?.parentId ? state.channels.get(channel.parentId) : channel;
  if (source === undefined) return 'audience_unknown';

  const audience = channelAudience({
    roles: state.roles,
    everyoneRoleId: state.everyoneRoleId,
    ownerId: state.ownerId,
    overwrites: source.overwrites,
  });

  const team = teamFor(config, form);
  const allowed = new Set([
    ...team.reviewerRoleIds,
    ...team.deciderRoleIds,
    ...team.viewerRoleIds,
    ...state.botRoleIds,
  ]);
  const outside =
    audience.roleIds.some((roleId) => !allowed.has(roleId)) ||
    audience.memberIds.some((memberId) => memberId !== botUserId);
  return audience.everyone || outside ? 'channel_not_private' : null;
}

export type RenderedCard =
  | {
      ok: true;
      components: Record<string, unknown>[];
      mode: CardMode;
      downgraded: Downgrade | null;
    }
  | { ok: false; humanReason: string };

export async function renderCard(
  ctx: Ctx,
  deps: BoundApplicationsDeps,
  subject: Subject,
  channelId: string,
  state: () => Promise<GuildState | null>,
): Promise<RenderedCard> {
  const { application, form, formName, detail } = subject;
  const reviewed = form ?? orphanForm();
  const wanted: CardMode = ctx.config.enabled ? reviewed.review.cardAnswers : 'none';
  const downgraded =
    wanted !== 'none' && application.answers !== null
      ? privacyOf(ctx.config, reviewed, channelId, await state(), deps.applicationId)
      : null;
  const mode: CardMode = downgraded === null ? wanted : 'none';

  const notice =
    form === null
      ? FORM_REMOVED
      : downgraded === 'channel_not_private'
        ? DOWNGRADE_NOTICE
        : downgraded === 'audience_unknown'
          ? AUDIENCE_UNKNOWN_NOTICE
          : undefined;

  const card = buildReviewCard({
    application,
    form: reviewed,
    formName,
    votes: voteTally(detail.votes),
    problems: effectProblems(detail.effects),
    dashboardUrl: deps.dashboardUrl,
    mode,
    now: deps.now(),
    ...(form === null ? { readOnly: true } : {}),
    ...(notice === undefined ? {} : { notice }),
  });

  return card.ok ? { ok: true, components: card.components, mode, downgraded } : card;
}

function cardPayload(channelId: string, components: Record<string, unknown>[]) {
  return {
    channelId,
    components,
    flags: MESSAGE_FLAG_IS_COMPONENTS_V2,
    allowedMentions: { parse: [] },
  };
}

function cardChannelOf(config: ApplicationsConfig, subject: Subject): string | undefined {
  if (subject.form !== null) return reviewChannelFor(config, subject.form);
  return subject.application.cardChannelId ?? config.reviewChannelId;
}

async function removeCard(
  run: Run,
  application: ApplicationRecord,
  channelId: string,
  messageId: string,
): Promise<void> {
  const removed = await run.ctx.executor.execute({
    guildId: run.ctx.guildId,
    moduleId: MODULE_ID,
    kind: 'delete_message',
    actorId: APPLICATIONS_ACTOR,
    idempotencyKey: keyOf(application, 'card-delete', messageId),
    dryRun: false,
    record: false,
    payload: { channelId, messageId },
  });
  if (!failedResult(removed) || gone(failureOf(removed))) return;

  run.ctx.logger.warn('applications could not remove a review card, so it is queued for removal', {
    guildId: run.ctx.guildId,
    moduleId: MODULE_ID,
    applicationId: application.id,
    code: removed.failure?.code,
  });
  await run.deps.store.queueCardRemoval(run.ctx.guildId, application.id, channelId, messageId);
}

async function runCard(run: Run, effect: EffectRecord, subject: Subject): Promise<EffectOutcome> {
  const { ctx, deps } = run;
  const { application } = subject;
  const now = deps.now();

  const channelId = cardChannelOf(ctx.config, subject);
  if (channelId === undefined) {
    return { status: 'skipped', errorCode: 'no_channel', error: NO_REVIEW_CHANNEL };
  }

  const rendered = await renderCard(ctx, deps, subject, channelId, () => stateOf(run));
  if (!rendered.ok) {
    return { status: 'failed', errorCode: 'card_invalid', error: rendered.humanReason };
  }

  const payload = cardPayload(channelId, rendered.components);
  const outcome = (messageId: string): EffectOutcome => ({
    status: 'succeeded',
    result: {
      channelId,
      messageId,
      revision: application.revision,
      mode: rendered.mode,
      ...(rendered.downgraded === null ? {} : { downgraded: rendered.downgraded }),
    },
  });

  const repost = effect.params.repost === true;
  const previous =
    application.cardChannelId !== null && application.cardMessageId !== null
      ? { channelId: application.cardChannelId, messageId: application.cardMessageId }
      : null;

  if (previous !== null && !repost && previous.channelId === channelId) {
    const edited = await ctx.executor.execute({
      guildId: ctx.guildId,
      moduleId: MODULE_ID,
      kind: 'edit_message',
      actorId: APPLICATIONS_ACTOR,
      idempotencyKey: keyOf(application, 'card-edit', application.revision),
      dryRun: false,
      record: false,
      payload: { ...payload, messageId: previous.messageId },
    });

    if (!failedResult(edited)) {
      const kept = await deps.store.rememberCard(
        ctx.guildId,
        application.id,
        channelId,
        previous.messageId,
        application.revision,
      );
      if (!kept) return { status: 'skipped', errorCode: 'deleted', error: DELETED };
      application.cardRevision = Math.max(application.cardRevision, application.revision);
      return outcome(previous.messageId);
    }

    const failure = failureOf(edited);
    if (!gone(failure)) return failureOutcome(effect, failure, now);
  }

  const posted = await ctx.executor.execute({
    guildId: ctx.guildId,
    moduleId: MODULE_ID,
    kind: 'send',
    actorId: APPLICATIONS_ACTOR,
    idempotencyKey: keyOf(application, 'card', effect.revision, effect.claimSeq),
    dryRun: false,
    record: false,
    payload,
  });

  if (posted.status === 'skipped_duplicate') {
    const fresh = await deps.store.get(ctx.guildId, application.id);
    const known = fresh?.cardChannelId === channelId ? fresh.cardMessageId : null;
    if (known !== null && (!repost || known !== previous?.messageId)) return outcome(known);
    return retryOr(effect, now, { errorCode: 'unconfirmed', error: CARD_UNCONFIRMED });
  }

  if (failedResult(posted)) return failureOutcome(effect, failureOf(posted), now);

  const messageId = messageIdOf(posted);
  if (messageId === null) {
    ctx.logger.warn('applications posted a review card but Discord returned no message id', {
      guildId: ctx.guildId,
      moduleId: MODULE_ID,
      applicationId: application.id,
    });
    return { status: 'succeeded', result: { channelId, mode: rendered.mode } };
  }

  const kept = await deps.store.rememberCard(
    ctx.guildId,
    application.id,
    channelId,
    messageId,
    application.revision,
  );
  if (!kept) {
    await removeCard(run, application, channelId, messageId);
    return { status: 'skipped', errorCode: 'deleted', error: DELETED };
  }
  application.cardChannelId = channelId;
  application.cardMessageId = messageId;
  application.cardRevision = Math.max(application.cardRevision, application.revision);

  if (previous !== null && previous.messageId !== messageId) {
    await removeCard(run, application, previous.channelId, previous.messageId);
  }

  return outcome(messageId);
}

async function runPing(run: Run, effect: EffectRecord, subject: Subject): Promise<EffectOutcome> {
  const { ctx, deps } = run;
  const { application, form, formName } = subject;
  if (form === null) return { status: 'skipped', errorCode: 'form_missing', error: FORM_GONE };

  const roleIds = [...form.review.pingRoleIds];
  if (roleIds.length === 0) return { status: 'skipped', errorCode: 'no_roles', error: NO_PINGS };

  const channelId = reviewChannelFor(ctx.config, form);
  if (channelId === undefined) {
    return { status: 'skipped', errorCode: 'no_channel', error: NO_REVIEW_CHANNEL };
  }

  const sent = await ctx.executor.execute({
    guildId: ctx.guildId,
    moduleId: MODULE_ID,
    kind: 'send',
    actorId: APPLICATIONS_ACTOR,
    idempotencyKey: keyOf(application, effect.key),
    dryRun: false,
    record: false,
    payload: {
      channelId,
      content:
        `${roleIds.map((roleId) => `<@&${roleId}>`).join(' ')} ` +
        `New ${clip(formName, 100)} ${referenceOf(application.number)}`,
      allowedMentions: { parse: [], roles: roleIds },
    },
  });

  if (failedResult(sent)) return failureOutcome(effect, failureOf(sent), deps.now());
  return { status: 'succeeded', result: { channelId, roleIds } };
}

function waited(ms: number): string {
  const days = Math.floor(ms / DAY_MS);
  if (days >= 1) return dayCount(days);
  const hours = Math.max(1, Math.floor(ms / HOUR_MS));
  return `${hours} ${hours === 1 ? 'hour' : 'hours'}`;
}

async function runReminder(
  run: Run,
  effect: EffectRecord,
  subject: Subject,
): Promise<EffectOutcome> {
  const { ctx, deps } = run;
  const { application, form, formName } = subject;
  if (form === null) return { status: 'skipped', errorCode: 'form_missing', error: FORM_GONE };

  const channelId = reviewChannelFor(ctx.config, form);
  if (channelId === undefined) {
    return { status: 'skipped', errorCode: 'no_channel', error: NO_REVIEW_CHANNEL };
  }

  const now = deps.now();
  const since = application.submittedAt ?? application.createdAt;
  const card =
    application.cardChannelId === channelId && application.cardMessageId !== null
      ? `\nhttps://discord.com/channels/${ctx.guildId}/${channelId}/${application.cardMessageId}`
      : '';

  const sent = await ctx.executor.execute({
    guildId: ctx.guildId,
    moduleId: MODULE_ID,
    kind: 'send',
    actorId: APPLICATIONS_ACTOR,
    idempotencyKey: keyOf(application, effect.key),
    dryRun: false,
    record: false,
    payload: {
      channelId,
      content:
        `${clip(formName, 100)} ${referenceOf(application.number)} has waited ` +
        `${waited(now - since)} for review.${card}`,
      allowedMentions: { parse: [] },
    },
  });

  if (failedResult(sent)) return failureOutcome(effect, failureOf(sent), now);
  return { status: 'succeeded', result: { channelId, messageId: messageIdOf(sent) } };
}

function statusUrl(deps: BoundApplicationsDeps, application: ApplicationRecord): string | null {
  return deps.dashboardUrl === null
    ? null
    : `${deps.dashboardUrl}/applications/${application.guildId}/${application.id}`;
}

const DM_MESSAGES: ReadonlySet<string> = new Set([
  'receipt',
  'accepted',
  'rejected',
  'waitlisted',
  'infoRequest',
  'withdrawn',
  'expired',
]);

function dmMessageOf(value: unknown): DmMessage | null {
  return typeof value === 'string' && DM_MESSAGES.has(value) ? (value as DmMessage) : null;
}

const ROLE_KINDS: ReadonlySet<string> = new Set(['add_role', 'remove_role']);

async function onboardingUnfinished(run: Run, effect: EffectRecord): Promise<boolean> {
  if (effect.params.message !== 'accepted') return false;

  const fresh = await run.deps.store.detail(run.ctx.guildId, effect.applicationId);
  return (fresh?.effects ?? []).some(
    (other) =>
      other.id !== effect.id &&
      other.trigger === effect.trigger &&
      other.revision === effect.revision &&
      ROLE_KINDS.has(other.kind) &&
      (other.status === 'failed' || (other.status === 'pending' && other.attempts > 0)),
  );
}

async function runDm(run: Run, effect: EffectRecord, subject: Subject): Promise<EffectOutcome> {
  const { ctx, deps } = run;
  const { application, form, formName, detail } = subject;
  const now = deps.now();

  if (form === null) return { status: 'skipped', errorCode: 'form_missing', error: FORM_GONE };
  if (!form.notify.dm) return { status: 'skipped', errorCode: 'dm_off', error: DMS_OFF };

  const message = dmMessageOf(effect.params.message);
  if (message === null) {
    return {
      status: 'failed',
      errorCode: 'invalid_effect',
      error: 'This DM names no message Proton knows, so nothing was sent.',
    };
  }

  const input = {
    message,
    form,
    application,
    formName,
    thread: detail.thread,
    url: statusUrl(deps, application),
    now,
    onboardingUnfinished: await onboardingUnfinished(run, effect),
    moderatorId: str(effect.params.moderatorId),
  };
  const rendered = renderApplicantDm(input, await applicantDmFacts(ctx, deps, input));
  if (!rendered.ok) {
    return { status: 'failed', errorCode: 'render_failed', error: rendered.humanReason };
  }

  const delivered = await deliverApplicantDm(ctx, deps.store, {
    application,
    body: rendered.body,
    openKey: keyOf(application, 'dm-open', effect.claimSeq),
    sendKey: keyOf(application, effect.key, 'send'),
  });

  switch (delivered.outcome) {
    case 'sent':
      application.dmChannelId = delivered.channelId;
      return { status: 'succeeded', result: { channelId: delivered.channelId } };
    case 'closed':
      return { status: 'failed', errorCode: 'dms_closed', error: DMS_CLOSED };
    case 'no_mutual_server':
      return { status: 'failed', errorCode: 'no_mutual_server', error: NO_MUTUAL_SERVER };
    case 'retry':
      return retryOr(effect, now, {
        errorCode: effect.attempts >= EFFECT_ATTEMPTS_MAX ? 'unconfirmed' : delivered.errorCode,
        error: effect.attempts >= EFFECT_ATTEMPTS_MAX ? DM_UNCONFIRMED : delivered.error,
      });
    default:
      return { status: 'failed', errorCode: delivered.errorCode, error: delivered.error };
  }
}

type Held = string[] | 'absent' | 'unknown' | 'unbound';

async function heldRoles(run: Run, userId: string): Promise<Held> {
  const lookup = run.deps.memberRoles;
  if (lookup === null) return 'unbound';

  try {
    const roles = await lookup(run.ctx.guildId, userId);
    return roles === null ? 'unknown' : roles;
  } catch (error) {
    run.ctx.logger.warn(`applications could not read a member’s roles: ${reasonOf(error)}`, {
      guildId: run.ctx.guildId,
      moduleId: MODULE_ID,
    });
    return 'unknown';
  }
}

function configured(
  effect: EffectRecord,
  form: FormConfig,
  roleId: string,
  list: 'addRoleIds' | 'removeRoleIds',
): boolean {
  const outcome = OUTCOME_OF[effect.trigger];
  return outcome === undefined || form.actions[outcome][list].includes(roleId);
}

function reasonFor(effect: EffectRecord, application: ApplicationRecord): string {
  return `Application ${referenceOf(application.number)} ${VERBS[effect.trigger] ?? 'updated'}`;
}

function mayHaveGranted(effect: EffectRecord): boolean {
  if (effect.attempts <= 1) return false;
  const code = effect.errorCode;
  return code === null || MAY_HAVE_LANDED.has(code) || /^discord_5\d\d$/.test(code);
}

async function othersOf(
  run: Run,
  application: ApplicationRecord,
  userId: string,
): Promise<ApplicationRecord[]> {
  const mine = await run.deps.store.mine(run.ctx.guildId, userId);
  return mine.filter((other) => other.id !== application.id && other.deletedAt === null);
}

async function grantHolder(
  run: Run,
  application: ApplicationRecord,
  userId: string,
  roleId: string,
): Promise<string | null> {
  const { store } = run.deps;
  const guildId = run.ctx.guildId;
  if ((await store.grantedRoles(guildId, application.id)).includes(roleId)) return application.id;

  for (const other of await othersOf(run, application, userId)) {
    if (!isActive(other.status)) continue;
    if ((await store.grantedRoles(guildId, other.id)).includes(roleId)) return other.id;
  }
  return null;
}

interface Keeper {
  applicationId: string;
  handOver: boolean;
}

function keeperAmong(
  config: ApplicationsConfig,
  others: readonly ApplicationRecord[],
  roleId: string,
): Keeper | null {
  for (const other of others) {
    const form = formFor(config, other.formId);
    if (form === undefined) continue;
    if (isActive(other.status) && form.actions.onSubmit.addRoleIds.includes(roleId)) {
      return { applicationId: other.id, handOver: true };
    }
    const outcome = OUTCOME_HOLDING[other.status];
    if (outcome !== undefined && form.actions[outcome].addRoleIds.includes(roleId)) {
      return { applicationId: other.id, handOver: false };
    }
  }
  return null;
}

async function runAddRole(
  run: Run,
  effect: EffectRecord,
  subject: Subject,
): Promise<EffectOutcome> {
  const { ctx, deps } = run;
  const { application, form } = subject;
  const now = deps.now();

  const roleId = effect.params.roleId;
  const userId = snowflake(effect.params.userId) ? effect.params.userId : application.applicantId;
  if (!snowflake(roleId)) return NO_ROLE;
  if (form === null) return { status: 'skipped', errorCode: 'form_missing', error: FORM_GONE };
  if (!configured(effect, form, roleId, 'addRoleIds')) {
    return { status: 'skipped', errorCode: 'unconfigured', error: ROLE_UNCONFIGURED };
  }

  const held = await heldRoles(run, userId);
  if (held === 'absent') {
    return { status: 'failed', errorCode: 'target_not_member', error: NOT_A_MEMBER };
  }
  if (held === 'unknown') {
    return retryOr(effect, now, { errorCode: 'member_unavailable', error: MEMBER_UNKNOWN });
  }
  if (Array.isArray(held) && held.includes(roleId)) {
    // An earlier attempt saw the role missing and may have landed without a confirmation.
    if (mayHaveGranted(effect)) {
      await deps.store.recordRoleGrant(ctx.guildId, application.id, userId, roleId);
      return { status: 'succeeded', result: { roleId, granted: true } };
    }
    const holder = await grantHolder(run, application, userId, roleId);
    if (holder === application.id) {
      return { status: 'succeeded', result: { roleId, granted: true } };
    }
    if (holder !== null) {
      await deps.store.recordRoleGrant(ctx.guildId, application.id, userId, roleId);
      return { status: 'succeeded', result: { roleId, granted: true, sharedWith: holder } };
    }
    return { status: 'skipped', errorCode: 'already_held', error: ALREADY_HAD };
  }

  const state = await stateOf(run);
  const refusal = state === null ? null : roleGrantRefusal(state, roleId);
  if (refusal !== null && (refusal.code === 'everyone' || refusal.code === 'managed')) {
    return {
      status: 'failed',
      errorCode: refusal.code,
      error: `Proton can’t give <@&${roleId}>: ${refusal.reason}`,
    };
  }

  const executor =
    Array.isArray(held) && isScopedActionExecutor(ctx.executor)
      ? ctx.executor.scoped({ targetRoleIds: [...held] })
      : ctx.executor;

  const result = await executor.execute({
    guildId: ctx.guildId,
    moduleId: MODULE_ID,
    kind: 'add_role',
    actorId: APPLICATIONS_ACTOR,
    targetId: userId,
    reason: reasonFor(effect, application),
    payload: { userId, roleId },
    dryRun: false,
    record: true,
    idempotencyKey: keyOf(application, effect.key, effect.claimSeq),
  });

  // Unrecorded when unknown: a recorded grant is one the close-out cleanup takes away again.
  const knew = Array.isArray(held);

  if (result.status === 'executed' || result.status === 'dry_run') {
    if (knew) await deps.store.recordRoleGrant(ctx.guildId, application.id, userId, roleId);
    return { status: 'succeeded', result: { roleId, granted: knew } };
  }

  if (result.status === 'skipped_duplicate') {
    const again = await heldRoles(run, userId);
    if (again === 'absent') {
      return { status: 'failed', errorCode: 'target_not_member', error: NOT_A_MEMBER };
    }
    if (Array.isArray(again) && again.includes(roleId)) {
      if (knew) await deps.store.recordRoleGrant(ctx.guildId, application.id, userId, roleId);
      return { status: 'succeeded', result: { roleId, granted: knew } };
    }
    return retryOr(effect, now, { errorCode: 'unconfirmed', error: ROLE_UNCONFIRMED });
  }

  return roleFailure(effect, failureOf(result), now);
}

async function removeOne(
  run: Run,
  effect: EffectRecord,
  application: ApplicationRecord,
  userId: string,
  roleId: string,
  held: string[] | null,
  key: string,
): Promise<ActionResult> {
  const executor =
    held !== null && isScopedActionExecutor(run.ctx.executor)
      ? run.ctx.executor.scoped({ targetRoleIds: [...held] })
      : run.ctx.executor;

  return executor.execute({
    guildId: run.ctx.guildId,
    moduleId: MODULE_ID,
    kind: 'remove_role',
    actorId: APPLICATIONS_ACTOR,
    targetId: userId,
    reason: reasonFor(effect, application),
    payload: { userId, roleId },
    dryRun: false,
    record: true,
    idempotencyKey: key,
  });
}

async function runCleanup(
  run: Run,
  effect: EffectRecord,
  subject: Subject,
  userId: string,
): Promise<EffectOutcome> {
  const { ctx, deps } = run;
  const { application } = subject;
  const now = deps.now();

  const granted = new Set(await deps.store.grantedRoles(ctx.guildId, application.id));
  const targets = snowflakes(effect.params.roleIds).filter((roleId) => granted.has(roleId));
  if (targets.length === 0) {
    return { status: 'skipped', errorCode: 'nothing_granted', error: NOTHING_GRANTED };
  }

  const held = await heldRoles(run, userId);
  if (held === 'absent') return { status: 'skipped', errorCode: 'not_member', error: NOT_A_MEMBER };
  if (held === 'unknown') {
    return retryOr(effect, now, { errorCode: 'member_unavailable', error: MEMBER_UNKNOWN });
  }

  const known = Array.isArray(held) ? held : null;
  const others = await othersOf(run, application, userId);
  const removed: string[] = [];
  const kept: string[] = [];
  const unconfirmed: string[] = [];
  let failure: ActionFailure | null = null;

  for (const roleId of targets) {
    if (known !== null && !known.includes(roleId)) {
      await deps.store.markRoleRemoved(ctx.guildId, application.id, roleId);
      removed.push(roleId);
      continue;
    }

    const keeper = keeperAmong(ctx.config, others, roleId);
    if (keeper !== null) {
      if (keeper.handOver) {
        await deps.store.recordRoleGrant(ctx.guildId, keeper.applicationId, userId, roleId);
      }
      await deps.store.markRoleRemoved(ctx.guildId, application.id, roleId);
      kept.push(roleId);
      continue;
    }

    const result = await removeOne(
      run,
      effect,
      application,
      userId,
      roleId,
      known,
      keyOf(application, effect.key, roleId, effect.claimSeq),
    );

    if (result.status === 'executed' || result.status === 'dry_run') {
      await deps.store.markRoleRemoved(ctx.guildId, application.id, roleId);
      removed.push(roleId);
    } else if (result.status === 'skipped_duplicate') {
      unconfirmed.push(roleId);
    } else {
      const refused = failureOf(result);
      if (failure === null || (isTransient(failure) && !isTransient(refused))) failure = refused;
    }
  }

  let unsure = false;
  if (unconfirmed.length > 0) {
    const again = await heldRoles(run, userId);
    for (const roleId of unconfirmed) {
      if (Array.isArray(again) && !again.includes(roleId)) {
        await deps.store.markRoleRemoved(ctx.guildId, application.id, roleId);
        removed.push(roleId);
      } else {
        unsure = true;
      }
    }
  }

  if (failure !== null) return roleFailure(effect, failure, now);
  if (unsure) return retryOr(effect, now, { errorCode: 'unconfirmed', error: ROLE_UNCONFIRMED });
  return { status: 'succeeded', result: { removed, kept } };
}

async function runRemoveRole(
  run: Run,
  effect: EffectRecord,
  subject: Subject,
): Promise<EffectOutcome> {
  const { deps, ctx } = run;
  const { application, form } = subject;
  const now = deps.now();
  const userId = snowflake(effect.params.userId) ? effect.params.userId : application.applicantId;

  if (effect.params.fromGrants === true) return runCleanup(run, effect, subject, userId);

  const roleId = effect.params.roleId;
  if (!snowflake(roleId)) return NO_ROLE;
  if (form === null) return { status: 'skipped', errorCode: 'form_missing', error: FORM_GONE };
  if (!configured(effect, form, roleId, 'removeRoleIds')) {
    return { status: 'skipped', errorCode: 'unconfigured', error: ROLE_UNCONFIGURED };
  }

  const held = await heldRoles(run, userId);
  if (held === 'absent') return { status: 'skipped', errorCode: 'not_member', error: NOT_A_MEMBER };
  if (held === 'unknown') {
    return retryOr(effect, now, { errorCode: 'member_unavailable', error: MEMBER_UNKNOWN });
  }
  if (Array.isArray(held) && !held.includes(roleId)) {
    return { status: 'skipped', errorCode: 'not_held', error: DID_NOT_HAVE };
  }

  const result = await removeOne(
    run,
    effect,
    application,
    userId,
    roleId,
    Array.isArray(held) ? held : null,
    keyOf(application, effect.key, effect.claimSeq),
  );

  if (result.status === 'executed' || result.status === 'dry_run') {
    await deps.store.markRoleRemoved(ctx.guildId, application.id, roleId);
    return { status: 'succeeded', result: { roleId } };
  }

  if (result.status === 'skipped_duplicate') {
    const again = await heldRoles(run, userId);
    if (Array.isArray(again) && !again.includes(roleId)) {
      await deps.store.markRoleRemoved(ctx.guildId, application.id, roleId);
      return { status: 'succeeded', result: { roleId } };
    }
    return retryOr(effect, now, { errorCode: 'unconfirmed', error: ROLE_UNCONFIRMED });
  }

  return roleFailure(effect, failureOf(result), now);
}

async function moduleOn(run: Run, moduleId: string): Promise<boolean | null> {
  const availability = run.deps.availability;
  if (availability === null) return true;

  try {
    return await availability.isEnabled(run.ctx.guildId, moduleId);
  } catch (error) {
    run.ctx.logger.warn(
      `applications could not tell whether ${moduleId} is on: ${reasonOf(error)}`,
      { guildId: run.ctx.guildId, moduleId: MODULE_ID },
    );
    return null;
  }
}

async function publish(
  run: Run,
  effect: EffectRecord,
  type: EventType,
  naturalKey: string,
  payload: unknown,
): Promise<EffectOutcome | null> {
  const { ctx } = run;
  if (!ctx.publish) {
    ctx.logger.error(
      'applications could not publish: this module’s context has no publish port. The process ' +
        'running modules must supply ModuleContext.publish.',
      { guildId: ctx.guildId, moduleId: MODULE_ID, type },
    );
    return { status: 'failed', errorCode: 'no_publish', error: NO_PUBLISH };
  }

  try {
    await ctx.publish(type, naturalKey, payload);
    return null;
  } catch (error) {
    ctx.logger.warn(
      `applications could not publish ${type}, so it will try again: ${reasonOf(error)}`,
      { guildId: ctx.guildId, moduleId: MODULE_ID },
    );
    return retryOr(effect, run.deps.now(), { errorCode: 'publish_failed', error: NO_PUBLISH });
  }
}

async function runXp(run: Run, effect: EffectRecord, subject: Subject): Promise<EffectOutcome> {
  const { ctx, deps } = run;
  const { application, form } = subject;

  if (form === null) return { status: 'skipped', errorCode: 'form_missing', error: FORM_GONE };
  if (form.actions.onAccept.xp <= 0) {
    return { status: 'skipped', errorCode: 'xp_off', error: XP_TURNED_OFF };
  }

  const amount = effect.params.amount;
  if (typeof amount !== 'number' || !Number.isInteger(amount) || amount < 1) {
    return {
      status: 'failed',
      errorCode: 'invalid_effect',
      error: 'This XP reward has no amount Proton can give.',
    };
  }

  const on = await moduleOn(run, 'leveling');
  if (on === false) return { status: 'failed', errorCode: 'leveling_off', error: LEVELING_OFF };
  if (on === null) {
    return retryOr(effect, deps.now(), {
      errorCode: 'availability_unknown',
      error: 'Couldn’t check whether Leveling is on. Proton will try again.',
    });
  }

  const grantId = str(effect.params.grantId) ?? xpGrantId(ctx.guildId, application.id);
  const parsed = xpGrantRequestedSchema.safeParse({
    guildId: ctx.guildId,
    userId: application.applicantId,
    grantId,
    amount,
    reason: `Application ${referenceOf(application.number)} accepted`.slice(0, XP_REASON_MAX),
    sourceModule: MODULE_ID,
    causation: {
      kind: 'reward',
      rootId: `${MODULE_ID}:${ctx.guildId}:${application.id}`,
      depth: 0,
      grantId,
      sourceModule: MODULE_ID,
    },
  });
  if (!parsed.success) {
    return {
      status: 'failed',
      errorCode: 'invalid_effect',
      error: 'Proton couldn’t build the request for this XP reward.',
    };
  }

  const refused = await publish(
    run,
    effect,
    'xp.grant_requested',
    `${grantId}:${effect.claimSeq}`,
    parsed.data,
  );
  return refused ?? { status: 'requested', result: { grantId, amount } };
}

function submittedValue(application: ApplicationRecord): string {
  const at = application.submittedAt ?? application.createdAt;
  return `<t:${Math.floor(at / 1000)}:f>`;
}

async function runTicket(run: Run, effect: EffectRecord, subject: Subject): Promise<EffectOutcome> {
  const { ctx, deps } = run;
  const { application, form, formName } = subject;

  if (form === null) return { status: 'failed', errorCode: 'form_missing', error: FORM_GONE };
  const typeId = form.interview.ticketTypeId;
  if (typeId === undefined) {
    return {
      status: 'failed',
      errorCode: 'no_ticket_type',
      error: `${formName} has no interview ticket type, so no ticket was opened.`,
    };
  }
  if (application.number === null) {
    return { status: 'failed', errorCode: 'invalid_effect', error: CHANGED };
  }

  const on = await moduleOn(run, 'tickets');
  if (on === false) return { status: 'failed', errorCode: 'tickets_off', error: TICKETS_OFF };
  if (on === null) {
    return retryOr(effect, deps.now(), {
      errorCode: 'availability_unknown',
      error: 'Couldn’t check whether Tickets is on. Proton will try again.',
    });
  }

  const requestedById = snowflake(effect.params.requestedById)
    ? effect.params.requestedById
    : application.applicantId;
  const reference = referenceOf(application.number);

  const parsed = ticketOpenRequestedSchema.safeParse({
    guildId: ctx.guildId,
    requestId: effect.id,
    sourceModule: MODULE_ID,
    sourceRef: application.id,
    typeId,
    ownerId: application.applicantId,
    requestedById,
    subject: clip(`${formName} ${reference}`, SUBJECT_MAX),
    context: [
      { label: 'Application', value: clip(formName, CONTEXT_VALUE_MAX) },
      { label: 'Reference', value: reference },
      { label: 'Submitted', value: submittedValue(application) },
    ],
    participantIds: requestedById === application.applicantId ? [] : [requestedById],
  });
  if (!parsed.success) {
    return {
      status: 'failed',
      errorCode: 'invalid_effect',
      error: 'Proton couldn’t build the request for this interview ticket.',
    };
  }

  const refused = await publish(
    run,
    effect,
    'tickets.open_requested',
    `${effect.id}:${effect.claimSeq}`,
    parsed.data,
  );
  return refused ?? { status: 'requested', result: { requestId: effect.id, typeId } };
}

function lifecycleType(value: unknown): ApplicationLifecycleEvent | null {
  return (APPLICATION_LIFECYCLE_EVENTS as readonly unknown[]).includes(value)
    ? (value as ApplicationLifecycleEvent)
    : null;
}

async function runEvent(run: Run, effect: EffectRecord): Promise<EffectOutcome> {
  const type = lifecycleType(effect.params.type);
  const payload = applicationLifecycleSchema.safeParse(effect.params.payload);
  if (type === null || !payload.success) {
    return {
      status: 'failed',
      errorCode: 'invalid_event',
      error: 'This update names no event other modules understand, so it wasn’t sent.',
    };
  }

  const refused = await publish(
    run,
    effect,
    type,
    `${payload.data.applicationId}:${payload.data.revision}`,
    payload.data,
  );
  return refused ?? { status: 'succeeded', result: { type } };
}

async function runDeleteCard(run: Run, effect: EffectRecord): Promise<EffectOutcome> {
  const { ctx, deps } = run;
  const channelId = effect.params.channelId;
  const messageId = effect.params.messageId;
  if (!snowflake(channelId) || !snowflake(messageId)) {
    return { status: 'skipped', errorCode: 'no_card', error: 'There was no card to remove.' };
  }

  const removed = await ctx.executor.execute({
    guildId: ctx.guildId,
    moduleId: MODULE_ID,
    kind: 'delete_message',
    actorId: APPLICATIONS_ACTOR,
    idempotencyKey: keyOf({ id: effect.applicationId }, 'delete-card', messageId),
    dryRun: false,
    record: false,
    payload: { channelId, messageId },
  });

  if (!failedResult(removed)) return { status: 'succeeded', result: { channelId, messageId } };

  const failure = failureOf(removed);
  if (gone(failure)) {
    return { status: 'succeeded', result: { channelId, messageId, alreadyGone: true } };
  }
  return failureOutcome(effect, failure, deps.now());
}

function outdated(effect: EffectRecord, subject: Subject): boolean {
  if (!RECONCILED.has(effect.kind)) return false;

  const statuses = TRIGGER_STATUSES[effect.trigger];
  if (statuses === undefined) return false;
  if (!statuses.includes(subject.application.status)) return true;
  // The grant id is per application, so an XP reward still owed after a reopen is still owed.
  if (effect.kind === 'xp') return false;

  return subject.detail.events.some(
    (event) =>
      event.revision > effect.revision &&
      event.fromStatus !== null &&
      statuses.includes(event.fromStatus) &&
      (event.toStatus === null || !statuses.includes(event.toStatus)),
  );
}

function fromGrants(effect: EffectRecord): boolean {
  return effect.kind === 'remove_role' && effect.params.fromGrants === true;
}

async function execute(run: Run, effect: EffectRecord): Promise<EffectOutcome> {
  if (effect.kind === 'delete_card') return runDeleteCard(run, effect);
  if (effect.kind === 'event') return runEvent(run, effect);

  const subject = await subjectOf(run, effect.applicationId);
  if (subject === null) {
    return { status: 'skipped', errorCode: 'missing', error: 'The application no longer exists.' };
  }
  if (subject.application.deletedAt !== null && !fromGrants(effect)) {
    return { status: 'skipped', errorCode: 'deleted', error: DELETED };
  }
  if (outdated(effect, subject)) return { status: 'skipped', errorCode: 'changed', error: CHANGED };

  switch (effect.kind) {
    case 'card':
      return runCard(run, effect, subject);
    case 'ping':
      return runPing(run, effect, subject);
    case 'dm':
      return runDm(run, effect, subject);
    case 'add_role':
      return runAddRole(run, effect, subject);
    case 'remove_role':
      return runRemoveRole(run, effect, subject);
    case 'xp':
      return runXp(run, effect, subject);
    case 'ticket':
      return runTicket(run, effect, subject);
    case 'reminder':
      return runReminder(run, effect, subject);
  }
}

export async function publishActionFailed(
  ctx: Ctx,
  deps: BoundApplicationsDeps,
  effect: Pick<
    EffectRecord,
    'id' | 'kind' | 'errorCode' | 'revision' | 'applicationId' | 'updatedAt'
  >,
  known?: { application: ApplicationRecord; formName: string },
): Promise<void> {
  if (!ctx.publish) return;

  const subject = known ?? (await loadSubject(ctx, deps, effect.applicationId));
  if (subject === null || subject.application.number === null) return;
  const { application } = subject;

  const payload = applicationActionFailedSchema.safeParse({
    guildId: ctx.guildId,
    applicationId: application.id,
    number: application.number,
    formId: application.formId,
    formName: clip(subject.formName, 100),
    effectId: effect.id,
    kind: effect.kind,
    errorCode: (effect.errorCode ?? 'unknown').slice(0, 64),
    revision: effect.revision,
    occurredAt: deps.now(),
  });
  if (!payload.success) return;

  try {
    await ctx.publish(
      'applications.action_failed',
      `${effect.id}:${effect.updatedAt}`,
      payload.data,
    );
  } catch (error) {
    ctx.logger.warn(`applications could not report a failed action: ${reasonOf(error)}`, {
      guildId: ctx.guildId,
      moduleId: MODULE_ID,
      applicationId: application.id,
      effectId: effect.id,
    });
  }
}

export async function refreshCard(
  ctx: Ctx,
  deps: BoundApplicationsDeps,
  applicationId: string,
  suffix: string,
): Promise<void> {
  if (!ctx.config.enabled) return;

  const subject = await loadSubject(ctx, deps, applicationId);
  if (subject === null) return;
  const { application } = subject;
  if (
    application.deletedAt !== null ||
    application.cardChannelId === null ||
    application.cardMessageId === null
  ) {
    return;
  }

  const rendered = await renderCard(ctx, deps, subject, application.cardChannelId, () =>
    readState(ctx, deps),
  );
  if (!rendered.ok) return;

  const edited = await ctx.executor.execute({
    guildId: ctx.guildId,
    moduleId: MODULE_ID,
    kind: 'edit_message',
    actorId: APPLICATIONS_ACTOR,
    idempotencyKey: keyOf(application, 'card-refresh', suffix),
    dryRun: false,
    record: false,
    payload: {
      ...cardPayload(application.cardChannelId, rendered.components),
      messageId: application.cardMessageId,
    },
  });

  if (failedResult(edited) && !gone(failureOf(edited))) {
    ctx.logger.warn('applications could not update a review card', {
      guildId: ctx.guildId,
      moduleId: MODULE_ID,
      applicationId,
      code: edited.failure?.code,
    });
  }
}

function due(effect: EffectRecord, now: number): boolean {
  const leaseFree = effect.leaseUntil === null || effect.leaseUntil <= now;
  if (effect.status === 'pending') return effect.nextAttemptAt <= now && leaseFree;
  return (effect.status === 'running' || effect.status === 'requested') && leaseFree;
}

function roleFirst(effect: EffectRecord): number {
  return ROLE_KINDS.has(effect.kind) ? 0 : 1;
}

// Roles before the rest of one decision, so its DM can tell the member whether they landed.
function byDue(a: EffectRecord, b: EffectRecord): number {
  return (
    a.nextAttemptAt - b.nextAttemptAt || a.createdAt - b.createdAt || roleFirst(a) - roleFirst(b)
  );
}

async function runsWhileOff(run: Run, effect: EffectRecord): Promise<boolean> {
  if (effect.kind === 'delete_card') return true;
  if (effect.kind !== 'card') return false;
  if (effect.trigger === PURGE_TRIGGER) return true;

  const subject = await subjectOf(run, effect.applicationId);
  return (
    subject === null ||
    subject.application.deletedAt !== null ||
    subject.application.contentPurgedAt !== null
  );
}

function newRun(ctx: Ctx, deps: BoundApplicationsDeps): Run {
  return { ctx, deps, subjects: new Map(), state: undefined, refresh: new Map() };
}

export async function pausedWorkDueAt(
  ctx: Ctx,
  deps: BoundApplicationsDeps,
  effects: readonly EffectRecord[],
): Promise<number | null> {
  const run = newRun(ctx, deps);
  let at: number | null = null;

  for (const effect of effects) {
    if (!(await runsWhileOff(run, effect))) continue;
    const due =
      effect.status === 'pending'
        ? Math.max(effect.nextAttemptAt, effect.leaseUntil ?? effect.nextAttemptAt)
        : (effect.leaseUntil ?? effect.updatedAt);
    at = at === null ? due : Math.min(at, due);
  }
  return at;
}

async function runOne(run: Run, candidate: EffectRecord): Promise<void> {
  const { ctx, deps } = run;
  const claim = await deps.store.claimEffect(
    ctx.guildId,
    candidate.id,
    deps.now(),
    EFFECT_LEASE_MS,
  );
  if (claim === null) return;

  const effect = claim.effect;
  let outcome: EffectOutcome;
  try {
    outcome = effect.attempts > EFFECT_ATTEMPTS_MAX ? gaveUp(effect) : await execute(run, effect);
  } catch (error) {
    ctx.logger.error(`applications could not run an effect: ${reasonOf(error)}`, {
      guildId: ctx.guildId,
      moduleId: MODULE_ID,
      applicationId: effect.applicationId,
      effectId: effect.id,
      kind: effect.kind,
    });
    outcome = retryOr(effect, deps.now(), {
      errorCode: 'internal_error',
      error: 'Proton hit a problem doing this and will try again.',
    });
  }

  const finished = await deps.store.finishEffect(ctx.guildId, effect.id, claim.token, outcome);
  if (!finished) return;

  const subject = run.subjects.get(effect.applicationId) ?? null;
  const onCard = effect.kind !== 'card' && effect.kind !== 'delete_card';

  if (outcome.status === 'failed') {
    await publishActionFailed(
      ctx,
      deps,
      { ...effect, errorCode: outcome.errorCode ?? null },
      subject === null
        ? undefined
        : { application: subject.application, formName: subject.formName },
    );
    if (onCard) run.refresh.set(effect.applicationId, `problem:${effect.id}:${effect.claimSeq}`);
    return;
  }

  const retried = (subject?.detail.events ?? []).filter(
    (event) => event.kind === 'effect_retried' && event.data.effectId === effect.id,
  ).length;
  if (onCard && retried > 0 && outcome.status !== 'pending') {
    run.refresh.set(effect.applicationId, `resolved:${effect.id}:${retried}`);
  }
}

export async function runEffects(
  ctx: Ctx,
  deps: BoundApplicationsDeps,
  effects: readonly EffectRecord[],
  loaded?: Subject,
): Promise<number> {
  const run = newRun(ctx, deps);
  if (loaded !== undefined) run.subjects.set(loaded.application.id, loaded);
  const enabled = ctx.config.enabled;

  let ran = 0;
  for (const effect of [...effects].sort(byDue)) {
    if (!enabled && !(await runsWhileOff(run, effect))) continue;
    await runOne(run, effect);
    ran += 1;
  }

  for (const [applicationId, suffix] of run.refresh) {
    await refreshCard(ctx, deps, applicationId, suffix);
  }
  return ran;
}

export async function runApplicationWork(
  ctx: Ctx,
  deps: BoundApplicationsDeps,
  applicationId?: string,
): Promise<void> {
  const now = deps.now();

  if (applicationId !== undefined) {
    const subject = await loadSubject(ctx, deps, applicationId);
    if (subject === null) return;
    const effects = subject.detail.effects.filter((effect) => due(effect, now));
    if (effects.length > 0) await runEffects(ctx, deps, effects, subject);
    return;
  }

  const work = await deps.store.dueWork(ctx.guildId, now, WORK_BATCH);
  await runEffects(ctx, deps, work.effects);
}

export async function armSweep(ctx: Ctx, at: number = Date.now()): Promise<void> {
  if (!ctx.schedule) {
    ctx.logger.warn(
      'applications could not arm its sweep: this module’s context has no schedule port, so ' +
        'effects a failure left behind wait for the next state change. The process running ' +
        'modules must supply ModuleContext.schedule.',
      { guildId: ctx.guildId, moduleId: MODULE_ID },
    );
    return;
  }

  const slot = wakeSlot(at);
  await ctx.schedule(SWEEP_JOB, new Date(slot), `${WAKE_KEY}:${slot}`, {});
}

export async function requestWork(
  ctx: Ctx,
  deps: Pick<BoundApplicationsDeps, 'now'>,
  applicationId: string,
): Promise<void> {
  const at = deps.now();
  const where = { guildId: ctx.guildId, moduleId: MODULE_ID, applicationId };

  try {
    if (!ctx.publish) throw new Error('this module’s context has no publish port');
    const payload = applicationWorkRequestedSchema.parse({
      guildId: ctx.guildId,
      applicationId,
      reason: 'decision',
    });
    await ctx.publish('applications.work_requested', `${applicationId}:${at}`, payload);
    return;
  } catch (error) {
    ctx.logger.warn(
      `applications could not queue the work for an application, so its sweep will: ${reasonOf(error)}`,
      where,
    );
  }

  try {
    await armSweep(ctx, at);
  } catch (error) {
    ctx.logger.error(
      `applications could not queue the work for an application or arm its sweep, so it waits for the next patrol: ${reasonOf(error)}`,
      where,
    );
  }
}
