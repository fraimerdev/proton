import { describe, expect, test } from 'bun:test';
import { type CaseQuery, type CaseSearchResult, Permissions } from '@proton/core';
import { EXPORT_ROWS_MAX } from '@proton/module-applications/constants';
import {
  applicationDetailSchema,
  audienceSchema,
  eligibilityPreviewSchema,
  exportQuerySchema,
  formOverviewSchema,
  publishBodySchema,
  queueQuerySchema,
  queueResultSchema,
  reviewMembersSchema,
  staffActionResultSchema,
  staffActionSchema,
} from '@proton/module-applications/view';
import { ApplicationsError } from '../src/applications/errors.ts';
import { ApplicationsService } from '../src/applications/service.ts';
import {
  ACCESS_WORDS,
  ADMIN,
  APPLICANT,
  auditLookupOf,
  buildConfig,
  buildForm,
  DAY,
  DECIDER,
  DECIDER_ROLE,
  EVENTS_REVIEWER,
  EXPORT_ROLE,
  GUILD,
  type Harness,
  HIGH_ROLE,
  harnessParts,
  LOW_ROLE,
  MODERATOR,
  NOW,
  OTHER_APPLICANT,
  OTHER_GUILD,
  OUTSIDER,
  OVERRIDE_ROLE,
  PROTON_BOT,
  PROTON_ROLE,
  REVIEW_CHANNEL,
  REVIEWER,
  REVIEWER_ROLE,
  SECOND,
  seedSubmitted,
} from './application-fixtures.ts';

const NOTE_TEXT = 'Checked their history: two warnings last year, both for spam.';
const REASON_TEXT = 'Thanks for applying, you are a great fit for the team.';

function build(h: Harness, withCases = true) {
  const searches: CaseQuery[] = [];
  const cases = {
    async search(_guildId: string, query: CaseQuery): Promise<CaseSearchResult> {
      searches.push(query);
      return {
        cases: [
          {
            id: 'case-1',
            caseNumber: 7,
            type: 'timeout',
            actorId: MODERATOR,
            targetId: APPLICANT,
            moderatorId: MODERATOR,
            reason: 'spam',
            moduleId: 'moderation',
            expiresAt: new Date(NOW + DAY).toISOString(),
            revertedAt: null,
            revertedBy: null,
            dryRun: false,
            createdAt: new Date(NOW - DAY).toISOString(),
          },
        ],
        total: 1,
        page: 1,
        pageSize: 200,
      };
    },
  };

  const service = new ApplicationsService({
    store: h.store,
    modules: h.modules,
    members: h.members,
    providers: h.providers,
    audit: async (entry) => {
      h.audits.push(JSON.parse(JSON.stringify(entry)));
    },
    audits: auditLookupOf(h.store),
    ...(withCases ? { cases } : {}),
    bus: h.bus,
    logger: { error: () => undefined, warn: () => undefined },
    now: () => NOW,
  });

  return { service, searches };
}

function action(body: Record<string, unknown>) {
  return staffActionSchema.parse({ source: 'dashboard', ...body });
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

const QUEUE = queueQuerySchema.parse({ view: 'all' });

describe('queue and summary', () => {
  test('a reviewer sees only the forms their team covers, never their own application', async () => {
    const h = harnessParts();
    seedSubmitted(h.store, { id: 'app-1', number: 1 });
    seedSubmitted(h.store, {
      id: 'app-2',
      number: 2,
      formId: 'events',
      applicantId: OTHER_APPLICANT,
    });
    seedSubmitted(h.store, { id: 'app-3', number: 3, applicantId: REVIEWER });
    const { service } = build(h);

    const reviewer = queueResultSchema.parse(await service.queue(GUILD, QUEUE, REVIEWER));
    expect(reviewer.items.map((item) => item.id)).toEqual(['app-1']);
    expect(reviewer.total).toBe(1);

    const events = await service.queue(GUILD, QUEUE, EVENTS_REVIEWER);
    expect(events.items.map((item) => item.id)).toEqual(['app-2']);

    const admin = await service.queue(GUILD, QUEUE, ADMIN);
    expect(admin.items.map((item) => item.id).sort()).toEqual(['app-1', 'app-2', 'app-3']);

    const summary = await service.summary(GUILD, REVIEWER);
    expect(summary.awaiting).toBe(1);
  });

  test('someone on no review team is refused, in words that never read as a lost sign-in', async () => {
    const h = harnessParts();
    const { service } = build(h);

    const error = await refusedWith(service.queue(GUILD, QUEUE, OUTSIDER));
    expect(error.code).toBe('not_allowed');
    expect(error.message).not.toMatch(ACCESS_WORDS);
  });

  test('a viewer Discord says has left, or whose roles can’t be read, is refused distinctly', async () => {
    const h = harnessParts();
    const { service } = build(h);

    h.members.absent.add(REVIEWER);
    expect((await refusedWith(service.queue(GUILD, QUEUE, REVIEWER))).code).toBe('not_member');

    h.members.absent.clear();
    h.members.unavailable.add(REVIEWER);
    expect((await refusedWith(service.queue(GUILD, QUEUE, REVIEWER))).code).toBe('unavailable');
  });
});

describe('detail', () => {
  test('hides the viewer’s own application, drafts and other servers’ applications', async () => {
    const h = harnessParts();
    seedSubmitted(h.store, { id: 'own', number: 3, applicantId: REVIEWER });
    seedSubmitted(h.store, { id: 'draft', number: null, status: 'draft', submittedAt: null });
    seedSubmitted(h.store, { id: 'elsewhere', guildId: OTHER_GUILD });
    const { service } = build(h);

    for (const id of ['own', 'draft', 'elsewhere', 'missing']) {
      expect((await refusedWith(service.detail(GUILD, id, REVIEWER))).code).toBe('not_found');
    }
  });

  test('notes and votes only reach viewers who can review', async () => {
    const config = buildConfig({ viewerRoleIds: [EXPORT_ROLE] });
    const h = harnessParts(config);
    h.members.roleIds.set(OUTSIDER, [EXPORT_ROLE]);
    seedSubmitted(h.store);
    const { service } = build(h);

    await service.act(
      GUILD,
      'app-1',
      action({ action: 'note', body: NOTE_TEXT, requestId: 'req_note_0001', actorId: REVIEWER }),
    );

    const reviewer = applicationDetailSchema.parse(await service.detail(GUILD, 'app-1', REVIEWER));
    expect(reviewer.notes?.map((note) => note.body)).toEqual([NOTE_TEXT]);
    expect(reviewer.votes).toEqual([]);
    expect(reviewer.capabilities).toEqual(['view', 'review']);

    const viewer = await service.detail(GUILD, 'app-1', OUTSIDER);
    expect(viewer.notes).toBeNull();
    expect(viewer.votes).toBeNull();
    expect(viewer.capabilities).toEqual(['view', 'export']);
    expect(JSON.stringify(viewer)).not.toContain(NOTE_TEXT);
  });

  test('moderation context only reaches admins and members with moderation permissions', async () => {
    const h = harnessParts();
    seedSubmitted(h.store);
    const { service, searches } = build(h);

    expect((await service.detail(GUILD, 'app-1', REVIEWER)).moderation).toBeNull();
    expect(searches).toHaveLength(0);

    const moderator = await service.detail(GUILD, 'app-1', MODERATOR);
    expect(moderator.moderation).toEqual({
      activeCases: 1,
      recent: [{ caseNumber: 7, type: 'timeout', createdAt: NOW - DAY, reason: 'spam' }],
    });
    expect(searches[0]).toMatchObject({ targetId: APPLICANT, scope: 'moderation' });

    expect((await service.detail(GUILD, 'app-1', ADMIN)).moderation).not.toBeNull();
  });
});

describe('act', () => {
  test('a claim moves the application, audits ids only and asks the worker to run', async () => {
    const h = harnessParts();
    seedSubmitted(h.store);
    const { service } = build(h);

    const result = staffActionResultSchema.parse(
      await service.act(
        GUILD,
        'app-1',
        action({ action: 'claim', requestId: 'req_claim_0001', actorId: REVIEWER }),
      ),
    );

    expect(result).toMatchObject({ ok: true, code: 'done' });
    expect(result.application).toMatchObject({ status: 'in_review', assigneeId: REVIEWER });

    const audit = h.store.auditRows.get(`applications.claim:${GUILD}:req_claim_0001`);
    expect(audit).toMatchObject({
      actorId: REVIEWER,
      source: 'dashboard',
      action: 'module.applications.claim',
      guildId: GUILD,
    });

    expect(h.store.eventsOf('app-1').map((event) => event.id)).toContain(
      'app-1:claimed:dashboard:req_claim_0001',
    );
    expect(h.bus.events.map((event) => event.type)).toEqual(['applications.work_requested']);
    expect(h.bus.events[0]?.payload).toEqual({
      guildId: GUILD,
      applicationId: 'app-1',
      reason: 'decision',
    });
  });

  test('a replayed request answers from state and changes nothing again', async () => {
    const h = harnessParts();
    seedSubmitted(h.store);
    const { service } = build(h);
    const claim = action({ action: 'claim', requestId: 'req_claim_0001', actorId: REVIEWER });

    await service.act(GUILD, 'app-1', claim);
    const events = h.store.eventsOf('app-1').length;
    const revision = (await h.store.get(GUILD, 'app-1'))?.revision;

    const again = await service.act(GUILD, 'app-1', claim);

    expect(again).toMatchObject({ ok: true, code: 'replayed' });
    expect(h.store.eventsOf('app-1')).toHaveLength(events);
    expect((await h.store.get(GUILD, 'app-1'))?.revision).toBe(revision);
  });

  test('a reviewer removed from the team is refused on their next action', async () => {
    const h = harnessParts();
    seedSubmitted(h.store);
    const { service } = build(h);

    await service.act(
      GUILD,
      'app-1',
      action({ action: 'claim', requestId: 'req_claim_0001', actorId: REVIEWER }),
    );
    h.members.roleIds.set(REVIEWER, []);

    const error = await refusedWith(
      service.act(
        GUILD,
        'app-1',
        action({ action: 'unclaim', requestId: 'req_unclaim_01', actorId: REVIEWER }),
      ),
    );
    expect(error.code).toBe('not_allowed');
    expect(error.message).toBe('You aren’t on the review team for Moderator Application.');
    expect((await h.store.get(GUILD, 'app-1'))?.assigneeId).toBe(REVIEWER);
  });

  test('nobody acts on their own application, and a reviewer cannot decide', async () => {
    const h = harnessParts();
    seedSubmitted(h.store);
    const { service } = build(h);

    const decision = await service.act(
      GUILD,
      'app-1',
      action({ action: 'accept', requestId: 'req_accept_01', actorId: REVIEWER }),
    );
    expect(decision).toMatchObject({ ok: false, code: 'not_allowed' });
    expect(decision.message).not.toMatch(ACCESS_WORDS);

    seedSubmitted(h.store, { id: 'app-9', number: 9, applicantId: DECIDER });
    expect(
      (
        await refusedWith(
          service.act(
            GUILD,
            'app-9',
            action({ action: 'accept', requestId: 'req_accept_02', actorId: DECIDER }),
          ),
        )
      ).code,
    ).toBe('not_found');
  });

  test('with the module off, workflow changes are refused but reads and delete still work', async () => {
    const h = harnessParts();
    seedSubmitted(h.store);
    h.modules.enabled = false;
    const { service } = build(h);

    const error = await refusedWith(
      service.act(
        GUILD,
        'app-1',
        action({ action: 'claim', requestId: 'req_claim_0001', actorId: REVIEWER }),
      ),
    );
    expect(error.code).toBe('module_disabled');
    expect(error.message).toBe(
      'Applications is off in this server, so nothing was changed. Turn it on to review again.',
    );

    expect((await service.queue(GUILD, QUEUE, REVIEWER)).total).toBe(1);
    expect((await service.detail(GUILD, 'app-1', REVIEWER)).application.id).toBe('app-1');

    const deleted = await service.act(
      GUILD,
      'app-1',
      action({ action: 'delete', confirm: true, requestId: 'req_delete_01', actorId: ADMIN }),
    );
    expect(deleted).toMatchObject({ ok: true, code: 'done' });
    expect((await h.store.get(GUILD, 'app-1'))?.deletedAt).toBe(NOW);
  });

  test('two reviewers: the decider counts once and needs a second matching vote', async () => {
    const config = buildConfig({
      forms: [buildForm({ review: { channelId: REVIEW_CHANNEL, requireTwoReviewers: true } })],
    });
    const h = harnessParts(config);
    seedSubmitted(h.store);
    const { service } = build(h);

    const alone = await service.act(
      GUILD,
      'app-1',
      action({ action: 'accept', requestId: 'req_accept_01', actorId: DECIDER }),
    );
    expect(alone).toMatchObject({ ok: false, code: 'two_reviewers' });

    await service.act(
      GUILD,
      'app-1',
      action({ action: 'vote', vote: 'accept', requestId: 'req_vote_0001', actorId: SECOND }),
    );

    const accepted = await service.act(
      GUILD,
      'app-1',
      action({
        action: 'accept',
        reason: REASON_TEXT,
        note: NOTE_TEXT,
        requestId: 'req_accept_02',
        actorId: DECIDER,
      }),
    );
    expect(accepted).toMatchObject({ ok: true, code: 'done' });

    const stored = await h.store.get(GUILD, 'app-1');
    expect(stored).toMatchObject({
      status: 'accepted',
      decidedBy: DECIDER,
      decisionReason: REASON_TEXT,
      contentPurgeAt: NOW + 30 * DAY,
    });
    expect((await h.store.votes(GUILD, 'app-1')).map((vote) => vote.reviewerId).sort()).toEqual(
      [DECIDER, SECOND].sort(),
    );

    const rows = JSON.stringify([...h.store.auditRows.values(), ...h.store.eventsOf('app-1')]);
    expect(rows).not.toContain(NOTE_TEXT);
    expect(rows).not.toContain(REASON_TEXT);
    expect(h.store.auditRows.get(`applications.accept:${GUILD}:req_accept_02`)?.after).toEqual({
      action: 'accept',
      requestId: 'req_accept_02',
      status: 'accepted',
      reasonLength: REASON_TEXT.length,
      noteLength: NOTE_TEXT.length,
      override: false,
    });
  });

  test('an override role can decide without a second reviewer, and it is audited', async () => {
    const config = buildConfig({
      forms: [buildForm({ review: { channelId: REVIEW_CHANNEL, requireTwoReviewers: true } })],
    });
    const h = harnessParts(config);
    h.members.roleIds.set(DECIDER, [DECIDER_ROLE, OVERRIDE_ROLE]);
    seedSubmitted(h.store);
    const { service } = build(h);

    const refused = await service.act(
      GUILD,
      'app-1',
      action({ action: 'reject', requestId: 'req_reject_01', actorId: DECIDER }),
    );
    expect(refused).toMatchObject({ ok: false, code: 'two_reviewers' });

    const overridden = await service.act(
      GUILD,
      'app-1',
      action({ action: 'reject', override: true, requestId: 'req_reject_02', actorId: DECIDER }),
    );
    expect(overridden).toMatchObject({ ok: true, code: 'done' });
    expect(
      h.store.auditRows.get(`applications.reject:${GUILD}:req_reject_02`)?.after,
    ).toMatchObject({ override: true });
    expect(h.store.eventsOf('app-1').map((event) => event.kind)).toContain(
      'override_two_reviewers',
    );
  });

  test('reopening needs the reopen role, keeps the reason private and reruns nothing', async () => {
    const h = harnessParts();
    seedSubmitted(h.store, {
      status: 'accepted',
      decidedAt: NOW - DAY,
      decidedBy: DECIDER,
      contentPurgeAt: NOW + 29 * DAY,
    });
    const { service } = build(h);
    const reopen = (actorId: string, requestId: string) =>
      action({ action: 'reopen', reason: 'Accepted by mistake', requestId, actorId });

    expect(await service.act(GUILD, 'app-1', reopen(DECIDER, 'req_reopen_01'))).toMatchObject({
      ok: false,
      code: 'not_allowed',
    });

    h.members.roleIds.set(DECIDER, [DECIDER_ROLE, OVERRIDE_ROLE]);
    const done = await service.act(GUILD, 'app-1', reopen(DECIDER, 'req_reopen_02'));
    expect(done).toMatchObject({ ok: true, code: 'done' });

    const stored = await h.store.get(GUILD, 'app-1');
    expect(stored).toMatchObject({
      status: 'submitted',
      decidedAt: null,
      decidedBy: null,
      contentPurgeAt: null,
      reopenedCount: 1,
    });
    expect(h.store.noteRows.map((note) => note.body)).toEqual(['Accepted by mistake']);
    expect(h.store.threadRows).toHaveLength(0);
    expect(
      h.store
        .effectsOf('app-1')
        .map((effect) => effect.kind)
        .sort(),
    ).toEqual(['card', 'event']);
  });

  test('archive only works on decided applications', async () => {
    const h = harnessParts();
    seedSubmitted(h.store);
    const { service } = build(h);

    expect(
      await service.act(
        GUILD,
        'app-1',
        action({ action: 'archive', requestId: 'req_archive_1', actorId: DECIDER }),
      ),
    ).toMatchObject({ ok: false, code: 'wrong_status' });
  });

  test('an interview ticket needs a ticket type and Tickets switched on', async () => {
    const h = harnessParts();
    seedSubmitted(h.store);
    const { service } = build(h);
    const open = (requestId: string) =>
      action({ action: 'open_ticket', requestId, actorId: REVIEWER });

    expect(await service.act(GUILD, 'app-1', open('req_ticket_01'))).toMatchObject({
      ok: false,
      code: 'no_ticket_type',
    });

    h.modules.config = buildConfig({
      forms: [buildForm({ interview: { ticketTypeId: 'interview' } })],
    });
    h.modules.states.tickets = { on: false, config: {} };
    expect(await service.act(GUILD, 'app-1', open('req_ticket_02'))).toMatchObject({
      ok: false,
      code: 'tickets_off',
    });

    h.modules.states.tickets = { on: true, config: {} };
    expect(await service.act(GUILD, 'app-1', open('req_ticket_03'))).toMatchObject({
      ok: true,
      code: 'done',
    });
    const keys = h.store.effectsOf('app-1').map((effect) => effect.key);
    expect(keys.some((key) => key.startsWith('ticket:'))).toBe(true);
  });

  test('assigning checks the assignee is on the review team', async () => {
    const h = harnessParts();
    seedSubmitted(h.store);
    const { service } = build(h);
    const assign = (assigneeId: string | null, requestId: string) =>
      action({ action: 'assign', assigneeId, requestId, actorId: DECIDER });

    expect(await service.act(GUILD, 'app-1', assign(OUTSIDER, 'req_assign_01'))).toMatchObject({
      ok: false,
      code: 'not_allowed',
    });
    expect(await service.act(GUILD, 'app-1', assign(APPLICANT, 'req_assign_02'))).toMatchObject({
      ok: false,
      code: 'self',
    });

    const assigned = await service.act(GUILD, 'app-1', assign(REVIEWER, 'req_assign_03'));
    expect(assigned.application).toMatchObject({ assigneeId: REVIEWER, status: 'in_review' });
  });

  test('a failed effect can be retried once, and only a failed one', async () => {
    const h = harnessParts();
    seedSubmitted(h.store);
    const { service } = build(h);
    await service.act(
      GUILD,
      'app-1',
      action({ action: 'waitlist', requestId: 'req_wait_0001', actorId: REVIEWER }),
    );
    const [dm] = h.store.effectsOf('app-1').filter((effect) => effect.kind === 'dm');
    if (dm === undefined) throw new Error('expected a DM effect');

    const early = await service.act(
      GUILD,
      'app-1',
      action({
        action: 'retry_effect',
        effectId: dm.id,
        requestId: 'req_retry_001',
        actorId: REVIEWER,
      }),
    );
    expect(early).toMatchObject({ ok: false, code: 'not_retryable' });

    h.store.effectsById.set(dm.id, { ...dm, status: 'failed', attempts: 5, error: 'DMs closed' });
    const retried = await service.act(
      GUILD,
      'app-1',
      action({
        action: 'retry_effect',
        effectId: dm.id,
        requestId: 'req_retry_002',
        actorId: REVIEWER,
      }),
    );
    expect(retried).toMatchObject({ ok: true, code: 'done' });
    expect(h.store.effectsById.get(dm.id)).toMatchObject({ status: 'pending', attempts: 0 });
  });
});

describe('export', () => {
  test('needs an export role, escapes spreadsheet formulas and says when it was capped', async () => {
    const h = harnessParts();
    seedSubmitted(h.store, { applicantName: '=HYPERLINK("https://evil.example","click")' });
    for (let index = 2; index <= EXPORT_ROWS_MAX + 1; index += 1) {
      seedSubmitted(h.store, { id: `app-${index}`, number: index, submittedAt: NOW - DAY + index });
    }
    const { service } = build(h);
    const query = exportQuerySchema.parse({ format: 'csv', formId: 'mods' });

    expect((await refusedWith(service.export(GUILD, query, REVIEWER))).code).toBe('not_allowed');

    h.members.roleIds.set(REVIEWER, [REVIEWER_ROLE, EXPORT_ROLE]);
    const file = await service.export(GUILD, query, REVIEWER);

    expect(file.truncated).toBe(true);
    expect(file.rows).toBe(EXPORT_ROWS_MAX);
    const lines = file.body.split('\r\n');
    expect(lines[0]).toContain('Why do you want to help?');
    expect(file.body).toContain(`"'=HYPERLINK(""https://evil.example"",""click"")"`);
    expect(lines.slice(1).every((line) => !/^[=+\-@]|,[=+\-@]/.test(line))).toBe(true);

    const audit = h.audits.at(-1);
    expect(audit).toMatchObject({ action: 'module.applications.export', actorId: REVIEWER });
    expect(audit?.after).toMatchObject({ rows: EXPORT_ROWS_MAX, truncated: true, formId: 'mods' });
    expect(JSON.stringify(audit)).not.toContain('tidy');
  });

  test('JSON carries answers and never the viewer’s own application', async () => {
    const h = harnessParts();
    seedSubmitted(h.store);
    seedSubmitted(h.store, { id: 'own', number: 2, applicantId: ADMIN });
    const { service } = build(h);

    const file = await service.export(GUILD, exportQuerySchema.parse({ format: 'json' }), ADMIN);
    const body = JSON.parse(file.body) as { applications: { id: string }[]; truncated: boolean };

    expect(file.contentType).toBe('application/json; charset=utf-8');
    expect(body.truncated).toBe(false);
    expect(body.applications.map((row) => row.id)).toEqual(['app-1']);
  });
});

describe('forms and publishing', () => {
  test('reports published, unchanged and requirement issues per form', async () => {
    const h = harnessParts();
    h.modules.config = buildConfig({
      forms: [
        buildForm(),
        buildForm({ id: 'events', name: 'Event Application', requirements: { minLevel: 5 } }),
        buildForm({ id: 'fresh', name: 'Fresh Form' }),
      ],
    });
    h.modules.states.leveling = { on: false, config: {} };
    const { service } = build(h);

    const overview = formOverviewSchema.parse(await service.forms(GUILD));
    const byId = new Map(overview.forms.map((form) => [form.id, form]));

    expect(byId.get('mods')).toMatchObject({ draftChanged: false, published: { version: 1 } });
    expect(byId.get('mods')?.intake).toEqual({ state: 'open' });
    expect(byId.get('events')?.draftChanged).toBe(true);
    expect(byId.get('events')?.requirementIssues.map((issue) => issue.id)).toEqual(['level']);
    expect(byId.get('fresh')).toMatchObject({
      published: null,
      draftChanged: true,
      intake: { state: 'closed', reason: 'not_published' },
    });
  });

  test('publishing an unchanged form keeps its version; a change makes a new one', async () => {
    const h = harnessParts();
    const { service } = build(h);
    const body = (requestId: string) =>
      publishBodySchema.parse({ requestId, actorId: ADMIN, source: 'dashboard' });

    expect(await service.publish(GUILD, 'mods', body('req_publish_1'))).toMatchObject({
      status: 'unchanged',
      version: 1,
    });

    h.modules.config = buildConfig({ forms: [buildForm({ name: 'Moderator Application 2027' })] });
    const published = await service.publish(GUILD, 'mods', body('req_publish_2'));
    expect(published).toMatchObject({ status: 'published', version: 2, draftsExpired: 0 });
    expect(h.store.auditRows.get(`applications.publish:${GUILD}:req_publish_2`)).toMatchObject({
      action: 'module.applications.publish',
      actorId: ADMIN,
    });
    expect(h.bus.events.at(-1)?.payload).toEqual({ guildId: GUILD, reason: 'publish' });
  });

  test('a form with publish issues is refused', async () => {
    const h = harnessParts();
    h.modules.config = buildConfig({ forms: [buildForm({ sections: [] })] });
    const { service } = build(h);

    const error = await refusedWith(
      service.publish(
        GUILD,
        'mods',
        publishBodySchema.parse({
          requestId: 'req_publish_1',
          actorId: ADMIN,
          source: 'dashboard',
        }),
      ),
    );
    expect(error.code).toBe('unpublishable');
  });
});

describe('members, audience and eligibility', () => {
  test('names reach reviewers only', async () => {
    const h = harnessParts();
    const { service } = build(h);

    expect((await refusedWith(service.members(GUILD, [APPLICANT], OUTSIDER))).code).toBe(
      'not_allowed',
    );

    const names = reviewMembersSchema.parse(
      await service.members(GUILD, [APPLICANT, 'not-an-id', '999999999999999999'], REVIEWER),
    );
    expect(names.members.map((member) => member.id)).toEqual([APPLICANT]);
    expect(names.members[0]?.displayName).toBe('Member 01');
  });

  test('the audience lists roles that can read the channel but are not on the team', async () => {
    const h = harnessParts();
    h.members.channels.set(REVIEW_CHANNEL, {
      state: 'found',
      guildId: GUILD,
      overwrites: [
        { id: GUILD, type: 0, allow: 0n, deny: Permissions.ViewChannel },
        { id: REVIEWER_ROLE, type: 0, allow: Permissions.ViewChannel, deny: 0n },
        { id: EXPORT_ROLE, type: 0, allow: Permissions.ViewChannel, deny: 0n },
        { id: PROTON_ROLE, type: 0, allow: Permissions.ViewChannel, deny: 0n },
        { id: OTHER_APPLICANT, type: 1, allow: Permissions.ViewChannel, deny: 0n },
        { id: PROTON_BOT, type: 1, allow: Permissions.ViewChannel, deny: 0n },
      ],
    });
    const { service } = build(h);

    const audience = audienceSchema.parse(await service.audience(GUILD, REVIEW_CHANNEL, 'mods'));
    expect(audience.everyone).toBe(false);
    expect(audience.outsideTeam).toEqual([EXPORT_ROLE]);
    expect(audience.roleIds).not.toContain(PROTON_ROLE);
    expect(audience.memberCount).toBe(1);

    h.members.channels.set(REVIEW_CHANNEL, {
      state: 'found',
      guildId: OTHER_GUILD,
      overwrites: [],
    });
    expect((await refusedWith(service.audience(GUILD, REVIEW_CHANNEL))).code).toBe('not_found');
  });

  test('eligibility preview separates absent, unavailable and checked members', async () => {
    const h = harnessParts();
    h.modules.config = buildConfig({
      forms: [buildForm({ requirements: { memberAgeDays: 30, accountAgeDays: 1 } })],
    });
    const { service } = build(h);

    h.members.absent.add(OTHER_APPLICANT);
    expect(await service.eligibilityPreview(GUILD, 'mods', OTHER_APPLICANT)).toEqual({
      member: 'absent',
      eligibility: null,
    });

    const checked = eligibilityPreviewSchema.parse(
      await service.eligibilityPreview(GUILD, 'mods', APPLICANT),
    );
    expect(checked.member).toBe('member');
    expect(checked.eligibility?.state).toBe('eligible');
  });

  test('eligibility preview checks the published requirements until a publish', async () => {
    const h = harnessParts();
    h.modules.config = buildConfig({
      forms: [
        buildForm({ requirements: { roleIds: [HIGH_ROLE] } }),
        buildForm({ id: 'fresh', name: 'Fresh Form', requirements: { roleIds: [HIGH_ROLE] } }),
      ],
    });
    const { service } = build(h);

    const live = eligibilityPreviewSchema.parse(
      await service.eligibilityPreview(GUILD, 'mods', APPLICANT),
    );
    expect(live).toMatchObject({ checked: 'published', eligibility: { state: 'eligible' } });

    const unpublished = await service.eligibilityPreview(GUILD, 'fresh', APPLICANT);
    expect(unpublished).toMatchObject({ checked: 'saved', eligibility: { state: 'ineligible' } });
  });
});

describe('forms removed from settings', () => {
  function retired() {
    const h = harnessParts();
    h.modules.config = buildConfig({ forms: [buildForm()] });
    seedSubmitted(h.store);
    seedSubmitted(h.store, {
      id: 'app-2',
      number: 2,
      formId: 'events',
      applicantId: OTHER_APPLICANT,
    });
    return h;
  }

  test('the forms overview lists published ids that are no longer in settings', async () => {
    const h = retired();
    const { service } = build(h);

    const overview = formOverviewSchema.parse(await service.forms(GUILD));
    expect(overview.forms.map((form) => form.id)).toEqual(['mods']);
    expect(overview.retiredFormIds).toEqual(['events']);
  });

  test('admins still see and export their applications under the published name', async () => {
    const h = retired();
    const { service } = build(h);

    const queue = await service.queue(GUILD, QUEUE, ADMIN);
    expect(queue.items.map((item) => [item.id, item.formName]).sort()).toEqual([
      ['app-1', 'Moderator Application'],
      ['app-2', 'Event Application'],
    ]);
    expect((await service.summary(GUILD, ADMIN)).awaiting).toBe(2);

    const all = await service.export(GUILD, exportQuerySchema.parse({ format: 'json' }), ADMIN);
    const rows = JSON.parse(all.body) as { applications: { id: string }[] };
    expect(rows.applications.map((row) => row.id).sort()).toEqual(['app-1', 'app-2']);

    const one = await service.export(
      GUILD,
      exportQuerySchema.parse({ format: 'csv', formId: 'events' }),
      ADMIN,
    );
    expect(one.rows).toBe(1);
    expect(one.body).toContain('Event Application');
  });

  test('reviewers see only the forms their team covers, and an unknown form is still not found', async () => {
    const h = retired();
    h.members.roleIds.set(REVIEWER, [REVIEWER_ROLE, EXPORT_ROLE]);
    const { service } = build(h);

    const queue = await service.queue(GUILD, QUEUE, REVIEWER);
    expect(queue.items.map((item) => item.id)).toEqual(['app-1']);

    expect(
      (
        await refusedWith(
          service.export(GUILD, exportQuerySchema.parse({ formId: 'events' }), REVIEWER),
        )
      ).code,
    ).toBe('not_allowed');
    expect(
      (await refusedWith(service.export(GUILD, exportQuerySchema.parse({ formId: 'nope' }), ADMIN)))
        .code,
    ).toBe('not_found');
  });

  test('a requirement only the published version has is still reported', async () => {
    const h = harnessParts(buildConfig({ forms: [buildForm({ requirements: { minLevel: 5 } })] }));
    h.modules.config = buildConfig({ forms: [buildForm()] });
    h.modules.states.leveling = { on: false, config: {} };
    const { service } = build(h);

    const [mods] = (await service.forms(GUILD)).forms;
    expect(mods?.requirementIssues.map((issue) => issue.id)).toEqual(['level']);
    expect(mods?.requirementIssues[0]?.humanReason).toContain(
      'The published version still has this requirement',
    );
  });
});

describe('fixes to staff actions', () => {
  function twoReviewerConfig() {
    return buildConfig({
      forms: [
        buildForm({
          review: { channelId: REVIEW_CHANNEL, requireTwoReviewers: true },
          actions: { onSubmit: { addRoleIds: [LOW_ROLE] }, onAccept: { addRoleIds: [HIGH_ROLE] } },
        }),
      ],
    });
  }

  const accept = (requestId: string) => action({ action: 'accept', requestId, actorId: DECIDER });
  const vote = (requestId: string) =>
    action({ action: 'vote', vote: 'accept', requestId, actorId: SECOND });

  test('a second vote only counts while its voter can still review', async () => {
    const h = harnessParts(twoReviewerConfig());
    seedSubmitted(h.store);
    const { service } = build(h);

    await service.act(GUILD, 'app-1', vote('req_vote_0001'));

    h.members.roleIds.set(SECOND, []);
    expect(await service.act(GUILD, 'app-1', accept('req_accept_01'))).toMatchObject({
      ok: false,
      code: 'two_reviewers',
    });

    h.members.roleIds.set(SECOND, [REVIEWER_ROLE]);
    h.members.unavailable.add(SECOND);
    expect(await service.act(GUILD, 'app-1', accept('req_accept_02'))).toMatchObject({
      ok: false,
      code: 'two_reviewers',
    });

    h.members.unavailable.clear();
    expect(await service.act(GUILD, 'app-1', accept('req_accept_03'))).toMatchObject({
      ok: true,
      code: 'done',
    });
  });

  test('reopening clears the votes and skips the earlier decision’s unfinished actions', async () => {
    const h = harnessParts(twoReviewerConfig());
    h.members.roleIds.set(DECIDER, [DECIDER_ROLE, OVERRIDE_ROLE]);
    seedSubmitted(h.store);
    const { service } = build(h);

    await service.act(GUILD, 'app-1', vote('req_vote_0001'));
    expect(await service.act(GUILD, 'app-1', accept('req_accept_01'))).toMatchObject({ ok: true });

    const [role] = h.store.effectsOf('app-1').filter((effect) => effect.kind === 'add_role');
    if (role === undefined) throw new Error('expected the accept to add a role');
    h.store.effectsById.set(role.id, { ...role, status: 'failed', error: 'Role too high' });

    const reopened = await service.act(
      GUILD,
      'app-1',
      action({
        action: 'reopen',
        reason: 'Wrong call',
        requestId: 'req_reopen_01',
        actorId: DECIDER,
      }),
    );
    expect(reopened).toMatchObject({ ok: true, code: 'done' });
    expect(reopened.message).toContain('Earlier votes were cleared');

    expect(await h.store.votes(GUILD, 'app-1')).toEqual([]);
    expect(h.store.effectsById.get(role.id)).toMatchObject({
      status: 'skipped',
      errorCode: 'changed',
    });
    expect(reopened.application?.problems).toEqual([]);

    expect(await service.act(GUILD, 'app-1', accept('req_accept_02'))).toMatchObject({
      ok: false,
      code: 'two_reviewers',
    });
  });

  test('archiving and unarchiving redraw the review card', async () => {
    const h = harnessParts();
    seedSubmitted(h.store, { status: 'accepted', decidedAt: NOW - DAY, decidedBy: DECIDER });
    const { service } = build(h);

    const archived = await service.act(
      GUILD,
      'app-1',
      action({ action: 'archive', requestId: 'req_archive_1', actorId: DECIDER }),
    );
    expect(archived).toMatchObject({ ok: true, code: 'done' });
    expect(h.store.effectsOf('app-1').map((effect) => effect.kind)).toEqual(['card']);
    expect(h.bus.events.map((event) => event.type)).toEqual(['applications.work_requested']);
  });

  test('cancelling an action asks the worker to redraw the card', async () => {
    const h = harnessParts();
    seedSubmitted(h.store, { cardChannelId: REVIEW_CHANNEL, cardMessageId: '600000000000000001' });
    const { service } = build(h);
    await service.act(
      GUILD,
      'app-1',
      action({ action: 'waitlist', requestId: 'req_wait_0001', actorId: REVIEWER }),
    );
    const [dm] = h.store.effectsOf('app-1').filter((effect) => effect.kind === 'dm');
    if (dm === undefined) throw new Error('expected a DM effect');
    const before = h.bus.events.length;

    const cancelled = await service.act(
      GUILD,
      'app-1',
      action({
        action: 'cancel_effect',
        effectId: dm.id,
        requestId: 'req_cancel_01',
        actorId: REVIEWER,
      }),
    );
    expect(cancelled).toMatchObject({ ok: true, code: 'done' });
    expect(h.bus.events.slice(before).map((event) => event.type)).toEqual([
      'applications.work_requested',
    ]);
  });
});

describe('deleting', () => {
  const CARD = { cardChannelId: REVIEW_CHANNEL, cardMessageId: '600000000000000001' };

  function withSubmitRole() {
    return buildConfig({
      forms: [buildForm({ actions: { onSubmit: { addRoleIds: [LOW_ROLE] } } })],
    });
  }

  const remove = (requestId: string) =>
    action({ action: 'delete', confirm: true, requestId, actorId: ADMIN });

  test('a pending application gives back the submit role Proton granted', async () => {
    const h = harnessParts(withSubmitRole());
    seedSubmitted(h.store);
    seedSubmitted(h.store, {
      id: 'app-2',
      number: 2,
      status: 'accepted',
      decidedAt: NOW - DAY,
      decidedBy: DECIDER,
    });
    const { service } = build(h);

    await service.act(GUILD, 'app-1', remove('req_delete_01'));
    await service.act(GUILD, 'app-2', remove('req_delete_02'));

    const deleted = await h.store.get(GUILD, 'app-1');
    expect(
      h.store.effectsOf('app-1').map(({ key, kind, status, params }) => ({
        key,
        kind,
        status,
        params,
      })),
    ).toEqual([
      {
        key: `delete:${deleted?.revision}:cleanup`,
        kind: 'remove_role',
        status: 'pending',
        params: { fromGrants: true, roleIds: [LOW_ROLE], userId: APPLICANT },
      },
    ]);
    expect(h.store.effectsOf('app-2')).toEqual([]);
  });

  test('deleting everything from an applicant gives back their submit roles too', async () => {
    const h = harnessParts(withSubmitRole());
    seedSubmitted(h.store);
    const { service } = build(h);

    expect(
      await service.deleteApplicant(GUILD, APPLICANT, {
        confirm: true,
        requestId: 'req_forget_01',
        actorId: ADMIN,
        source: 'dashboard',
      }),
    ).toEqual({ deleted: 1 });
    expect(h.store.effectsOf('app-1').map((effect) => effect.kind)).toEqual(['remove_role']);
  });

  test('no cleanup is planned when the form keeps submit roles on close', async () => {
    const h = harnessParts(
      buildConfig({
        forms: [
          buildForm({
            actions: { onSubmit: { addRoleIds: [LOW_ROLE] }, removeSubmitRolesOnClose: false },
          }),
        ],
      }),
    );
    seedSubmitted(h.store);
    const { service } = build(h);

    await service.act(GUILD, 'app-1', remove('req_delete_01'));
    expect(h.store.effectsOf('app-1')).toEqual([]);
  });

  test('the reply says when the Discord card is being removed, and when it waits', async () => {
    const h = harnessParts();
    seedSubmitted(h.store, CARD);
    seedSubmitted(h.store, { id: 'app-2', number: 2, ...CARD });
    seedSubmitted(h.store, { id: 'app-3', number: 3 });
    const { service } = build(h);

    expect((await service.act(GUILD, 'app-1', remove('req_delete_01'))).message).toBe(
      'Deleted application #1 and its answers. Proton is removing its review card from Discord ' +
        'now. Copies someone already downloaded can’t be recalled.',
    );
    expect((await service.act(GUILD, 'app-3', remove('req_delete_03'))).message).toBe(
      'Deleted application #3 and its answers. Copies someone already downloaded can’t be ' +
        'recalled.',
    );

    h.modules.enabled = false;
    const off = await service.act(GUILD, 'app-2', remove('req_delete_02'));
    expect(off.message).toBe(
      'Deleted application #2 and its answers. Applications is off, so its review card is ' +
        'removed from Discord on Proton’s next check rather than straight away. Copies someone ' +
        'already downloaded can’t be recalled.',
    );
    expect(h.store.effectsOf('app-2').map((effect) => effect.kind)).toEqual(['delete_card']);
  });
});
