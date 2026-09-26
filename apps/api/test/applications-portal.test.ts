import { describe, expect, test } from 'bun:test';
import {
  draftSaveBodySchema,
  myApplicationsSchema,
  portalApplicationSchema,
  portalFormSchema,
  portalGuildSchema,
  portalSubmitBodySchema,
  staffActionSchema,
} from '@proton/module-applications/view';
import { ApplicationsError } from '../src/applications/errors.ts';
import { PortalService } from '../src/applications/portal.ts';
import { ApplicationsService } from '../src/applications/service.ts';
import {
  ACCESS_WORDS,
  APPLICANT,
  auditLookupOf,
  buildConfig,
  buildForm,
  DAY,
  GUILD,
  type Harness,
  HIGH_ROLE,
  harnessParts,
  NOW,
  OTHER_APPLICANT,
  OTHER_GUILD,
  REVIEWER,
  seedSubmitted,
} from './application-fixtures.ts';

const NOTE_TEXT = 'Internal: strong candidate, but check their timezone.';

function build(h: Harness) {
  const portal = new PortalService({
    store: h.store,
    modules: h.modules,
    members: h.members,
    providers: h.providers,
    bus: h.bus,
    logger: { error: () => undefined, warn: () => undefined },
    now: () => NOW,
  });

  const staff = new ApplicationsService({
    store: h.store,
    modules: h.modules,
    members: h.members,
    providers: h.providers,
    audit: async (entry) => {
      h.audits.push(entry);
    },
    audits: auditLookupOf(h.store),
    bus: h.bus,
    logger: { error: () => undefined, warn: () => undefined },
    now: () => NOW,
  });

  return { portal, staff };
}

function save(
  answers: Record<string, unknown>,
  expectedRevision: number | null,
  requestId = 'req_save_0001',
) {
  return draftSaveBodySchema.parse({ userId: APPLICANT, answers, expectedRevision, requestId });
}

function submitBody(expectedRevision: number, requestId = 'req_submit_001') {
  return portalSubmitBodySchema.parse({ userId: APPLICANT, expectedRevision, requestId });
}

async function refusedWith(promise: Promise<unknown>): Promise<ApplicationsError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ApplicationsError) return error;
    throw error;
  }
  throw new Error('expected an ApplicationsError');
}

describe('reading forms', () => {
  test('the form page carries the published version, eligibility and nothing staff-only', async () => {
    const h = harnessParts();
    const { portal } = build(h);

    const view = portalFormSchema.parse(await portal.form(GUILD, 'mods', APPLICANT));

    expect(view.guild).toEqual({
      id: GUILD,
      name: 'Proton Test Server',
      iconUrl: `https://cdn.discordapp.com/icons/${GUILD}/abc123.png`,
    });
    expect(view.form.id).toBe('mods');
    expect(view.intake).toEqual({ state: 'open' });
    expect(view.eligibility.state).toBe('eligible');
    expect(view.draft).toBeNull();
    expect(Object.keys(view.form)).not.toContain('review');
  });

  test('a member who left is told so; an unreadable membership is not treated as leaving', async () => {
    const h = harnessParts();
    const { portal } = build(h);

    h.members.absent.add(APPLICANT);
    expect((await refusedWith(portal.form(GUILD, 'mods', APPLICANT))).code).toBe('not_member');

    h.members.absent.clear();
    h.members.unavailable.add(APPLICANT);
    expect((await refusedWith(portal.form(GUILD, 'mods', APPLICANT))).code).toBe('unavailable');
  });

  test('with the module off the page still loads and says so', async () => {
    const h = harnessParts();
    h.modules.enabled = false;
    const { portal } = build(h);

    const view = await portal.form(GUILD, 'mods', APPLICANT);
    expect(view.intake).toEqual({ state: 'closed', reason: 'module_off' });
    expect(view.intakeSentence).toBe('Applications are off in this server right now.');

    const guild = portalGuildSchema.parse(await portal.guildForms(GUILD, APPLICANT));
    expect(guild.moduleOn).toBe(false);
  });

  test('an unpublished or unknown form is not found', async () => {
    const h = harnessParts();
    h.modules.config = buildConfig({
      forms: [buildForm(), buildForm({ id: 'fresh', name: 'Fresh' })],
    });
    const { portal } = build(h);

    expect((await refusedWith(portal.form(GUILD, 'fresh', APPLICANT))).code).toBe('not_found');
    expect((await refusedWith(portal.form(GUILD, 'nope', APPLICANT))).code).toBe('not_found');
  });
});

describe('drafts', () => {
  test('the first save starts a web draft and later saves check the revision', async () => {
    const h = harnessParts();
    const { portal } = build(h);

    const first = await portal.saveDraft(GUILD, 'mods', save({ why: 'I like helping' }, null));
    expect(first).toMatchObject({ status: 'saved', revision: 1 });

    const draft = await h.store.draftFor(GUILD, 'mods', APPLICANT);
    expect(draft).toMatchObject({ source: 'web', draft: { why: 'I like helping' } });

    const second = await portal.saveDraft(GUILD, 'mods', save({ why: 'I like helping a lot' }, 1));
    expect(second).toMatchObject({ status: 'saved', revision: 2 });

    const stale = await portal.saveDraft(GUILD, 'mods', save({ why: 'Older tab' }, 1));
    expect(stale).toEqual({
      status: 'conflict',
      draft: { revision: 2, answers: { why: 'I like helping a lot' }, updatedAt: NOW },
    });

    const unknownDevice = await portal.saveDraft(GUILD, 'mods', save({ why: 'Phone' }, null));
    expect(unknownDevice.status).toBe('conflict');
  });

  test('a retried save of the same answers is not a conflict', async () => {
    const h = harnessParts();
    const { portal } = build(h);

    await portal.saveDraft(GUILD, 'mods', save({ why: 'Same' }, null));
    await portal.saveDraft(GUILD, 'mods', save({ why: 'Same again' }, 1));

    expect(await portal.saveDraft(GUILD, 'mods', save({ why: 'Same again' }, 1))).toMatchObject({
      status: 'saved',
      revision: 2,
    });
  });

  test('answers for questions the form does not have are dropped', async () => {
    const h = harnessParts();
    const { portal } = build(h);

    await portal.saveDraft(GUILD, 'mods', save({ why: 'Yes', injected: 'surprise' }, null));
    expect((await h.store.draftFor(GUILD, 'mods', APPLICANT))?.draft).toEqual({ why: 'Yes' });
  });

  test('saves are refused while the module is off, and new drafts while intake is closed', async () => {
    const h = harnessParts();
    const { portal } = build(h);

    h.modules.enabled = false;
    const off = await portal.saveDraft(GUILD, 'mods', save({ why: 'x' }, null));
    expect(off).toEqual({
      status: 'refused',
      message: 'Applications is off in this server right now, so your answers weren’t saved.',
    });

    h.modules.enabled = true;
    h.modules.config = buildConfig({ forms: [buildForm({ intake: { open: false } })] });
    const closed = await portal.saveDraft(GUILD, 'mods', save({ why: 'x' }, null));
    expect(closed.status).toBe('refused');
    expect(await h.store.draftFor(GUILD, 'mods', APPLICANT)).toBeNull();
  });

  test('an ineligible member cannot start a draft', async () => {
    const h = harnessParts();
    h.modules.config = buildConfig({
      forms: [buildForm({ requirements: { roleIds: [HIGH_ROLE] } })],
    });
    const published = await h.store.version(GUILD, 'version-01-mods-1');
    if (published === null) throw new Error('expected the seeded version');
    h.store.seedVersion({
      id: 'version-01-mods-2',
      guildId: GUILD,
      formId: 'mods',
      version: 2,
      snapshot: {
        ...published.snapshot,
        requirements: { ...buildForm().requirements, roleIds: [HIGH_ROLE] },
      },
      draftPolicy: 'keep',
      publishedBy: REVIEWER,
      publishedAt: NOW - DAY,
    });
    const { portal } = build(h);

    const refused = await portal.saveDraft(GUILD, 'mods', save({ why: 'x' }, null));
    expect(refused).toMatchObject({ status: 'refused' });
    if (refused.status === 'refused') expect(refused.message).not.toMatch(ACCESS_WORDS);
  });

  test('discarding removes only the applicant’s own draft', async () => {
    const h = harnessParts();
    const { portal } = build(h);
    await portal.saveDraft(GUILD, 'mods', save({ why: 'x' }, null));

    expect(
      await portal.discard(GUILD, 'mods', { userId: OTHER_APPLICANT, requestId: 'req_discard_1' }),
    ).toEqual({ discarded: false });
    expect(
      await portal.discard(GUILD, 'mods', { userId: APPLICANT, requestId: 'req_discard_2' }),
    ).toEqual({ discarded: true });
  });

  test('a first save from a page showing an older version starts nothing', async () => {
    const h = harnessParts();
    const published = await h.store.version(GUILD, 'version-01-mods-1');
    if (published === null) throw new Error('expected the seeded version');
    h.store.seedVersion({ ...published, id: 'version-01-mods-2', version: 2 });
    const { portal } = build(h);

    const body = (versionId: string) =>
      draftSaveBodySchema.parse({
        userId: APPLICANT,
        answers: { why: 'Because' },
        expectedRevision: null,
        requestId: 'req_save_0001',
        versionId,
      });

    expect(await portal.saveDraft(GUILD, 'mods', body('version-01-mods-1'))).toEqual({
      status: 'refused',
      message: 'This form was updated. Reload the page to see the new questions.',
    });
    expect(await h.store.draftFor(GUILD, 'mods', APPLICANT)).toBeNull();

    expect(await portal.saveDraft(GUILD, 'mods', body('version-01-mods-2'))).toMatchObject({
      status: 'saved',
      revision: 1,
    });
    expect((await h.store.draftFor(GUILD, 'mods', APPLICANT))?.versionId).toBe('version-01-mods-2');
  });
});

describe('submitting', () => {
  test('invalid answers come back as problems; valid ones submit once, even when clicked twice', async () => {
    const h = harnessParts();
    const { portal } = build(h);

    await portal.saveDraft(GUILD, 'mods', save({ age: '9' }, null));
    const invalid = await portal.submit(GUILD, 'mods', submitBody(1));
    expect(invalid.status).toBe('invalid');
    if (invalid.status === 'invalid') {
      expect(invalid.problems.map((problem) => problem.questionId).sort()).toEqual(['age', 'why']);
    }

    await portal.saveDraft(GUILD, 'mods', save({ why: 'Because', age: '21' }, 1));
    const sent = await portal.submit(GUILD, 'mods', submitBody(2));
    expect(sent).toMatchObject({ status: 'submitted', number: 1 });
    if (sent.status !== 'submitted') return;

    const stored = await h.store.get(GUILD, sent.applicationId);
    expect(stored).toMatchObject({
      status: 'submitted',
      source: 'web',
      applicantName: 'Member 01',
    });
    expect(h.store.effectsOf(sent.applicationId).map((effect) => effect.kind)).toContain('card');
    expect(h.bus.events.at(-1)?.payload).toEqual({
      guildId: GUILD,
      applicationId: sent.applicationId,
      reason: 'submission',
    });

    expect(await portal.submit(GUILD, 'mods', submitBody(2, 'req_submit_002'))).toEqual(sent);
  });

  test('a stale revision is a conflict and a member who left is refused', async () => {
    const h = harnessParts();
    const { portal } = build(h);
    await portal.saveDraft(GUILD, 'mods', save({ why: 'Because' }, null));

    expect(await portal.submit(GUILD, 'mods', submitBody(0))).toEqual({
      status: 'conflict',
      revision: 1,
    });

    h.members.absent.add(APPLICANT);
    expect(await portal.submit(GUILD, 'mods', submitBody(1))).toMatchObject({
      status: 'refused',
      message: 'You need to be a member of this server to apply to its forms.',
    });
  });

  test('the database’s active-application limit is reported, not bypassed', async () => {
    const h = harnessParts();
    seedSubmitted(h.store, { id: 'app-1', number: 1 });
    const { portal } = build(h);

    const refused = await portal.saveDraft(GUILD, 'mods', save({ why: 'Again' }, null));
    expect(refused.status).toBe('refused');
  });
});

describe('the applicant’s own application', () => {
  test('never carries notes, votes or reviewer ids, and only the applicant can read it', async () => {
    const h = harnessParts();
    seedSubmitted(h.store);
    const { portal, staff } = build(h);

    for (const body of [
      { action: 'claim', requestId: 'req_claim_0001' },
      { action: 'note', body: NOTE_TEXT, requestId: 'req_note_00001' },
      { action: 'vote', vote: 'reject', requestId: 'req_vote_00001' },
      { action: 'request_info', message: 'What timezone are you in?', requestId: 'req_info_00001' },
    ]) {
      await staff.act(
        GUILD,
        'app-1',
        staffActionSchema.parse({ ...body, actorId: REVIEWER, source: 'dashboard' }),
      );
    }

    const view = portalApplicationSchema.parse(await portal.application(GUILD, 'app-1', APPLICANT));
    const json = JSON.stringify(view);

    expect(view.status).toBe('needs_info');
    expect(view.canRespond).toBe(true);
    expect(view.thread).toEqual([
      expect.objectContaining({ kind: 'info_request', authorId: 'staff' }),
    ]);
    expect(json).not.toContain(NOTE_TEXT);
    expect(json).not.toContain(REVIEWER);

    expect((await refusedWith(portal.application(GUILD, 'app-1', OTHER_APPLICANT))).code).toBe(
      'not_found',
    );
    expect((await refusedWith(portal.application(OTHER_GUILD, 'app-1', APPLICANT))).code).toBe(
      'not_found',
    );
  });

  test('answering a follow-up sends it back to review, once', async () => {
    const h = harnessParts();
    seedSubmitted(h.store, { status: 'needs_info', infoDueAt: NOW + DAY });
    const { portal } = build(h);
    const body = { userId: APPLICANT, message: 'UTC+1', requestId: 'req_respond_01' };

    const answered = await portal.respond(GUILD, 'app-1', body);
    expect(answered.status).toBe('submitted');
    expect(answered.thread.map((entry) => [entry.kind, entry.authorId])).toEqual([
      ['info_response', APPLICANT],
    ]);

    expect((await portal.respond(GUILD, 'app-1', body)).status).toBe('submitted');
    expect(h.store.threadRows).toHaveLength(1);

    expect(
      (await refusedWith(portal.respond(GUILD, 'app-1', { ...body, requestId: 'req_respond_02' })))
        .code,
    ).toBe('stale');
  });

  test('withdrawing works once, is refused while the module is off, and sets retention', async () => {
    const h = harnessParts();
    seedSubmitted(h.store);
    const { portal } = build(h);
    const body = { userId: APPLICANT, requestId: 'req_withdraw_1' };

    h.modules.enabled = false;
    expect((await refusedWith(portal.withdraw(GUILD, 'app-1', body))).code).toBe('module_disabled');

    h.modules.enabled = true;
    const withdrawn = await portal.withdraw(GUILD, 'app-1', body);
    expect(withdrawn).toMatchObject({ status: 'withdrawn', canWithdraw: false });
    expect((await h.store.get(GUILD, 'app-1'))?.contentPurgeAt).toBe(NOW + 30 * DAY);

    expect((await portal.withdraw(GUILD, 'app-1', body)).status).toBe('withdrawn');
  });

  test('my applications spans servers and skips deleted ones', async () => {
    const h = harnessParts();
    seedSubmitted(h.store, { id: 'here', number: 1 });
    seedSubmitted(h.store, { id: 'there', number: 1, guildId: OTHER_GUILD });
    seedSubmitted(h.store, { id: 'gone', number: 2, deletedAt: NOW });
    seedSubmitted(h.store, { id: 'theirs', number: 3, applicantId: OTHER_APPLICANT });
    const { portal } = build(h);

    const mine = myApplicationsSchema.parse(await portal.mine(APPLICANT));
    expect(mine.items.map((item) => `${item.guildId}:${item.id}`).sort()).toEqual(
      [`${GUILD}:here`, `${OTHER_GUILD}:there`].sort(),
    );
    expect(mine.items[0]?.formName).toBe('Moderator Application');
  });
});
