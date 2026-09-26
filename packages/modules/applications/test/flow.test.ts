import { describe, expect, test } from 'bun:test';
import { ComponentType } from 'discord-api-types/v10';
import { APPLICANT_ACTION, customId } from '../src/interface.ts';
import { createApplicationsListeners } from '../src/listeners.ts';
import type { ApplicationRecord } from '../src/store.ts';
import { snapshotOf } from '../src/version.ts';
import {
  DAY,
  type Delivered,
  GOOD_ANSWERS,
  GUILD,
  type Harness,
  harness,
  MEMBER,
  MEMBER_ROLE,
  MINUTE,
  moderatorForm,
  ready,
  STRANGER,
  standingOf,
  textsOf,
} from './applicant-harness.ts';
import { applicationRecord } from './memory-store.ts';

const PANEL_PRESS = customId(APPLICANT_ACTION.open, 'staff', 'mods');

async function openOverview(h: Harness, opts: Parameters<Harness['press']>[1] = {}) {
  return h.press(PANEL_PRESS, { panel: true, ...opts });
}

async function answerFirstStep(h: Harness, answers: Record<string, string> = GOOD_ANSWERS) {
  await openOverview(h);
  await h.pressButton('Start');
  return h.submitModal(answers);
}

async function completeDraft(h: Harness): Promise<ApplicationRecord> {
  await answerFirstStep(h);
  await h.pressButton('Continue');
  await h.submitModal({ tools: ['automod'], rules: true });
  await h.pressButton('Review answers');
  return h.draft();
}

function modalIds(h: Harness): string[] {
  return (h.lastModal()?.components ?? []).map((label) =>
    String((label.component as Record<string, unknown>).custom_id),
  );
}

function inner(h: Harness, questionId: string): Record<string, unknown> {
  const label = (h.lastModal()?.components ?? []).find(
    (candidate) => (candidate.component as Record<string, unknown>).custom_id === questionId,
  );
  if (!label) throw new Error(`the open modal has no '${questionId}'`);
  return label.component as Record<string, unknown>;
}

function interactionFailures(h: Harness) {
  return h
    .failures()
    .filter((entry) => entry.request.kind.startsWith('interaction_'))
    .map((entry) => `${entry.request.kind}: ${entry.result.failure?.humanReason}`);
}

function submitted(h: Harness): ApplicationRecord {
  const rows = [...h.store.applicationsById.values()].filter(
    (row) => row.applicantId === MEMBER && row.number !== null,
  );
  if (rows.length !== 1) throw new Error(`expected one sent application, found ${rows.length}`);
  return rows[0] as ApplicationRecord;
}

describe('applying in Discord', () => {
  test('a member with closed DMs applies step by step, sends it and checks its status', async () => {
    const h = await ready();
    h.rest.fail('/users/@me/channels', {
      status: 403,
      body: { code: 50007, message: 'Cannot send messages to this user' },
    });

    const overview = await openOverview(h);
    expect(h.callbackTypesFor(overview.interactionId)).toEqual([5]);
    expect(h.text()).toContain('## Moderator Application');
    expect(h.text()).toContain('Tell us about yourself.');
    expect(h.text()).toContain('Anyone in this server can apply.');
    expect(h.text()).toContain('Staff who review this form can read your answers.');
    expect(h.text()).toContain('Closing a step’s window before sending it loses what you typed');

    const start = await h.pressButton('Start');
    expect(h.callbackTypesFor(start.interactionId)).toEqual([9]);
    expect(h.lastModal()?.title).toBe('Step 1 of 2 · Moderator Application');
    expect(modalIds(h)).toEqual(['age', 'why', 'track']);

    const first = await h.submitModal(GOOD_ANSWERS);
    expect(h.callbackTypesFor(first.interactionId)).toEqual([6]);
    expect(h.text()).toContain('✓ Your answers for this step are saved.');
    expect(h.text()).toContain('Step 1 of 2 · About you');
    expect(h.text()).toContain('Next: Step 2 of 2 · Experience.');
    expect(h.buttons().map((button) => button.label)).toEqual([
      'Continue',
      'Save for later',
      'Cancel',
    ]);

    await h.pressButton('Continue');
    expect(modalIds(h)).toEqual(['tools', 'rules']);
    await h.submitModal({ tools: ['automod', 'logs'], rules: true });
    expect(h.text()).toContain('That was the last step.');
    expect(h.buttons().map((button) => button.label)).toEqual([
      'Back',
      'Review answers',
      'Save for later',
      'Cancel',
    ]);

    const review = await h.pressButton('Review answers');
    expect(h.callbackTypesFor(review.interactionId)).toEqual([6]);
    expect(h.text()).toContain('## Review your answers');
    expect(h.text()).toContain('**Why do you want to help?**');
    expect(h.text()).toContain('AutoMod, Audit logs');
    expect(h.button('Submit').disabled).toBe(false);

    const sent = await h.pressButton('Submit');
    expect(h.callbackTypesFor(sent.interactionId)).toEqual([6]);
    const application = submitted(h);
    expect(application.status).toBe('submitted');
    expect(application.number).toBe(1);
    expect(application.answers?.map((answer) => answer.questionId)).toEqual([
      'age',
      'why',
      'track',
      'tools',
      'rules',
    ]);
    expect(application.reviewDueAt).toBe(h.now() + 48 * 60 * MINUTE);

    expect(h.text()).toContain('## Your application has been sent.');
    expect(h.text()).toContain('**#1**');
    expect(h.text()).toContain('Staff usually reply within a week.');
    expect(h.text()).toContain('`/apply status`');
    const link = h.buttons().find((button) => button.label === 'Status page');
    expect(link?.url).toBe(`https://prtn.xyz/applications/${GUILD}/${application.id}`);

    const facing = h.facing();
    expect(h.rest.calls.filter((call) => !facing.includes(call))).toEqual([]);
    const requested = h.published.filter((event) => event.type === 'applications.work_requested');
    expect(requested.map((event) => event.payload)).toEqual([
      { guildId: GUILD, applicationId: application.id, reason: 'decision' },
    ]);

    await createApplicationsListeners(h.deps)
      .find((listener) => listener.types.includes('applications.work_requested'))
      ?.handler(
        {
          id: `applications.work_requested:${requested[0]?.naturalKey}`,
          type: 'applications.work_requested',
          guildId: GUILD,
          occurredAt: h.now(),
          payload: requested[0]?.payload,
        },
        h.context(),
      );
    expect(h.rest.calls.some((call) => call.path.startsWith('/users/@me/channels'))).toBe(true);
    const dm = h.store.effectsOf(application.id).find((effect) => effect.kind === 'dm');
    expect(dm).toMatchObject({ status: 'failed', errorCode: 'dms_closed' });

    await h.pressButton('View status');
    expect(h.text()).toContain('**Status:** Submitted');
    expect(h.buttons().map((button) => button.label)).toContain('Withdraw');

    expect(interactionFailures(h)).toEqual([]);
  });

  test('a restarted worker picks the application up from a fresh panel press', async () => {
    const before = await ready();
    await answerFirstStep(before);

    const after = harness({ store: before.store, now: before.now() + 2 * DAY });
    await openOverview(after);
    expect(after.buttons().map((button) => button.label)).toEqual([
      'Continue (step 2 of 2)',
      'Review answers',
      'My applications',
    ]);

    const resumed = await after.pressButton('Continue (step 2 of 2)');
    expect(after.callbackTypesFor(resumed.interactionId)).toEqual([9]);
    expect(modalIds(after)).toEqual(['tools', 'rules']);

    const draft = after.draft();
    await after.press(customId(APPLICANT_ACTION.step, draft.id, '0'));
    expect(inner(after, 'age').value).toBe('21');
    expect(inner(after, 'why').value).toBe(GOOD_ANSWERS.why);
    expect(inner(after, 'track').options).toContainEqual({
      label: 'Moderators',
      value: 'mod',
      default: true,
    });

    await after.press(customId(APPLICANT_ACTION.step, draft.id, '1'));
    await after.submitModal({ rules: true });
    await after.pressButton('Review answers');
    await after.pressButton('Submit');
    await after.pressButton('View status');
    expect(after.text()).toContain('**Status:** Submitted');
    expect(submitted(after).answers?.find((answer) => answer.questionId === 'age')?.value).toBe(
      '21',
    );
  });

  test('a press long after the first interaction expired continues from the database', async () => {
    const h = await ready();
    const earlier = await answerFirstStep(h);
    const continueId = h.button('Continue').customId as string;
    const draft = h.draft();

    h.advance(20 * MINUTE);
    const before = h.rest.calls.length;
    const late = await h.press(continueId);

    expect(h.callbackTypesFor(late.interactionId)).toEqual([9]);
    expect(h.lastModal()?.custom_id).toBe(
      customId(APPLICANT_ACTION.answer, draft.id, '1', String(draft.revision)),
    );

    await h.submitModal({ rules: true });
    const since = h.rest.calls.slice(before);
    expect(since.some((call) => call.path.includes(`token-${earlier.interactionId}`))).toBe(false);
    expect(h.draft().draft.rules).toBe(true);
    expect(h.text()).toContain('That was the last step.');
  });
});

describe('modals', () => {
  test('Start, Continue and every step button answer with the modal first', async () => {
    const h = await ready();
    const presses: Delivered[] = [];

    await openOverview(h);
    presses.push(await h.pressButton('Start'));
    await h.submitModal(GOOD_ANSWERS);
    presses.push(await h.pressButton('Continue'));
    await openOverview(h);
    presses.push(await h.pressButton('Continue (step 2 of 2)'));
    await h.submitModal({ rules: true });
    presses.push(await h.pressButton('Back'));
    await h.pressButton('Review answers');
    const draft = h.draft();
    presses.push(await h.select(customId(APPLICANT_ACTION.step, draft.id), ['1']));

    for (const press of presses) {
      expect(h.callbackTypesFor(press.interactionId)).toEqual([9]);
    }
  });

  test('a modal submit is never answered with a modal', async () => {
    const h = await ready();
    await completeDraft(h);
    await h.pressButton('Submit');

    const submits = h.events.filter((delivered) => delivered.event.type === 'interaction.modal');
    expect(submits.length).toBeGreaterThan(0);
    for (const delivered of submits) {
      expect(h.callbackTypesFor(delivered.interactionId)).not.toContain(9);
    }
  });

  test('a modal id arriving as a button, or a button id inside a modal, is refused', async () => {
    const h = await ready();
    await answerFirstStep(h);
    const draft = h.draft();

    const pressed = await h.press(
      customId(APPLICANT_ACTION.answer, draft.id, '0', String(draft.revision)),
    );
    expect(h.callbackTypesFor(pressed.interactionId)).toEqual([4]);
    expect(h.lastStatus()).toContain('This button is out of date.');

    const submitted = await h.submitRaw(customId(APPLICANT_ACTION.step, draft.id, '0'), []);
    expect(h.callbackTypesFor(submitted.interactionId)).not.toContain(9);
    expect(h.lastStatus()).toContain('This button is out of date.');
  });

  test('a press that arrives too late for a modal offers a button instead', async () => {
    const h = await ready();
    await answerFirstStep(h);
    const continueId = h.button('Continue').customId as string;

    const late = await h.press(continueId, { occurredAt: h.now() - 5_000 });
    expect(h.callbackTypesFor(late.interactionId)).toEqual([4]);
    expect(h.text()).toContain('Press the button to open the next step.');
    expect(h.buttons().map((button) => button.label)).toEqual(['Open step 2 of 2']);
  });
});

describe('steps and answers', () => {
  test('a branch question appears in a later step once its answer shows it', async () => {
    const h = await ready();
    await answerFirstStep(h, { ...GOOD_ANSWERS, track: 'dev' });

    expect(h.text()).toContain('Step 1 of 3 · About you');
    expect(h.text()).toContain('Next: Step 2 of 3 · About you.');

    await h.pressButton('Continue');
    expect(h.lastModal()?.title).toBe('Step 2 of 3 · Moderator Application');
    expect(modalIds(h)).toEqual(['portfolio']);
    expect(inner(h, 'portfolio').type).toBe(ComponentType.TextInput);

    await h.submitModal({ portfolio: 'example.com/me' });
    expect(h.draft().draft.portfolio).toBe('example.com/me');
    expect(h.text()).toContain('Next: Step 3 of 3 · Experience.');
  });

  test('answers that fail a check are kept and asked for again', async () => {
    const h = await ready();
    await answerFirstStep(h, { ...GOOD_ANSWERS, age: 'twelve' });

    expect(h.draft().draft.age).toBe('twelve');
    expect(h.text()).toContain('some need fixing');
    expect(h.text()).toContain('**How old are you?**: Enter a whole number from 13 to 120.');
    expect(h.draft().step).toBe(0);

    const fix = await h.pressButton('Fix answers');
    expect(h.callbackTypesFor(fix.interactionId)).toEqual([9]);
    expect(inner(h, 'age').value).toBe('twelve');

    await h.submitModal({ ...GOOD_ANSWERS, age: '19' });
    expect(h.text()).toContain('✓ Your answers for this step are saved.');
    expect(h.draft().draft.age).toBe('19');
  });

  test('the review keeps Submit off while an answer needs fixing', async () => {
    const h = await ready();
    await answerFirstStep(h, { ...GOOD_ANSWERS, age: '7' });
    await h.pressButton('Review answers');

    expect(h.text()).toContain('Fix these before you submit');
    expect(h.button('Submit').disabled).toBe(true);
  });

  test('a step saved somewhere else since the window opened is not overwritten', async () => {
    const h = await ready();
    await openOverview(h);
    await h.pressButton('Start');
    const opened = h.lastModal();
    const draft = h.draft();

    await h.store.saveDraft({
      guildId: GUILD,
      applicationId: draft.id,
      applicantId: MEMBER,
      expectedRevision: draft.revision,
      answers: { age: '30', why: 'Saved from the web page instead.', track: 'events' },
      mode: 'merge',
      expiresAt: h.now() + DAY,
    });

    expect(opened).not.toBeNull();
    await h.submitModal(GOOD_ANSWERS);

    expect(h.text()).toContain('This step wasn’t saved');
    expect(h.text()).toContain('Your answers changed somewhere else since you opened this step');
    expect(h.buttons().map((button) => button.label)).toEqual([
      'Review answers',
      'Open step again',
    ]);
    expect(h.draft().draft).toMatchObject({ age: '30', track: 'events' });
  });

  test('a redelivered step submit repeats the answer instead of reporting a conflict', async () => {
    const h = await ready();
    const first = await answerFirstStep(h);
    const saved = h.draft();
    const patches = h.rest.calls.filter((call) => call.method === 'PATCH').length;

    await h.redeliver(first);

    expect(h.draft().revision).toBe(saved.revision);
    expect(h.rest.calls.filter((call) => call.method === 'PATCH').length).toBe(patches);
    expect(h.text()).toContain('✓ Your answers for this step are saved.');
  });

  test('Save for later and Cancel keep or delete the draft', async () => {
    const h = await ready();
    await answerFirstStep(h);

    await h.pressButton('Save for later');
    expect(h.text()).toContain('Your answers for **Moderator Application** are saved.');
    expect(h.text()).toContain('`/apply resume`');
    expect(h.draft().draft.age).toBe('21');

    await h.pressButton('Continue');
    await h.submitModal({ rules: true });
    await h.pressButton('Cancel');
    expect(h.text()).toContain('## Delete your saved answers?');
    await h.pressButton('Delete answers');
    expect(h.text()).toContain('## Your saved answers were deleted');
    expect([...h.store.applicationsById.values()]).toEqual([]);
  });
});

describe('sending', () => {
  test('a form that reached its cap refuses and keeps the answers', async () => {
    const h = await ready({
      forms: [moderatorForm({ intake: { open: true, cooldownDays: 0, cap: 1 } })],
    });
    const draft = await completeDraft(h);
    h.store.seedApplication(
      applicationRecord({
        id: 'someone-else',
        guildId: GUILD,
        formId: 'mods',
        versionId: draft.versionId,
        applicantId: STRANGER,
        number: 7,
        submittedAt: h.now() - DAY,
      }),
    );

    await h.pressButton('Submit');
    expect(h.lastStatus()).toContain(
      '**Moderator Application** has all the applications it can take right now',
    );
    expect(h.draft().status).toBe('draft');
  });

  test('a cooldown refuses with the time it ends', async () => {
    const h = await ready({
      forms: [moderatorForm({ intake: { open: true, cooldownDays: 30, maxActive: 2 } })],
    });
    const draft = await completeDraft(h);
    const earlier = h.now() - 2 * DAY;
    h.store.seedApplication(
      applicationRecord({
        id: 'earlier',
        guildId: GUILD,
        formId: 'mods',
        versionId: draft.versionId,
        applicantId: MEMBER,
        number: 3,
        status: 'rejected',
        submittedAt: earlier - DAY,
        decidedAt: earlier,
      }),
    );

    await h.pressButton('Submit');
    expect(h.lastStatus()).toContain(
      `so you can send this application <t:${Math.floor((earlier + 30 * DAY) / 1000)}:R>`,
    );
    expect(h.draft().status).toBe('draft');
  });

  test('an application still waiting for a decision refuses another', async () => {
    const h = await ready();
    const draft = await completeDraft(h);
    h.store.seedApplication(
      applicationRecord({
        id: 'waiting',
        guildId: GUILD,
        formId: 'mods',
        versionId: draft.versionId,
        applicantId: MEMBER,
        number: 2,
        status: 'in_review',
        submittedAt: h.now() - DAY,
      }),
    );

    await h.pressButton('Submit');
    expect(h.lastStatus()).toContain(
      'You already have an application for **Moderator Application**',
    );
    expect(h.buttons().map((button) => button.customId)).toEqual([
      customId(APPLICANT_ACTION.view, 'waiting'),
    ]);
  });

  test('a form closed after the answers were written refuses and keeps them', async () => {
    const h = await ready();
    await completeDraft(h);
    h.reconfigure((config) => ({
      ...config,
      forms: [moderatorForm({ intake: { open: false } })],
    }));

    await h.pressButton('Submit');
    expect(h.lastStatus()).toContain(
      'Your answers are saved, so you can send them once it opens again.',
    );
    expect(h.draft().status).toBe('draft');
  });

  test('requirements are checked again when the application is sent', async () => {
    const form = moderatorForm({ requirements: { roleIds: [MEMBER_ROLE] } });
    const h = await ready({ forms: [form] });

    await openOverview(h, { roleIds: [] });
    expect(h.text()).toContain('✗ ');
    expect(h.buttons().map((button) => button.label)).not.toContain('Start');

    await completeDraft(h);
    await h.pressButton('Submit', { roleIds: [] });
    expect(h.lastStatus()).toContain('wasn’t sent because you don’t meet its requirements');
    expect(h.draft().status).toBe('draft');

    await h.pressButton('Submit');
    expect(submitted(h).status).toBe('submitted');
  });

  test('a Submit from before the answers changed shows them again instead of sending', async () => {
    const h = await ready();
    const draft = await completeDraft(h);
    const submit = h.button('Submit').customId as string;

    await h.store.saveDraft({
      guildId: GUILD,
      applicationId: draft.id,
      applicantId: MEMBER,
      expectedRevision: draft.revision,
      answers: { age: '44' },
      mode: 'merge',
      expiresAt: h.now() + DAY,
    });

    await h.press(submit);
    expect(h.text()).toContain('Your answers changed since you opened this review.');
    expect(h.text()).toContain('44');
    expect(h.draft().status).toBe('draft');
  });

  test('a long answer spreads over review pages without being cut', async () => {
    const long = `${'word '.repeat(700)}end`;
    const h = await ready();
    await answerFirstStep(h, { ...GOOD_ANSWERS, why: long });
    await h.pressButton('Continue');
    await h.submitModal({ rules: true });
    await h.pressButton('Review answers');

    expect(h.text()).toContain('Page 1 of 2');
    const first = h.text();
    await h.pressButton('Next page');
    expect(h.text()).toContain('Page 2 of 2');
    expect(h.text()).toContain('(continued)');
    expect(`${first}${h.text()}`.replace(/\s+/g, '')).toContain('wordend');
    expect(h.button('Previous page').disabled).toBe(false);
    expect(h.button('Next page').disabled).toBe(true);
  });

  test('pressing Submit twice sends once', async () => {
    const h = await ready();
    await completeDraft(h);
    const submit = h.button('Submit').customId as string;

    await h.press(submit);
    await h.press(submit);

    expect(submitted(h).number).toBe(1);
    expect(h.text()).toContain('## Your application has been sent.');
  });
});

describe('after sending', () => {
  async function sent(h: Harness): Promise<ApplicationRecord> {
    await completeDraft(h);
    await h.pressButton('Submit');
    return submitted(h);
  }

  test('a member withdraws after confirming, once', async () => {
    const h = await ready();
    const application = await sent(h);

    await h.pressButton('View status');
    await h.pressButton('Withdraw');
    expect(h.text()).toContain('## Withdraw your application?');

    const confirm = h.button('Withdraw').customId as string;
    const mark = { published: h.published.length, rest: h.rest.calls.length };
    const pressed = await h.press(confirm);
    expect(h.published.slice(mark.published)).toEqual([
      {
        type: 'applications.work_requested',
        naturalKey: `${application.id}:${h.now()}`,
        payload: { guildId: GUILD, applicationId: application.id, reason: 'decision' },
      },
    ]);
    const facing = h.facing();
    expect(h.rest.calls.slice(mark.rest).filter((call) => !facing.includes(call))).toEqual([]);
    const withdrawn = await h.store.get(GUILD, application.id);
    expect(withdrawn?.status).toBe('withdrawn');
    expect(withdrawn?.withdrawnAt).toBe(h.now());
    expect(withdrawn?.contentPurgeAt).toBe(h.now() + 30 * DAY);
    expect(h.text()).toContain('✓ You withdrew your application.');
    expect(h.store.eventsOf(application.id).map((event) => event.kind)).toContain('withdrawn');
    expect(h.store.effectsOf(application.id).map((effect) => effect.key)).toEqual(
      expect.arrayContaining([`event:withdrawn:${withdrawn?.revision}`]),
    );

    await h.redeliver(pressed);
    expect(
      h.store.eventsOf(application.id).filter((event) => event.kind === 'withdrawn'),
    ).toHaveLength(1);
  });

  test('a member answers a request for information', async () => {
    const h = await ready();
    const application = await sent(h);
    await h.store.transition({
      guildId: GUILD,
      applicationId: application.id,
      action: 'request_info',
      actor: { id: STRANGER, source: 'discord' },
      expect: { statuses: ['submitted'] },
      patch: { status: 'needs_info', infoRequestedAt: h.now(), infoDueAt: h.now() + 14 * DAY },
      thread: { kind: 'info_request', body: 'Which timezone are you in?' },
      event: { kind: 'information_requested' },
    });

    await h.press(customId(APPLICANT_ACTION.view, application.id));
    expect(h.text()).toContain('**Staff asked**\n> Which timezone are you in?');

    const open = await h.pressButton('Answer');
    expect(h.callbackTypesFor(open.interactionId)).toEqual([9]);

    const mark = h.published.length;
    const reply = await h.submitModal({ response: 'UTC+1, evenings mostly.' });
    expect(h.callbackTypesFor(reply.interactionId)).toEqual([6]);
    expect(h.text()).toContain('✓ Your answer was sent to staff.');
    expect(h.published.slice(mark).map((event) => event.type)).toEqual([
      'applications.work_requested',
    ]);

    const answered = await h.store.get(GUILD, application.id);
    expect(answered?.status).toBe('submitted');
    expect(answered?.infoDueAt).toBeNull();
    const thread = h.store.threadRows.filter((row) => row.applicationId === application.id);
    expect(thread.map((row) => [row.kind, row.body])).toEqual([
      ['info_request', 'Which timezone are you in?'],
      ['info_response', 'UTC+1, evenings mostly.'],
    ]);
    expect(h.store.eventsOf(application.id).map((event) => event.kind)).toContain(
      'information_provided',
    );
  });

  test('an answer goes back to the reviewer who claimed it', async () => {
    const h = await ready();
    const application = await sent(h);
    await h.store.transition({
      guildId: GUILD,
      applicationId: application.id,
      action: 'request_info',
      actor: { id: STRANGER, source: 'discord' },
      expect: { statuses: ['submitted'] },
      patch: { status: 'needs_info', assigneeId: STRANGER, infoRequestedAt: h.now() },
      thread: { kind: 'info_request', body: 'Anything else?' },
      event: { kind: 'information_requested' },
    });

    await h.press(customId(APPLICANT_ACTION.respond, application.id));
    await h.submitModal({ response: 'Nothing else.' });
    expect((await h.store.get(GUILD, application.id))?.status).toBe('in_review');
  });

  test('My applications lists drafts and sent applications with their status', async () => {
    const h = await ready({
      forms: [moderatorForm(), moderatorForm({ id: 'events', name: 'Event Team' })],
    });
    await sent(h);
    await h.press(customId(APPLICANT_ACTION.start, 'events'));
    await h.submitModal(GOOD_ANSWERS);

    const list = await h.press(customId(APPLICANT_ACTION.mine), { panel: true });
    expect(h.callbackTypesFor(list.interactionId)).toEqual([5]);
    expect(h.text()).toContain('**Moderator Application** #1\nSubmitted');
    expect(h.text()).toContain('**Event Team**\nDraft · not sent yet');
    expect(h.buttons().map((button) => button.label)).toEqual([
      'Continue',
      'View',
      'All your applications',
    ]);
  });

  test('My applications shows the ten newest', async () => {
    const h = await ready();
    const version = (await h.store.latestVersions(GUILD)).get('mods');
    for (let index = 1; index <= 12; index += 1) {
      h.store.seedApplication(
        applicationRecord({
          id: `old-${index}`,
          guildId: GUILD,
          formId: 'mods',
          versionId: version?.id ?? 'missing',
          applicantId: MEMBER,
          number: index,
          status: 'rejected',
          submittedAt: index * DAY,
          decidedAt: index * DAY,
          createdAt: index * DAY,
          updatedAt: index * DAY,
        }),
      );
    }

    await h.press(customId(APPLICANT_ACTION.mine), { panel: true });
    expect(h.buttons().filter((button) => button.label === 'View')).toHaveLength(10);
    expect(h.text()).toContain('#12');
    expect(h.text()).not.toContain('#2\n');
    expect(h.text()).toContain('Showing your 10 newest.');
  });
});

describe('a member’s standing on a form', () => {
  const form = moderatorForm({ intake: { open: true, cooldownDays: 10, maxActive: 2 } });
  const now = 100 * DAY;
  const latest = {
    id: 'v2',
    guildId: GUILD,
    formId: 'mods',
    version: 2,
    snapshot: snapshotOf(form),
    draftPolicy: 'restart' as const,
    publishedBy: STRANGER,
    publishedAt: now - DAY,
  };
  const row = (overrides: Partial<ApplicationRecord>) =>
    applicationRecord({ guildId: GUILD, formId: 'mods', applicantId: MEMBER, ...overrides });

  test('active applications come newest first, and the limit and cooldown follow them', () => {
    const standing = standingOf({
      rows: [
        row({ id: 'old', number: 1, status: 'submitted', submittedAt: now - 5 * DAY }),
        row({ id: 'new', number: 2, status: 'in_review', submittedAt: now - 2 * DAY }),
        row({ id: 'other-form', formId: 'events', number: 3, submittedAt: now }),
      ],
      form,
      latest,
      draftExpiryDays: 30,
      now,
    });

    expect(standing.active.map((application) => application.id)).toEqual(['new', 'old']);
    expect(standing.full).toBe(true);
    expect(standing.retryAt).toBe(now - 2 * DAY + 10 * DAY);
    expect(standing.cooling).toBe(true);
    expect(standing.draft).toBeNull();
  });

  test('a draft cleared by the latest publish is news until the member applies again', () => {
    const cleared = row({
      id: 'cleared',
      number: null,
      status: 'expired',
      submittedAt: null,
      createdAt: now - 3 * DAY,
      updatedAt: now - DAY,
    });

    expect(standingOf({ rows: [cleared], form, latest, draftExpiryDays: 30, now }).restarted).toBe(
      true,
    );

    const since = row({
      id: 'since',
      number: 4,
      status: 'rejected',
      submittedAt: now - DAY / 2,
      decidedAt: now - DAY / 4,
      createdAt: now - DAY / 2,
    });
    expect(
      standingOf({ rows: [since, cleared], form, latest, draftExpiryDays: 30, now }).restarted,
    ).toBe(false);

    expect(
      standingOf({ rows: [cleared], form, latest, draftExpiryDays: 30, now: now + 40 * DAY })
        .restarted,
    ).toBe(false);
  });
});

describe('owner and state checks', () => {
  test('someone else’s step, answers and submit buttons are refused', async () => {
    const h = await ready();
    await answerFirstStep(h);
    const draft = h.draft();

    const step = await h.press(customId(APPLICANT_ACTION.step, draft.id, '0'), {
      userId: STRANGER,
    });
    expect(h.callbackTypesFor(step.interactionId)).toEqual([4]);
    expect(h.lastStatus()).toContain('This application belongs to someone else');

    await h.press(customId(APPLICANT_ACTION.submit, draft.id, String(draft.revision)), {
      userId: STRANGER,
    });
    expect(h.lastStatus()).toContain('This application belongs to someone else');

    await h.submitRaw(
      customId(APPLICANT_ACTION.answer, draft.id, '0', String(draft.revision)),
      [],
      { userId: STRANGER },
    );
    expect(h.lastStatus()).toContain('This application belongs to someone else');
    expect(h.draft().revision).toBe(draft.revision);
    expect(h.draft().status).toBe('draft');
  });

  test('a draft cleared by a form change is explained, then started again on purpose', async () => {
    const h = await ready();
    await answerFirstStep(h);
    const old = h.draft();
    const stepButton = h.button('Continue').customId as string;

    h.advance(MINUTE);
    const changed = moderatorForm({ intro: 'A new introduction.' });
    h.reconfigure((config) => ({ ...config, forms: [changed] }));
    await h.store.publish({
      guildId: GUILD,
      formId: 'mods',
      snapshot: snapshotOf(changed),
      draftPolicy: 'restart',
      publishedBy: STRANGER,
      audit: { actorId: STRANGER, source: 'dashboard', action: 'publish', id: 'publish-2' },
    });
    expect((await h.store.get(GUILD, old.id))?.status).toBe('expired');

    await h.press(stepButton);
    expect(h.lastStatus()).toContain('Your saved answers were cleared because this form changed');

    const stale = await h.press(customId(APPLICANT_ACTION.start, 'mods'));
    expect(h.callbackTypesFor(stale.interactionId)).toEqual([4]);
    expect(h.lastStatus()).toContain('Your saved answers were cleared because this form changed');

    const again = await h.pressButton('Start again');
    expect(h.callbackTypesFor(again.interactionId)).toEqual([9]);
    expect(h.draft().id).not.toBe(old.id);
  });

  test('the overview offers status, answer and withdraw instead of Start while one is waiting', async () => {
    const h = await ready();
    await completeDraft(h);
    await h.pressButton('Submit');

    await openOverview(h);
    const labels = h.buttons().map((button) => button.label);
    expect(labels).toEqual(['View status', 'Withdraw', 'My applications']);
    expect(h.text()).toContain(
      'You already have an application for this form: **#1** · Submitted.',
    );
    expect(h.text()).toContain('You can apply again once it’s decided or withdrawn.');

    const again = await h.press(customId(APPLICANT_ACTION.start, 'mods'));
    expect(h.callbackTypesFor(again.interactionId)).toEqual([4]);
    expect(h.lastStatus()).toContain('waiting for a decision');
  });

  test('the dropdown panel opens the same overview for the chosen form', async () => {
    const h = await ready();
    const chosen = await h.select(customId(APPLICANT_ACTION.openSelect, 'staff'), ['mods'], {
      panel: true,
    });

    expect(h.callbackTypesFor(chosen.interactionId)).toEqual([5]);
    expect(h.text()).toContain('## Moderator Application');
    expect(h.button('Start').customId).toBe(customId(APPLICANT_ACTION.start, 'mods'));
  });

  test('an archived form still on a panel explains itself', async () => {
    const h = await ready();
    h.reconfigure((config) => ({ ...config, forms: [moderatorForm({ archived: true })] }));

    await openOverview(h);
    expect(h.text()).toContain('This form is no longer taking applications.');
    expect(h.buttons().map((button) => button.label)).toEqual(['My applications']);
  });

  test('requirements that can’t be checked block Start and say why', async () => {
    const h = await ready({
      forms: [moderatorForm({ requirements: { minLevel: 5 } })],
      deps: { availability: { isEnabled: async () => false } },
    });

    await openOverview(h);
    expect(h.text()).toContain('I can’t check every requirement right now:');
    expect(h.text()).toContain('needs Leveling, which is off in this server.');
    expect(h.text()).toContain(
      'I can’t start your application until every requirement can be checked.',
    );
    expect(h.buttons().map((button) => button.label)).toEqual(['My applications']);
  });

  test('a deadline is shown as a relative Discord timestamp', async () => {
    const closesAt = Date.UTC(2026, 9, 1, 18, 0, 0);
    const h = await ready({
      forms: [moderatorForm({ intake: { open: true, cooldownDays: 0, closesAt } })],
    });

    await openOverview(h);
    expect(h.text()).toContain(`<t:${closesAt / 1000}:R>`);
  });

  test('a closed form shows why and offers no Start', async () => {
    const h = await ready({ forms: [moderatorForm({ intake: { open: false } })] });
    await openOverview(h);

    expect(h.text()).toContain('This form isn’t taking applications right now.');
    expect(h.buttons().map((button) => button.label)).toEqual(['My applications']);
  });

  test('an overview stays inside Discord’s text budget', async () => {
    const long = 'x'.repeat(2000);
    const h = await ready({
      forms: [
        moderatorForm({
          intro: long,
          description: 'd'.repeat(200),
          requirements: {
            roleIds: Array.from(
              { length: 25 },
              (_, i) => `41000000000000${String(i).padStart(4, '0')}`,
            ),
          },
          intake: { open: false },
          messages: { closed: 'c'.repeat(1000) },
        }),
      ],
    });
    await openOverview(h);

    const total = textsOf(h.lastScreen()).reduce((sum, text) => sum + text.length, 0);
    expect(total).toBeLessThanOrEqual(4000);
  });
});
