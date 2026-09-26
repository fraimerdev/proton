import { describe, expect, test } from 'bun:test';
import {
  APPLICATION_LIFECYCLE_EVENTS,
  type ApplicationLifecycleEvent,
  applicationLifecycleSchema,
} from '@proton/core';
import { applicationsConfigSchema } from '../src/config.ts';
import { APPLICATIONS_ACTOR } from '../src/constants.ts';
import {
  deleteCardPlan,
  type EffectPlan,
  LIFECYCLE_TRIGGERS,
  type PlanInput,
  planCard,
  planEffects,
  planReminder,
  planTicket,
  XP_KEY,
  xpGrantId,
} from '../src/effects.ts';
import type { ApplicationRecord } from '../src/store.ts';
import { EFFECT_KINDS } from '../src/view.ts';
import { applicationRecord } from './memory-store.ts';

const GUILD = '900000000000000001';
const CHANNEL = '300000000000000001';
const FORM_CHANNEL = '300000000000000002';
const APPLICANT = '400000000000000001';
const REVIEWER = '100000000000000001';
const ROLE_A = '200000000000000001';
const ROLE_B = '200000000000000002';
const ROLE_C = '200000000000000003';
const PING_ROLE = '200000000000000009';
const NOW = Date.UTC(2026, 8, 24, 12, 0, 0, 5);

interface Setup {
  form?: Record<string, unknown>;
  settings?: Record<string, unknown>;
  application?: Partial<ApplicationRecord>;
  revision?: number;
  actorId?: string;
}

function planInput(setup: Setup = {}): PlanInput {
  const config = applicationsConfigSchema.parse({
    reviewChannelId: CHANNEL,
    ...setup.settings,
    forms: [{ id: 'mods', name: 'Moderator Application', ...setup.form }],
  });
  const form = config.forms[0];
  if (form === undefined) throw new Error('the test form did not parse');

  const revision = setup.revision ?? 2;
  return {
    config,
    form,
    application: applicationRecord({
      id: 'app-7',
      guildId: GUILD,
      number: 7,
      applicantId: APPLICANT,
      revision,
      ...setup.application,
    }),
    revision,
    now: NOW,
    ...(setup.actorId === undefined ? {} : { actorId: setup.actorId }),
  };
}

function keys(plans: readonly EffectPlan[]): string[] {
  return plans.map((plan) => plan.key);
}

function find(plans: readonly EffectPlan[], key: string): EffectPlan {
  const plan = plans.find((candidate) => candidate.key === key);
  if (plan === undefined) throw new Error(`no effect planned under ${key}`);
  return plan;
}

describe('planEffects: submitted', () => {
  test('a plain form plans the card, the receipt DM and the lifecycle event', () => {
    const plans = planEffects('applications.submitted', planInput());

    expect(keys(plans)).toEqual(['card', 'submitted:2:dm', 'event:submitted:2']);
    expect(find(plans, 'card')).toEqual({
      key: 'card',
      kind: 'card',
      trigger: 'submitted',
      params: { channelId: CHANNEL },
    });
    expect(find(plans, 'submitted:2:dm').params).toEqual({
      message: 'receipt',
      userId: APPLICANT,
    });
  });

  test('pings and submit roles each get their own effect', () => {
    const plans = planEffects(
      'applications.submitted',
      planInput({
        form: {
          review: { pingRoleIds: [PING_ROLE] },
          actions: { onSubmit: { addRoleIds: [ROLE_A], removeRoleIds: [ROLE_B] } },
        },
      }),
    );

    expect(keys(plans)).toEqual([
      'card',
      'submitted:2:dm',
      'submitted:2:ping',
      `submitted:2:add_role:${ROLE_A}`,
      `submitted:2:remove_role:${ROLE_B}`,
      'event:submitted:2',
    ]);
    expect(find(plans, 'submitted:2:ping').params).toEqual({
      channelId: CHANNEL,
      roleIds: [PING_ROLE],
    });
    expect(find(plans, `submitted:2:add_role:${ROLE_A}`)).toMatchObject({
      kind: 'add_role',
      params: { roleId: ROLE_A, userId: APPLICANT },
    });
    expect(find(plans, `submitted:2:remove_role:${ROLE_B}`).kind).toBe('remove_role');
  });

  test('the form’s own review channel wins over the default', () => {
    const plans = planEffects(
      'applications.submitted',
      planInput({ form: { review: { channelId: FORM_CHANNEL } } }),
    );
    expect(find(plans, 'card').params).toEqual({ channelId: FORM_CHANNEL });
  });

  test('without a review channel there is no card and no ping', () => {
    const plans = planEffects(
      'applications.submitted',
      planInput({
        settings: { reviewChannelId: undefined },
        form: { review: { pingRoleIds: [PING_ROLE] } },
      }),
    );
    expect(keys(plans)).toEqual(['submitted:2:dm', 'event:submitted:2']);
  });

  test('DMs switched off plan no DM', () => {
    const plans = planEffects(
      'applications.submitted',
      planInput({ form: { notify: { dm: false } } }),
    );
    expect(keys(plans)).toEqual(['card', 'event:submitted:2']);
  });
});

describe('planEffects: decisions', () => {
  const actions = {
    onSubmit: { addRoleIds: [ROLE_A, ROLE_C] },
    onAccept: { addRoleIds: [ROLE_B, ROLE_C], xp: 250 },
    onReject: { removeRoleIds: [ROLE_B] },
    onWaitlist: { addRoleIds: [ROLE_B] },
  };

  test('accepting gives outcome roles, cleans up submit roles it does not re-add, and one XP reward', () => {
    const plans = planEffects(
      'applications.accepted',
      planInput({
        form: { actions },
        application: { status: 'accepted', decidedBy: REVIEWER },
        revision: 5,
      }),
    );

    expect(keys(plans)).toEqual([
      'card',
      'accepted:5:dm',
      `accepted:5:add_role:${ROLE_B}`,
      `accepted:5:add_role:${ROLE_C}`,
      'accepted:5:cleanup',
      XP_KEY,
      'event:accepted:5',
    ]);
    expect(find(plans, 'accepted:5:cleanup')).toEqual({
      key: 'accepted:5:cleanup',
      kind: 'remove_role',
      trigger: 'accepted',
      params: { fromGrants: true, roleIds: [ROLE_A], userId: APPLICANT },
    });
    expect(find(plans, XP_KEY)).toEqual({
      key: 'accepted:xp',
      kind: 'xp',
      trigger: 'accepted',
      params: { amount: 250, userId: APPLICANT, grantId: xpGrantId(GUILD, 'app-7') },
    });
  });

  test('the XP key carries no revision, so a reopened and re-accepted application is paid once', () => {
    const first = planEffects(
      'applications.accepted',
      planInput({ form: { actions }, application: { status: 'accepted' }, revision: 3 }),
    );
    const again = planEffects(
      'applications.accepted',
      planInput({ form: { actions }, application: { status: 'accepted' }, revision: 9 }),
    );

    expect(keys(first)).toContain(XP_KEY);
    expect(keys(again)).toContain(XP_KEY);
    expect(keys(first)).toContain('accepted:3:dm');
    expect(keys(again)).toContain('accepted:9:dm');
  });

  test('a waitlist is not a close, so submit roles stay', () => {
    const plans = planEffects(
      'applications.waitlisted',
      planInput({ form: { actions }, application: { status: 'waitlisted' } }),
    );
    expect(keys(plans)).toEqual([
      'card',
      'waitlisted:2:dm',
      `waitlisted:2:add_role:${ROLE_B}`,
      'event:waitlisted:2',
    ]);
  });

  test('rejecting, withdrawing and expiring all clean up submit roles', () => {
    for (const [event, status] of [
      ['applications.rejected', 'rejected'],
      ['applications.withdrawn', 'withdrawn'],
      ['applications.expired', 'expired'],
    ] as const) {
      const plans = planEffects(event, planInput({ form: { actions }, application: { status } }));
      const trigger = LIFECYCLE_TRIGGERS[event];
      expect(find(plans, `${trigger}:2:cleanup`).params).toEqual({
        fromGrants: true,
        roleIds: [ROLE_A, ROLE_C],
        userId: APPLICANT,
      });
      expect(keys(plans)).not.toContain(XP_KEY);
    }
  });

  test('cleanup is skipped when the form keeps submit roles', () => {
    const plans = planEffects(
      'applications.rejected',
      planInput({
        form: { actions: { ...actions, removeSubmitRolesOnClose: false } },
        application: { status: 'rejected' },
      }),
    );
    expect(keys(plans).some((key) => key.endsWith(':cleanup'))).toBe(false);
  });

  test('an expired application gets the fixed DM copy', () => {
    const plans = planEffects(
      'applications.expired',
      planInput({ application: { status: 'expired' } }),
    );
    expect(find(plans, 'expired:2:dm').params).toEqual({ message: 'expired', userId: APPLICANT });
  });

  test('an information request DMs the question', () => {
    const plans = planEffects(
      'applications.information_requested',
      planInput({ application: { status: 'needs_info' } }),
    );
    expect(keys(plans)).toEqual(['card', 'info:2:dm', 'event:info:2']);
    expect(find(plans, 'info:2:dm').params).toEqual({ message: 'infoRequest', userId: APPLICANT });
  });

  test('reopening, answering and claiming never rerun outcome actions', () => {
    for (const event of [
      'applications.reopened',
      'applications.information_provided',
      'applications.review_started',
    ] as const) {
      const plans = planEffects(event, planInput({ form: { actions } }));
      const trigger = LIFECYCLE_TRIGGERS[event];
      expect(keys(plans)).toEqual(['card', `event:${trigger}:2`]);
    }
  });
});

describe('planEffects: invariants', () => {
  test('every lifecycle event plans unique keys of known kinds, and the same input plans the same', () => {
    const everything = {
      review: { pingRoleIds: [PING_ROLE] },
      actions: {
        onSubmit: { addRoleIds: [ROLE_A], removeRoleIds: [ROLE_B] },
        onAccept: { addRoleIds: [ROLE_B], removeRoleIds: [ROLE_A], xp: 10 },
        onReject: { addRoleIds: [ROLE_C] },
        onWaitlist: { removeRoleIds: [ROLE_C] },
        onWithdraw: { removeRoleIds: [ROLE_B] },
      },
    };

    for (const event of APPLICATION_LIFECYCLE_EVENTS) {
      const plans = planEffects(event, planInput({ form: everything }));
      const planned = keys(plans);

      expect(new Set(planned).size).toBe(planned.length);
      expect(plans.every((plan) => (EFFECT_KINDS as readonly string[]).includes(plan.kind))).toBe(
        true,
      );
      expect(planEffects(event, planInput({ form: everything }))).toEqual(plans);
    }
  });

  test('every event effect carries a lifecycle payload the bus accepts', () => {
    for (const event of APPLICATION_LIFECYCLE_EVENTS) {
      const plans = planEffects(event, planInput({ application: { status: 'in_review' } }));
      const planned = find(plans, `event:${LIFECYCLE_TRIGGERS[event]}:2`);

      expect(planned.kind).toBe('event');
      expect(planned.params.type).toBe(event);
      expect(applicationLifecycleSchema.parse(planned.params.payload)).toEqual({
        guildId: GUILD,
        applicationId: 'app-7',
        number: 7,
        formId: 'mods',
        formName: 'Moderator Application',
        versionId: 'version-1',
        applicantId: APPLICANT,
        actorId: expect.any(String),
        revision: 2,
        status: 'in_review',
        occurredAt: NOW,
      });
    }
  });

  test('the actor defaults by event and yields to the one the caller names', () => {
    const actorOf = (event: ApplicationLifecycleEvent, setup: Setup = {}) => {
      const plans = planEffects(event, planInput(setup));
      const planned = find(plans, `event:${LIFECYCLE_TRIGGERS[event]}:2`);
      return (planned.params.payload as { actorId: string }).actorId;
    };

    expect(actorOf('applications.submitted')).toBe(APPLICANT);
    expect(actorOf('applications.withdrawn')).toBe(APPLICANT);
    expect(actorOf('applications.accepted', { application: { decidedBy: REVIEWER } })).toBe(
      REVIEWER,
    );
    expect(actorOf('applications.review_started', { application: { assigneeId: REVIEWER } })).toBe(
      REVIEWER,
    );
    expect(actorOf('applications.expired')).toBe(APPLICATIONS_ACTOR);
    expect(actorOf('applications.rejected', { actorId: REVIEWER })).toBe(REVIEWER);
  });

  test('an application without a reference number plans no event', () => {
    const plans = planEffects(
      'applications.submitted',
      planInput({ application: { number: null } }),
    );
    expect(plans.some((plan) => plan.kind === 'event')).toBe(false);
  });

  test('no plan carries answer text or reasons', () => {
    const plans = APPLICATION_LIFECYCLE_EVENTS.flatMap((event) =>
      planEffects(
        event,
        planInput({
          application: {
            decisionReason: 'SECRET REASON',
            answers: [
              {
                questionId: 'why',
                sectionId: 'about',
                label: 'Why?',
                type: 'paragraph',
                value: 'SECRET ANSWER',
                display: 'SECRET ANSWER',
              },
            ],
          },
        }),
      ),
    );
    expect(JSON.stringify(plans)).not.toContain('SECRET');
  });
});

describe('card, ticket, reminder and delete plans', () => {
  test('card_only plans just the card, or nothing without a review channel', () => {
    expect(planEffects('card_only', planInput())).toEqual([
      { key: 'card', kind: 'card', trigger: 'card', params: { channelId: CHANNEL } },
    ]);
    expect(
      planEffects('card_only', planInput({ settings: { reviewChannelId: undefined } })),
    ).toEqual([]);
    expect(planCard(planInput(), 'repost', { repost: true })).toEqual([
      {
        key: 'card',
        kind: 'card',
        trigger: 'repost',
        params: { channelId: CHANNEL, repost: true },
      },
    ]);
  });

  test('an interview ticket needs a ticket type and is keyed by revision', () => {
    expect(planTicket(planInput())).toEqual([]);

    const plans = planTicket(
      planInput({ form: { interview: { ticketTypeId: 'interview' } }, revision: 4 }),
    );
    expect(keys(plans)).toEqual(['card', 'ticket:4']);
    expect(find(plans, 'ticket:4')).toEqual({
      key: 'ticket:4',
      kind: 'ticket',
      trigger: 'ticket',
      params: { typeId: 'interview', userId: APPLICANT },
    });
  });

  test('a reminder goes to the review channel', () => {
    expect(planReminder(planInput({ revision: 3 }))).toEqual([
      { key: 'reminder:3', kind: 'reminder', trigger: 'reminder', params: { channelId: CHANNEL } },
    ]);
    expect(planReminder(planInput({ settings: { reviewChannelId: undefined } }))).toEqual([]);
  });

  test('deleting removes the card only when one was posted', () => {
    expect(deleteCardPlan({ cardChannelId: null, cardMessageId: null })).toBeNull();
    const card = { cardChannelId: CHANNEL, cardMessageId: '500000000000000001' };
    expect(deleteCardPlan(card)).toEqual({
      key: 'delete_card',
      kind: 'delete_card',
      trigger: 'delete',
      params: { channelId: CHANNEL, messageId: '500000000000000001' },
    });
  });
});
