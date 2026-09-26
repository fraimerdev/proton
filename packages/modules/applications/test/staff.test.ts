import { describe, expect, test } from 'bun:test';
import { MAX_CUSTOM_ID_LENGTH, Permissions, type ProtonEvent } from '@proton/core';
import { customId, MORE_CHOICES, STAFF_ACTION } from '../src/interface.ts';
import {
  ADMIN,
  APP_ID,
  APPLICANT,
  type Call,
  COMPONENTS_V2,
  configWith,
  customIds,
  DECIDER,
  DECIDER_ROLE,
  EPHEMERAL,
  formConfig,
  GUILD,
  Harness,
  NOW,
  OTHER_GUILD,
  OUTSIDER,
  OVERRIDE_ROLE,
  REVIEWER,
  REVIEWER_ROLE,
  SECOND,
  said,
  selectValues,
  staff,
  textOf,
  VIEWER_ROLE,
} from './staff-harness.ts';

const DAY = 24 * 60 * 60 * 1000;
const DEFERRED = 5;
const DEFERRED_UPDATE = 6;
const MODAL = 9;
const REPLY = 4;

const accept = customId(STAFF_ACTION.accept, APP_ID);
const reject = customId(STAFF_ACTION.reject, APP_ID);
const acceptModal = customId(STAFF_ACTION.acceptModal, APP_ID);
const rejectModal = customId(STAFF_ACTION.rejectModal, APP_ID);
const claim = customId(STAFF_ACTION.claim, APP_ID);
const unclaim = customId(STAFF_ACTION.unclaim, APP_ID);
const more = customId(STAFF_ACTION.more, APP_ID);
const card = customId(STAFF_ACTION.card, APP_ID);

function first(h: Harness, event: ProtonEvent): Call | undefined {
  return h.answersTo(event)[0];
}

function callback(call: Call | undefined): number | undefined {
  return call?.payload.callbackType as number | undefined;
}

function spoken(h: Harness, event: ProtonEvent): Call | undefined {
  return h
    .answersTo(event)
    .filter((call) => call.status === 'executed')
    .filter(
      (call) =>
        call.kind !== 'interaction_reply' || callback(call) === REPLY || callback(call) === 7,
    )
    .at(-1);
}

function reply(h: Harness, event: ProtonEvent): string {
  return said(spoken(h, event));
}

function modalOf(call: Call | undefined): {
  customId: string;
  title: string;
  components: Record<string, unknown>[];
} {
  const modal = call?.payload.modal as
    | { customId: string; title: string; components: Record<string, unknown>[] }
    | undefined;
  if (modal === undefined) throw new Error('no modal was opened');
  return modal;
}

function fieldIds(components: readonly Record<string, unknown>[]): string[] {
  return customIds(components);
}

function interactionErrors(h: Harness): string[] {
  return h.invalid.filter((line) => line.startsWith('interaction_'));
}

async function decide(
  h: Harness,
  decision: 'accept' | 'reject',
  options: {
    userId?: string;
    reason?: string;
    note?: string;
    score?: string;
    override?: boolean;
  } = {},
): Promise<ProtonEvent> {
  const event = h.submit(decision === 'accept' ? acceptModal : rejectModal, {
    userId: options.userId ?? REVIEWER,
    fields: {
      ...(options.reason === undefined ? {} : { reason: options.reason }),
      ...(options.note === undefined ? {} : { note: options.note }),
    },
    ...(options.score === undefined ? {} : { radios: { score: options.score } }),
    ...(options.override === undefined ? {} : { checks: { override: options.override } }),
  });
  await h.run(event);
  return event;
}

describe('reviewActorOf', () => {
  test('reads the presser’s roles and channel permissions from the payload, never ownership', () => {
    const h = new Harness();
    const actor = staff.reviewActorOf(h.press(claim, { userId: SECOND, roleIds: ['1', '2'] }));

    expect(actor).toEqual({ id: SECOND, roleIds: ['1', '2'], permissions: 1024n, owner: false });
  });

  test('a press with no member (a DM) has no reviewer behind it', () => {
    const h = new Harness();
    const event = h.press(claim);
    const payload = event.payload as Record<string, unknown>;
    const { member: _member, ...rest } = payload;

    expect(staff.reviewActorOf({ ...event, payload: { ...rest, user: { id: REVIEWER } } })).toBe(
      null,
    );
  });
});

describe('every press is checked again', () => {
  test('a module switched off in its own settings answers and changes nothing', async () => {
    const h = new Harness(configWith({ enabled: false }));
    const application = h.seed();
    const event = h.press(claim);

    await h.run(event);

    expect(callback(first(h, event))).toBe(REPLY);
    expect(reply(h, event)).toContain('Applications is off in this server');
    expect(await h.store.get(GUILD, APP_ID)).toEqual(application);
  });

  test('an application from another server is never found', async () => {
    const h = new Harness();
    h.seed({ guildId: OTHER_GUILD });
    const event = h.press(claim);

    await h.run(event);

    expect(reply(h, event)).toContain('I can’t find the application');
    expect((await h.store.get(OTHER_GUILD, APP_ID))?.status).toBe('submitted');
  });

  test('a deleted application is refused, though get() still returns its tombstone', async () => {
    const h = new Harness();
    h.seed({ deletedAt: NOW - 1 });
    const event = h.press(accept);

    await h.run(event);

    expect(callback(first(h, event))).toBe(REPLY);
    expect(reply(h, event)).toContain('Application #12 was deleted');
  });

  test('someone outside the review team is refused', async () => {
    const h = new Harness();
    h.seed();
    const event = h.press(claim, { userId: OUTSIDER });

    await h.run(event);

    expect(reply(h, event)).toContain('You aren’t on the review team for Moderator Application.');
    expect((await h.store.get(GUILD, APP_ID))?.assigneeId).toBe(null);
  });

  test('nobody reviews their own application, even from the review team', async () => {
    const h = new Harness();
    h.seed();

    const pressed = h.press(accept, { userId: APPLICANT });
    await h.run(pressed);
    expect(callback(first(h, pressed))).toBe(REPLY);
    expect(reply(h, pressed)).toContain('You can’t review your own application.');

    const submitted = await decide(h, 'accept', { userId: APPLICANT });
    expect(reply(h, submitted)).toContain('You can’t review your own application.');
    expect((await h.store.get(GUILD, APP_ID))?.status).toBe('submitted');
  });

  test('a reviewer whose role left the review team is refused on their next press', async () => {
    const h = new Harness();
    h.seed();

    const claimed = h.press(claim);
    await h.run(claimed);
    expect((await h.store.get(GUILD, APP_ID))?.assigneeId).toBe(REVIEWER);

    h.setConfig(configWith({ reviewerRoleIds: [DECIDER_ROLE], deciderRoleIds: [DECIDER_ROLE] }));
    const again = h.press(unclaim);
    await h.run(again);

    expect(reply(h, again)).toContain('You aren’t on the review team');
    expect((await h.store.get(GUILD, APP_ID))?.status).toBe('in_review');
  });

  test('a reviewer who lost the role in Discord is refused on their next press', async () => {
    const h = new Harness();
    h.seed();
    const event = h.press(accept, { roleIds: [] });

    await h.run(event);

    expect(reply(h, event)).toContain('You aren’t on the review team');
    expect(h.calls.some((call) => callback(call) === MODAL)).toBe(false);
  });

  test('a removed form says so and still lets the team read the answers', async () => {
    const h = new Harness();
    h.seed();
    h.setConfig(configWith({ forms: [formConfig({ id: 'other', name: 'Other' })] }));

    const pressed = h.press(accept);
    await h.run(pressed);
    expect(reply(h, pressed)).toContain('was removed from Applications settings');

    const read = h.press(customId(STAFF_ACTION.read, APP_ID), { messageFlags: 0 });
    await h.run(read);
    expect(reply(h, read)).toContain('I like keeping');
  });

  test('every interaction payload is one Discord accepts, and every custom id fits', async () => {
    const h = new Harness(
      configWith({
        forms: [
          formConfig({ review: { scoring: true }, interview: { ticketTypeId: 'interview' } }),
        ],
      }),
    );
    h.seed();

    for (const id of [claim, accept, reject, card, customId(STAFF_ACTION.read, APP_ID, '0')]) {
      await h.run(h.press(id));
    }
    for (const choice of Object.values(MORE_CHOICES)) {
      await h.run(h.press(more, { values: [choice] }));
    }

    expect(interactionErrors(h)).toEqual([]);
    for (const call of h.calls) {
      const modal = call.payload.modal as { customId?: string } | undefined;
      const components = [
        ...(Array.isArray(call.payload.components) ? call.payload.components : []),
      ];
      for (const id of [...customIds(components), ...(modal?.customId ? [modal.customId] : [])]) {
        expect(id.length).toBeLessThanOrEqual(MAX_CUSTOM_ID_LENGTH);
      }
    }
  });
});

describe('accepting and rejecting', () => {
  test('Accept opens its modal as the first and only response, and writes nothing', async () => {
    const h = new Harness();
    const before = h.seed();
    const event = h.press(accept);

    await h.run(event);

    const answers = h.answersTo(event);
    expect(answers).toHaveLength(1);
    expect(callback(answers[0])).toBe(MODAL);

    const modal = modalOf(answers[0]);
    expect(modal.customId).toBe(acceptModal);
    expect(modal.title).toBe('Accept application #12');
    expect(fieldIds(modal.components)).toEqual(['reason', 'note']);
    expect(await h.store.get(GUILD, APP_ID)).toEqual(before);
  });

  test('with scoring on, the decision modal asks for a score from 1 to 5', async () => {
    const h = new Harness(configWith({ forms: [formConfig({ review: { scoring: true } })] }));
    h.seed();
    const event = h.press(reject);

    await h.run(event);

    const modal = modalOf(first(h, event));
    expect(fieldIds(modal.components)).toEqual(['reason', 'note', 'score']);
    expect(JSON.stringify(modal.components)).toContain('"value":"5"');
  });

  test('a decision defers first, records everything in one transition and answers', async () => {
    const h = new Harness();
    h.seed({ assigneeId: REVIEWER, status: 'in_review' });

    const event = await decide(h, 'accept', {
      reason: 'Welcome aboard.',
      note: 'Strong answers on the scenarios.',
    });

    expect(callback(first(h, event))).toBe(DEFERRED);
    expect(first(h, event)?.payload.ephemeral).toBe(true);

    const application = await h.store.get(GUILD, APP_ID);
    expect(application).toMatchObject({
      status: 'accepted',
      decidedBy: REVIEWER,
      decidedAt: NOW,
      decisionReason: 'Welcome aboard.',
      contentPurgeAt: NOW + 30 * DAY,
      revision: 2,
    });

    const detail = await h.store.detail(GUILD, APP_ID);
    expect(detail?.thread.map(({ kind, body }) => ({ kind, body }))).toEqual([
      { kind: 'decision', body: 'Welcome aboard.' },
    ]);
    expect(detail?.notes.map(({ body }) => body)).toEqual(['Strong answers on the scenarios.']);
    expect(detail?.votes.map(({ reviewerId, vote }) => ({ reviewerId, vote }))).toEqual([
      { reviewerId: REVIEWER, vote: 'accept' },
    ]);

    const interactionId = (event.payload as { id: string }).id;
    expect(detail?.events.map((row) => row.id)).toEqual([`${APP_ID}:accepted:${interactionId}`]);

    const keys = h.store.effectsOf(APP_ID).map((effect) => effect.key);
    expect(keys).toEqual(expect.arrayContaining(['card', 'accepted:2:dm', 'event:accepted:2']));

    expect(spoken(h, event)?.kind).toBe('interaction_edit_original');
    expect(reply(h, event)).toContain('Accepted application #12.');
    expect(interactionErrors(h)).toEqual([]);
  });

  test('a decision hands its effects to the work queue instead of running them in the press', async () => {
    const h = new Harness();
    h.seed();

    const event = await decide(h, 'reject');

    expect(reply(h, event)).toContain('Rejected application #12.');
    expect(h.calls.filter((call) => !call.kind.startsWith('interaction_'))).toEqual([]);
    expect(h.published.map((sent) => sent.type)).toEqual(['applications.work_requested']);
    expect(h.published[0]?.naturalKey).toBe(`${APP_ID}:${NOW}`);
    expect(h.store.effectsOf(APP_ID).filter((effect) => effect.status !== 'pending')).toEqual([]);
  });

  test('when the work queue can’t be reached, the press arms the sweep instead', async () => {
    const h = new Harness();
    h.seed();
    const armed: string[] = [];
    h.ctx = {
      ...h.ctx,
      config: h.config,
      publish: async () => {
        throw new Error('redis is down');
      },
      schedule: async (jobId: string) => {
        armed.push(jobId);
        return { scheduled: true, replaced: false };
      },
    } as typeof h.ctx;

    const event = h.press(claim);
    await h.run(event);

    expect(reply(h, event)).toContain('You claimed application #12.');
    expect(armed).toEqual(['sweep']);
    expect(h.calls.filter((call) => !call.kind.startsWith('interaction_'))).toEqual([]);
  });

  test('audit rows and timeline data carry lengths, never the reason or the note', async () => {
    const h = new Harness();
    h.seed();

    await decide(h, 'reject', { reason: 'SECRET-REASON', note: 'SECRET-NOTE' });

    const audit = JSON.stringify([...h.store.auditRows.values()]);
    const events = JSON.stringify(h.store.eventsOf(APP_ID));
    for (const text of [audit, events]) {
      expect(text).not.toContain('SECRET-REASON');
      expect(text).not.toContain('SECRET-NOTE');
    }
    expect([...h.store.auditRows.values()][0]).toMatchObject({
      actorId: REVIEWER,
      source: 'command',
      action: 'module.applications.reject',
    });
  });

  test('simultaneous Accept and Reject produce one decision and one set of effects', async () => {
    const h = new Harness();
    h.seed();

    const accepting = h.submit(acceptModal, { userId: REVIEWER, fields: { reason: 'Yes.' } });
    const rejecting = h.submit(rejectModal, { userId: SECOND, fields: { reason: 'No.' } });
    await Promise.all([h.run(accepting), h.run(rejecting)]);

    const application = await h.store.get(GUILD, APP_ID);
    const won = application?.status === 'accepted' ? 'accept' : 'reject';
    const [winner, loser] = won === 'accept' ? [accepting, rejecting] : [rejecting, accepting];
    const decidedBy = won === 'accept' ? REVIEWER : SECOND;

    expect(['accepted', 'rejected']).toContain(application?.status ?? '');
    expect(reply(h, winner)).toContain(
      won === 'accept' ? 'Accepted application' : 'Rejected application',
    );
    expect(reply(h, loser)).toContain(
      `This application has already been reviewed. It was ${application?.status} by <@${decidedBy}> <t:${Math.floor(NOW / 1000)}:R>.`,
    );

    const effects = h.store.effectsOf(APP_ID);
    const triggers = new Set(effects.filter((e) => e.kind !== 'card').map((e) => e.trigger));
    expect([...triggers]).toEqual([application?.status ?? '']);
    expect(effects.filter((effect) => effect.kind === 'event')).toHaveLength(1);
    expect((await h.store.detail(GUILD, APP_ID))?.thread).toHaveLength(1);
  });

  test('a stale Accept button reports the decision that was made', async () => {
    const h = new Harness();
    h.seed({ status: 'rejected', decidedBy: SECOND, decidedAt: NOW - 60_000 });
    const event = h.press(accept);

    await h.run(event);

    expect(callback(first(h, event))).toBe(REPLY);
    expect(reply(h, event)).toContain(
      `This application has already been reviewed. It was rejected by <@${SECOND}> <t:${Math.floor((NOW - 60_000) / 1000)}:R>.`,
    );
  });

  test('a redelivered modal submit decides once and answers once', async () => {
    const h = new Harness();
    h.seed();
    const event = h.submit(acceptModal, { fields: { reason: 'Welcome.' } });

    await h.run(event);
    const effects = h.store.effectsOf(APP_ID).length;
    await h.run(event);

    expect(h.store.effectsOf(APP_ID)).toHaveLength(effects);
    expect(h.store.eventsOf(APP_ID)).toHaveLength(1);
    const sent = h.answersTo(event).filter((call) => call.status === 'executed');
    expect(sent.map((call) => call.kind)).toEqual([
      'interaction_reply',
      'interaction_edit_original',
    ]);
  });

  test('the same reviewer deciding the same way twice is told it is already done', async () => {
    const h = new Harness();
    h.seed();

    await decide(h, 'accept');
    const again = await decide(h, 'accept');

    expect(reply(h, again)).toContain('You already accepted application #12.');
    expect(h.store.eventsOf(APP_ID)).toHaveLength(1);
  });

  test('a reason over the limit is refused rather than cut', async () => {
    const h = new Harness();
    h.seed();

    const event = await decide(h, 'accept', { reason: 'x'.repeat(1001) });

    expect(reply(h, event)).toContain('can be up to 1000 characters');
    expect((await h.store.get(GUILD, APP_ID))?.status).toBe('submitted');
  });

  test('a viewer can read but not decide', async () => {
    const h = new Harness();
    h.seed();
    const event = h.press(accept, { userId: OUTSIDER, roleIds: [VIEWER_ROLE] });

    await h.run(event);

    expect(reply(h, event)).toContain('Only deciders on the Moderator Application review team');
  });
});

describe('two reviewers', () => {
  function twoReviewers(overrideFor: string[] = []): Harness {
    const h = new Harness(
      configWith({ forms: [formConfig({ review: { requireTwoReviewers: true } })] }),
    );
    h.seed();
    if (overrideFor.length > 0) {
      h.setConfig(
        configWith({
          forms: [formConfig({ review: { requireTwoReviewers: true } })],
          overrideRoleIds: [OVERRIDE_ROLE],
        }),
      );
    }
    return h;
  }

  test('a lone decider is told who else has to vote, and no modal opens', async () => {
    const h = twoReviewers();
    const event = h.press(accept);

    await h.run(event);

    expect(callback(first(h, event))).toBe(REPLY);
    const text = reply(h, event);
    expect(text).toContain('Moderator Application needs two reviewers to agree.');
    expect(text).toContain(`<@&${REVIEWER_ROLE}>`);
    expect(text).toContain(`<@&${DECIDER_ROLE}>`);
  });

  test('another reviewer’s matching vote lets the decision through, recording both votes', async () => {
    const h = twoReviewers();

    const voted = h.press(more, { userId: SECOND, values: [MORE_CHOICES.voteAccept] });
    await h.run(voted);
    expect(callback(first(h, voted))).toBe(DEFERRED);
    expect(reply(h, voted)).toContain('Votes so far: 1 accept · 0 reject');

    const opened = h.press(accept);
    await h.run(opened);
    expect(callback(first(h, opened))).toBe(MODAL);
    expect(fieldIds(modalOf(first(h, opened)).components)).toEqual(['reason', 'note']);

    await decide(h, 'accept');

    expect((await h.store.get(GUILD, APP_ID))?.status).toBe('accepted');
    const votes = await h.store.votes(GUILD, APP_ID);
    expect(votes.map(({ reviewerId, vote }) => `${reviewerId}:${vote}`).sort()).toEqual(
      [`${REVIEWER}:accept`, `${SECOND}:accept`].sort(),
    );
  });

  test('an opposite vote does not count towards the decision', async () => {
    const h = twoReviewers();
    await h.run(h.press(more, { userId: SECOND, values: [MORE_CHOICES.voteReject] }));

    const event = await decide(h, 'accept');

    expect(reply(h, event)).toContain('needs two reviewers to agree');
    expect(reply(h, event)).toContain(`<@${SECOND}> reject`);
    expect((await h.store.get(GUILD, APP_ID))?.status).toBe('submitted');
  });

  test('an override needs the override role and the box ticked, and it is recorded', async () => {
    const h = twoReviewers([REVIEWER]);
    const overrider = { roleIds: [REVIEWER_ROLE, OVERRIDE_ROLE] };

    const opened = h.press(accept, overrider);
    await h.run(opened);
    const modal = modalOf(first(h, opened));
    expect(fieldIds(modal.components)).toEqual(['reason', 'note', 'override']);

    const unticked = h.submit(acceptModal, { ...overrider, checks: { override: false } });
    await h.run(unticked);
    expect(reply(h, unticked)).toContain(
      'You can also decide without them from the decision form.',
    );
    expect((await h.store.get(GUILD, APP_ID))?.status).toBe('submitted');

    const ticked = h.submit(acceptModal, { ...overrider, checks: { override: true } });
    await h.run(ticked);

    expect((await h.store.get(GUILD, APP_ID))?.status).toBe('accepted');
    expect(reply(h, ticked)).toContain('deciding without a second reviewer');
    const kinds = h.store.eventsOf(APP_ID).map((row) => row.kind);
    expect(kinds).toEqual(['accepted', 'override_two_reviewers']);
    expect(h.store.eventsOf(APP_ID)[0]?.data).toMatchObject({ override: 'two_reviewers' });
  });

  test('a vote from someone who has since lost the review role does not count', async () => {
    const h = twoReviewers();
    await h.run(h.press(more, { userId: SECOND, values: [MORE_CHOICES.voteAccept] }));
    h.members.set(SECOND, []);

    const opened = h.press(accept);
    await h.run(opened);
    expect(callback(first(h, opened))).toBe(REPLY);
    expect(reply(h, opened)).toContain('needs two reviewers to agree');
    expect(reply(h, opened)).not.toContain(`<@${SECOND}>`);

    const event = await decide(h, 'accept');
    expect(reply(h, event)).toContain('needs two reviewers to agree');
    expect((await h.store.get(GUILD, APP_ID))?.status).toBe('submitted');

    h.members.set(SECOND, [REVIEWER_ROLE]);
    h.setConfig(
      configWith({
        forms: [formConfig({ review: { requireTwoReviewers: true } })],
        reviewerRoleIds: [DECIDER_ROLE],
        deciderRoleIds: [DECIDER_ROLE],
      }),
    );
    const removed = await decide(h, 'accept', { userId: DECIDER });
    expect(reply(h, removed)).toContain('needs two reviewers to agree');
    expect((await h.store.get(GUILD, APP_ID))?.status).toBe('submitted');
  });

  test('a voter who left the server, or whose roles can’t be read, does not count', async () => {
    for (const standing of ['absent', 'unavailable'] as const) {
      const h = twoReviewers();
      await h.run(h.press(more, { userId: SECOND, values: [MORE_CHOICES.voteAccept] }));
      h.members.set(SECOND, standing);

      const event = await decide(h, 'accept');

      expect(reply(h, event)).toContain('needs two reviewers to agree');
      expect((await h.store.get(GUILD, APP_ID))?.status).toBe('submitted');
    }
  });

  test('an admin’s vote counts though they hold no review role', async () => {
    const h = twoReviewers();
    const adminRole = '410000000000000099';
    h.members.set(ADMIN, [adminRole]);
    h.deps = {
      ...h.deps,
      guildState: {
        get: async () => ({
          guildId: GUILD,
          ownerId: '100000000000000099',
          everyoneRoleId: GUILD,
          roles: new Map([
            [GUILD, { id: GUILD, permissions: 0n, position: 0 }],
            [adminRole, { id: adminRole, permissions: Permissions.ManageGuild, position: 1 }],
          ]),
          botRoleIds: [],
          channels: new Map(),
          updatedAt: NOW,
        }),
      },
    };
    await h.run(h.press(more, { userId: ADMIN, values: [MORE_CHOICES.voteAccept] }));

    await decide(h, 'accept');

    expect((await h.store.get(GUILD, APP_ID))?.status).toBe('accepted');
  });

  test('a voter read that outlasts the modal deadline counts as no vote', async () => {
    const h = twoReviewers([REVIEWER]);
    await h.run(h.press(more, { userId: SECOND, values: [MORE_CHOICES.voteAccept] }));
    h.deps = { ...h.deps, lookupMember: () => new Promise(() => {}) };

    const opened = h.press(accept, { roleIds: [REVIEWER_ROLE, OVERRIDE_ROLE] });
    await h.run(opened);

    expect(h.answersTo(opened)).toHaveLength(1);
    expect(callback(first(h, opened))).toBe(MODAL);
    expect(fieldIds(modalOf(first(h, opened)).components)).toEqual(['reason', 'note', 'override']);
  });

  test('ticking the override box without the override role changes nothing', async () => {
    const h = twoReviewers();

    const event = h.submit(acceptModal, { checks: { override: true } });
    await h.run(event);

    expect(reply(h, event)).toContain('needs two reviewers to agree');
    expect((await h.store.get(GUILD, APP_ID))?.status).toBe('submitted');
  });
});

describe('claiming and voting', () => {
  test('claim defers, assigns the reviewer and starts the review', async () => {
    const h = new Harness();
    h.seed();
    const event = h.press(claim);

    await h.run(event);

    expect(callback(first(h, event))).toBe(DEFERRED);
    expect(await h.store.get(GUILD, APP_ID)).toMatchObject({
      status: 'in_review',
      assigneeId: REVIEWER,
      reviewStartedAt: NOW,
    });
    expect(h.store.effectsOf(APP_ID).map((effect) => effect.key)).toContain(
      'event:review_started:2',
    );
    expect(reply(h, event)).toContain('You claimed application #12.');
  });

  test('a second claim names who got there first', async () => {
    const h = new Harness();
    h.seed();
    await h.run(h.press(claim));

    const event = h.press(claim, { userId: SECOND });
    await h.run(event);

    expect(reply(h, event)).toContain(`<@${REVIEWER}> has already claimed application #12.`);
  });

  test('unclaim puts the application back in the queue', async () => {
    const h = new Harness();
    h.seed({ status: 'in_review', assigneeId: REVIEWER, assignedAt: NOW - 1 });
    const event = h.press(unclaim);

    await h.run(event);

    expect(await h.store.get(GUILD, APP_ID)).toMatchObject({
      status: 'submitted',
      assigneeId: null,
    });
    expect(reply(h, event)).toContain('It’s back in the queue.');
  });

  test('with scoring on, a vote opens a score modal first and records the score', async () => {
    const h = new Harness(configWith({ forms: [formConfig({ review: { scoring: true } })] }));
    h.seed();

    const pressed = h.press(more, { values: [MORE_CHOICES.voteReject] });
    await h.run(pressed);
    const modal = modalOf(first(h, pressed));
    expect(modal.customId).toBe(customId(STAFF_ACTION.voteModal, APP_ID, 'reject'));
    expect(h.answersTo(pressed)).toHaveLength(1);

    const submitted = h.submit(modal.customId, { radios: { score: '2' } });
    await h.run(submitted);

    expect(callback(first(h, submitted))).toBe(DEFERRED);
    expect(await h.store.votes(GUILD, APP_ID)).toEqual([
      { reviewerId: REVIEWER, vote: 'reject', score: 2, updatedAt: NOW },
    ]);
  });
});

describe('more actions', () => {
  test('request information asks in a modal, then waits on the applicant with a deadline', async () => {
    const h = new Harness();
    h.seed();

    const pressed = h.press(more, { values: [MORE_CHOICES.info] });
    await h.run(pressed);
    expect(modalOf(first(h, pressed)).customId).toBe(customId(STAFF_ACTION.infoModal, APP_ID));

    const submitted = h.submit(customId(STAFF_ACTION.infoModal, APP_ID), {
      fields: { message: 'Which servers have you moderated?' },
    });
    await h.run(submitted);

    expect(callback(first(h, submitted))).toBe(DEFERRED);
    expect(await h.store.get(GUILD, APP_ID)).toMatchObject({
      status: 'needs_info',
      infoRequestedAt: NOW,
      infoDueAt: NOW + 14 * DAY,
    });
    const detail = await h.store.detail(GUILD, APP_ID);
    expect(detail?.thread.map(({ kind, body }) => ({ kind, body }))).toEqual([
      { kind: 'info_request', body: 'Which servers have you moderated?' },
    ]);
    expect(h.store.effectsOf(APP_ID).map((effect) => effect.key)).toContain('info:2:dm');
  });

  test('with no follow-up deadline, an information request has no due date', async () => {
    const h = new Harness(configWith({ followUpDeadlineDays: 0 }));
    h.seed();

    await h.run(h.submit(customId(STAFF_ACTION.infoModal, APP_ID), { fields: { message: 'Hi?' } }));

    expect((await h.store.get(GUILD, APP_ID))?.infoDueAt).toBe(null);
  });

  test('waitlist records the applicant-visible reason on the thread', async () => {
    const h = new Harness();
    h.seed();

    await h.run(
      h.submit(customId(STAFF_ACTION.waitlistModal, APP_ID), {
        fields: { reason: 'We are full for now.' },
      }),
    );

    expect(await h.store.get(GUILD, APP_ID)).toMatchObject({
      status: 'waitlisted',
      waitlistedAt: NOW,
      decisionReason: 'We are full for now.',
    });
    expect(h.store.effectsOf(APP_ID).map((effect) => effect.key)).toContain('waitlisted:2:dm');
  });

  test('a note is private, does not bump the revision and never reaches the card', async () => {
    const h = new Harness();
    h.seed();

    const opened = h.press(more, { values: [MORE_CHOICES.note] });
    await h.run(opened);
    expect(modalOf(first(h, opened)).customId).toBe(customId(STAFF_ACTION.noteModal, APP_ID));

    const noted = h.submit(customId(STAFF_ACTION.noteModal, APP_ID), {
      fields: { note: 'PRIVATE-NOTE-TEXT' },
    });
    await h.run(noted);

    const application = await h.store.get(GUILD, APP_ID);
    expect(application?.revision).toBe(1);
    expect(h.store.effectsOf(APP_ID)).toEqual([]);
    expect((await h.store.detail(GUILD, APP_ID))?.notes.map(({ body }) => body)).toEqual([
      'PRIVATE-NOTE-TEXT',
    ]);
    expect(reply(h, noted)).toContain('Only the review team can read it.');

    const shown = h.press(card);
    await h.run(shown);
    const view = spoken(h, shown);
    expect(view?.payload.flags).toBe(COMPONENTS_V2);
    expect(said(view)).toContain('Moderator Application #12');
    expect(JSON.stringify(h.calls.map((call) => call.payload))).not.toContain('PRIVATE-NOTE-TEXT');
  });

  test('an interview ticket needs a ticket type on the form', async () => {
    const h = new Harness();
    h.seed();
    const event = h.press(more, { values: [MORE_CHOICES.ticket] });

    await h.run(event);

    expect(reply(h, event)).toContain('has no interview ticket type');
    expect(h.store.effectsOf(APP_ID)).toEqual([]);
  });

  test('an interview ticket is refused clearly while Tickets is off', async () => {
    const h = new Harness(
      configWith({ forms: [formConfig({ interview: { ticketTypeId: 'interview' } })] }),
    );
    h.deps = { ...h.deps, availability: { isEnabled: async () => false } };
    h.seed();
    const event = h.press(more, { values: [MORE_CHOICES.ticket] });

    await h.run(event);

    expect(reply(h, event)).toContain(
      'Tickets is off in this server, so I can’t open an interview ticket.',
    );
    expect(h.store.effectsOf(APP_ID)).toEqual([]);
  });

  test('an interview ticket is queued once per revision', async () => {
    const h = new Harness(
      configWith({ forms: [formConfig({ interview: { ticketTypeId: 'interview' } })] }),
    );
    h.seed();
    const event = h.press(more, { values: [MORE_CHOICES.ticket] });

    await h.run(event);

    expect(callback(first(h, event))).toBe(DEFERRED);
    const tickets = h.store.effectsOf(APP_ID).filter((effect) => effect.kind === 'ticket');
    expect(tickets.map((effect) => effect.key)).toEqual(['ticket:2']);
    expect(tickets[0]?.params).toMatchObject({ typeId: 'interview', userId: APPLICANT });
  });

  test('anyone who may view can page through every answer', async () => {
    const h = new Harness();
    const long = 'word '.repeat(1600).trim();
    h.seed({
      answers: [
        {
          questionId: 'why',
          sectionId: 'about',
          label: 'Why?',
          type: 'paragraph',
          value: long,
          display: long,
        },
      ],
    });
    const viewer = { userId: OUTSIDER, roleIds: [VIEWER_ROLE] };

    const opened = h.press(more, { ...viewer, values: [MORE_CHOICES.read], messageFlags: 0 });
    await h.run(opened);
    expect(callback(first(h, opened))).toBe(DEFERRED);
    const screen = spoken(h, opened);
    expect(screen?.payload.flags).toBe(COMPONENTS_V2);
    expect(said(screen)).toContain('Answers, page 1 of 3');

    const next = customId(STAFF_ACTION.read, APP_ID, '1');
    expect(customIds(screen?.payload.components as unknown[])).toContain(next);

    const turned = h.press(next, { ...viewer, messageFlags: COMPONENTS_V2 | EPHEMERAL });
    await h.run(turned);
    expect(callback(first(h, turned))).toBe(DEFERRED_UPDATE);
    expect(said(spoken(h, turned))).toContain('Answers, page 2 of 3');
    expect(interactionErrors(h)).toEqual([]);
  });

  test('the card’s own Read all answers button opens a new private message', async () => {
    const h = new Harness();
    h.seed({ status: 'accepted', decidedBy: REVIEWER, decidedAt: NOW });
    const event = h.press(customId(STAFF_ACTION.read, APP_ID), {
      messageFlags: COMPONENTS_V2 | EPHEMERAL,
    });

    await h.run(event);

    expect(callback(first(h, event))).toBe(DEFERRED);
  });

  test('purged answers are explained instead of shown', async () => {
    const h = new Harness();
    h.seed({ answers: null, contentPurgedAt: NOW - DAY });
    const event = h.press(customId(STAFF_ACTION.read, APP_ID, '0'), { messageFlags: 0 });

    await h.run(event);

    expect(reply(h, event)).toContain('were removed');
  });

  test('an unknown choice is refused without touching the store', async () => {
    const h = new Harness();
    const before = h.seed();
    const event = h.press(more, { values: ['nope'] });

    await h.run(event);

    expect(callback(first(h, event))).toBe(REPLY);
    expect(await h.store.get(GUILD, APP_ID)).toEqual(before);
  });

  test('the private card offers only what the status allows', async () => {
    const h = new Harness();
    h.seed({ status: 'needs_info', assigneeId: REVIEWER, infoDueAt: NOW + DAY });
    const event = h.press(card);

    await h.run(event);

    const components = spoken(h, event)?.payload.components as unknown[];
    expect(selectValues(components)).toEqual([
      MORE_CHOICES.waitlist,
      MORE_CHOICES.note,
      MORE_CHOICES.read,
    ]);
    expect(textOf(components)).toContain('answer due');
  });

  test('an admin without any review role holds every capability', async () => {
    const h = new Harness();
    h.seed();
    const event = h.press(accept, { userId: ADMIN, roleIds: [] });

    await h.run(event);

    expect(callback(first(h, event))).toBe(MODAL);
  });

  test('a decider-only member can decide', async () => {
    const h = new Harness();
    h.seed();
    const event = h.press(reject, { userId: DECIDER });

    await h.run(event);

    expect(callback(first(h, event))).toBe(MODAL);
  });
});

describe('answers when the original response cannot be edited', () => {
  test('the result falls back to a follow-up', async () => {
    const h = new Harness();
    h.seed();
    h.refusals.set('interaction_edit_original', {
      status: 'failed_api',
      failure: { code: 'discord_404', humanReason: 'Unknown message' },
    });

    const event = h.press(claim);
    await h.run(event);

    const sent = h.answersTo(event).filter((call) => call.status === 'executed');
    expect(sent.map((call) => call.kind)).toEqual(['interaction_reply', 'interaction_followup']);
    expect(said(sent[1])).toContain('You claimed application #12.');
    expect(sent[1]?.payload.ephemeral).toBe(true);
  });
});
