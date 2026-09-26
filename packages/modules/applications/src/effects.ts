import type { ApplicationLifecycle, ApplicationLifecycleEvent } from '@proton/core';
import {
  type ApplicantMessageKey,
  type ApplicationsConfig,
  type FormConfig,
  type Outcome,
  type OutcomeKey,
  reviewChannelFor,
} from './config.ts';
import { APPLICATIONS_ACTOR } from './constants.ts';
import type { ApplicationRecord } from './store.ts';
import type { EFFECT_KINDS, EFFECT_STATUSES } from './view.ts';

export type EffectKind = (typeof EFFECT_KINDS)[number];
export type EffectStatus = (typeof EFFECT_STATUSES)[number];

export interface EffectPlan {
  key: string;
  kind: EffectKind;
  trigger: string;
  params: Record<string, unknown>;
}

export interface PlanInput {
  config: ApplicationsConfig;
  form: FormConfig;
  application: ApplicationRecord;
  revision: number;
  now: number;
  actorId?: string | undefined;
}

export type DmMessage = ApplicantMessageKey | 'expired';

export const CARD_KEY = 'card';
export const DELETE_CARD_KEY = 'delete_card';
export const XP_KEY = 'accepted:xp';

export const LIFECYCLE_TRIGGERS: Readonly<Record<ApplicationLifecycleEvent, string>> = {
  'applications.submitted': 'submitted',
  'applications.review_started': 'review_started',
  'applications.information_requested': 'info',
  'applications.information_provided': 'info_provided',
  'applications.waitlisted': 'waitlisted',
  'applications.accepted': 'accepted',
  'applications.rejected': 'rejected',
  'applications.withdrawn': 'withdrawn',
  'applications.reopened': 'reopened',
  'applications.expired': 'expired',
};

const OUTCOMES: Partial<Record<ApplicationLifecycleEvent, OutcomeKey>> = {
  'applications.submitted': 'onSubmit',
  'applications.accepted': 'onAccept',
  'applications.rejected': 'onReject',
  'applications.waitlisted': 'onWaitlist',
  'applications.withdrawn': 'onWithdraw',
};

const DM_MESSAGES: Partial<Record<ApplicationLifecycleEvent, DmMessage>> = {
  'applications.submitted': 'receipt',
  'applications.information_requested': 'infoRequest',
  'applications.waitlisted': 'waitlisted',
  'applications.accepted': 'accepted',
  'applications.rejected': 'rejected',
  'applications.withdrawn': 'withdrawn',
  'applications.expired': 'expired',
};

const DECISION_EVENTS: ReadonlySet<ApplicationLifecycleEvent> = new Set([
  'applications.accepted',
  'applications.rejected',
  'applications.waitlisted',
]);

const CLOSING: ReadonlySet<ApplicationLifecycleEvent> = new Set([
  'applications.accepted',
  'applications.rejected',
  'applications.withdrawn',
  'applications.expired',
]);

export function xpGrantId(guildId: string, applicationId: string): string {
  return `applications:${guildId}:${applicationId}:accepted`;
}

function defaultActor(event: ApplicationLifecycleEvent, application: ApplicationRecord): string {
  switch (event) {
    case 'applications.submitted':
    case 'applications.withdrawn':
    case 'applications.information_provided':
      return application.applicantId;
    case 'applications.accepted':
    case 'applications.rejected':
    case 'applications.waitlisted':
      return application.decidedBy ?? APPLICATIONS_ACTOR;
    case 'applications.review_started':
      return application.assigneeId ?? APPLICATIONS_ACTOR;
    default:
      return APPLICATIONS_ACTOR;
  }
}

export function lifecycleOf(
  event: ApplicationLifecycleEvent,
  input: PlanInput,
): ApplicationLifecycle | null {
  const { application } = input;
  if (application.number === null) return null;

  return {
    guildId: application.guildId,
    applicationId: application.id,
    number: application.number,
    formId: application.formId,
    formName: input.form.name,
    versionId: application.versionId,
    applicantId: application.applicantId,
    actorId: input.actorId ?? defaultActor(event, application),
    revision: input.revision,
    status: application.status,
    occurredAt: input.now,
  };
}

export function planCard(
  input: PlanInput,
  trigger = 'card',
  options: { repost?: boolean } = {},
): EffectPlan[] {
  const channelId = reviewChannelFor(input.config, input.form);
  if (channelId === undefined) return [];

  return [
    {
      key: CARD_KEY,
      kind: 'card',
      trigger,
      params: { channelId, ...(options.repost === true ? { repost: true } : {}) },
    },
  ];
}

function roleEffects(
  trigger: string,
  revision: number,
  outcome: Outcome,
  userId: string,
): EffectPlan[] {
  return [
    ...outcome.addRoleIds.map(
      (roleId): EffectPlan => ({
        key: `${trigger}:${revision}:add_role:${roleId}`,
        kind: 'add_role',
        trigger,
        params: { roleId, userId },
      }),
    ),
    ...outcome.removeRoleIds.map(
      (roleId): EffectPlan => ({
        key: `${trigger}:${revision}:remove_role:${roleId}`,
        kind: 'remove_role',
        trigger,
        params: { roleId, userId },
      }),
    ),
  ];
}

function cleanupEffect(
  trigger: string,
  revision: number,
  form: FormConfig,
  outcome: Outcome | undefined,
  userId: string,
): EffectPlan[] {
  if (!form.actions.removeSubmitRolesOnClose) return [];

  const adding = new Set(outcome?.addRoleIds ?? []);
  const roleIds = form.actions.onSubmit.addRoleIds.filter((roleId) => !adding.has(roleId));
  if (roleIds.length === 0) return [];

  return [
    {
      key: `${trigger}:${revision}:cleanup`,
      kind: 'remove_role',
      trigger,
      params: { fromGrants: true, roleIds, userId },
    },
  ];
}

export function planEffects(
  event: ApplicationLifecycleEvent | 'card_only',
  input: PlanInput,
): EffectPlan[] {
  if (event === 'card_only') return planCard(input);

  const { application, form, revision } = input;
  const trigger = LIFECYCLE_TRIGGERS[event];
  const userId = application.applicantId;
  const plans: EffectPlan[] = [...planCard(input, trigger)];

  const message = DM_MESSAGES[event];
  if (message !== undefined && form.notify.dm) {
    const moderatorId =
      DECISION_EVENTS.has(event) && input.actorId !== undefined && /^\d{17,20}$/.test(input.actorId)
        ? input.actorId
        : undefined;
    plans.push({
      key: `${trigger}:${revision}:dm`,
      kind: 'dm',
      trigger,
      params: { message, userId, ...(moderatorId === undefined ? {} : { moderatorId }) },
    });
  }

  const channelId = reviewChannelFor(input.config, form);
  if (
    event === 'applications.submitted' &&
    channelId !== undefined &&
    form.review.pingRoleIds.length > 0
  ) {
    plans.push({
      key: `${trigger}:${revision}:ping`,
      kind: 'ping',
      trigger,
      params: { channelId, roleIds: [...form.review.pingRoleIds] },
    });
  }

  const outcomeKey = OUTCOMES[event];
  const outcome = outcomeKey === undefined ? undefined : form.actions[outcomeKey];
  if (outcome !== undefined) plans.push(...roleEffects(trigger, revision, outcome, userId));

  if (CLOSING.has(event)) plans.push(...cleanupEffect(trigger, revision, form, outcome, userId));

  if (event === 'applications.accepted' && form.actions.onAccept.xp > 0) {
    plans.push({
      key: XP_KEY,
      kind: 'xp',
      trigger,
      params: {
        amount: form.actions.onAccept.xp,
        userId,
        grantId: xpGrantId(application.guildId, application.id),
      },
    });
  }

  const payload = lifecycleOf(event, input);
  if (payload !== null) {
    plans.push({
      key: `event:${trigger}:${revision}`,
      kind: 'event',
      trigger,
      params: { type: event, payload },
    });
  }

  return plans;
}

export function planTicket(input: PlanInput): EffectPlan[] {
  const typeId = input.form.interview.ticketTypeId;
  if (typeId === undefined) return [];

  return [
    ...planCard(input, 'ticket'),
    {
      key: `ticket:${input.revision}`,
      kind: 'ticket',
      trigger: 'ticket',
      params: {
        typeId,
        userId: input.application.applicantId,
        ...(input.actorId === undefined ? {} : { requestedById: input.actorId }),
      },
    },
  ];
}

export function planReminder(input: PlanInput): EffectPlan[] {
  const channelId = reviewChannelFor(input.config, input.form);
  if (channelId === undefined) return [];

  return [
    {
      key: `reminder:${input.revision}`,
      kind: 'reminder',
      trigger: 'reminder',
      params: { channelId },
    },
  ];
}

export function deleteCardPlan(
  application: Pick<ApplicationRecord, 'cardChannelId' | 'cardMessageId'>,
): EffectPlan | null {
  if (application.cardChannelId === null || application.cardMessageId === null) return null;

  return {
    key: DELETE_CARD_KEY,
    kind: 'delete_card',
    trigger: 'delete',
    params: { channelId: application.cardChannelId, messageId: application.cardMessageId },
  };
}
