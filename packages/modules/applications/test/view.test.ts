import { describe, expect, test } from 'bun:test';
import { APPLICATION_STATUSES } from '@proton/core';
import { STAFF_ACTIONS } from '../src/status.ts';
import {
  draftSaveBodySchema,
  draftSaveResultSchema,
  EFFECT_KINDS,
  EFFECT_LABELS,
  EFFECT_PROBLEM_LABELS,
  eligibilityPreviewSchema,
  exportQuerySchema,
  formOverviewSchema,
  myApplicationsSchema,
  portalApplicationSchema,
  portalFormSchema,
  portalRespondBodySchema,
  portalSubmitBodySchema,
  portalSubmitResultSchema,
  publishBodySchema,
  queueItemSchema,
  queueQuerySchema,
  staffActionSchema,
} from '../src/view.ts';
import {
  APPLICANT_THREAD_KINDS,
  applicantThread,
  canRespond,
  canWithdraw,
  portalStatus,
  referenceOf,
  statusSentence,
} from '../src/web.ts';

const ACTOR = '400000000000000002';
const USER = '400000000000000001';
const REQUEST = 'req_12345678';

const STAMP = { actorId: ACTOR, source: 'dashboard' as const, requestId: REQUEST };

describe('queueQuerySchema', () => {
  test('an empty query is the awaiting queue, newest first, 25 a page', () => {
    expect(queueQuerySchema.parse({})).toEqual({
      view: 'awaiting',
      page: 1,
      pageSize: 25,
      sort: 'submitted',
      dir: 'desc',
    });
  });

  test('search params arrive as strings and blanks mean unset', () => {
    expect(
      queueQuerySchema.parse({
        view: 'needs_info',
        formId: '',
        assignee: '',
        q: '',
        page: '3',
        pageSize: '50',
      }),
    ).toEqual({
      view: 'needs_info',
      page: 3,
      pageSize: 50,
      sort: 'submitted',
      dir: 'desc',
    });
  });

  test('assignee is me, none or a member ID', () => {
    for (const assignee of ['me', 'none', USER]) {
      expect(queueQuerySchema.parse({ assignee }).assignee).toBe(assignee);
    }
    expect(queueQuerySchema.safeParse({ assignee: 'someone' }).success).toBe(false);
  });

  test('pages and forms are bounded', () => {
    expect(queueQuerySchema.safeParse({ pageSize: '51' }).success).toBe(false);
    expect(queueQuerySchema.safeParse({ page: '0' }).success).toBe(false);
    expect(queueQuerySchema.safeParse({ formId: 'Not A Form' }).success).toBe(false);
    expect(queueQuerySchema.safeParse({ q: 'x'.repeat(101) }).success).toBe(false);
    expect(queueQuerySchema.parse({ q: '  ada  ' }).q).toBe('ada');
  });
});

describe('publishBodySchema', () => {
  test('keeps drafts on their version unless told to restart them', () => {
    expect(publishBodySchema.parse({ ...STAMP }).draftPolicy).toBe('keep');
    expect(publishBodySchema.parse({ ...STAMP, draftPolicy: 'restart' }).draftPolicy).toBe(
      'restart',
    );
  });

  test('needs a request id and a dashboard audit stamp', () => {
    expect(publishBodySchema.safeParse({ ...STAMP, requestId: 'short' }).success).toBe(false);
    expect(publishBodySchema.safeParse({ ...STAMP, source: 'command' }).success).toBe(false);
    expect(publishBodySchema.safeParse({ ...STAMP, actorId: 'me' }).success).toBe(false);
  });
});

describe('staffActionSchema', () => {
  const minimal: Record<(typeof STAFF_ACTIONS)[number], Record<string, unknown>> = {
    claim: {},
    unclaim: {},
    assign: { assigneeId: null },
    request_info: { message: 'Could you share a link?' },
    waitlist: {},
    accept: {},
    reject: { reason: 'Not this round.' },
    reopen: { reason: 'Decided too early.' },
    archive: {},
    unarchive: {},
    note: { body: 'Strong answers.' },
    vote: { vote: 'accept' },
    open_ticket: {},
    retry_effect: { effectId: '01JEFFECT' },
    cancel_effect: { effectId: '01JEFFECT' },
    repost_card: {},
    delete: { confirm: true },
  };

  test('every staff action has a body shape', () => {
    for (const action of STAFF_ACTIONS) {
      const parsed = staffActionSchema.safeParse({ action, ...minimal[action], ...STAMP });
      expect([action, parsed.success]).toEqual([action, true]);
    }
  });

  test('the parameters that matter are required and bounded', () => {
    const bad = [
      { action: 'reopen' },
      { action: 'reopen', reason: '   ' },
      { action: 'note', body: '' },
      { action: 'note', body: 'x'.repeat(2001) },
      { action: 'request_info', message: 'x'.repeat(2001) },
      { action: 'accept', reason: 'x'.repeat(1001) },
      { action: 'vote', vote: 'maybe' },
      { action: 'vote', vote: 'accept', score: 6 },
      { action: 'delete' },
      { action: 'delete', confirm: false },
      { action: 'retry_effect' },
      { action: 'assign', assigneeId: 'someone' },
      { action: 'teleport' },
    ];

    for (const body of bad) {
      expect([body, staffActionSchema.safeParse({ ...body, ...STAMP }).success]).toEqual([
        body,
        false,
      ]);
    }
  });

  test('text is trimmed before it is stored', () => {
    const parsed = staffActionSchema.parse({ action: 'note', body: '  Good fit.  ', ...STAMP });
    expect(parsed.action === 'note' ? parsed.body : null).toBe('Good fit.');
  });
});

describe('the applicant never sees staff data', () => {
  const application = {
    id: '01JAPP',
    number: 12,
    guildId: '900000000000000001',
    formId: 'mods',
    formName: 'Moderator Application',
    status: 'in_review',
    statusLabel: 'In review',
    submittedAt: 1,
    decidedAt: null,
    decisionReason: null,
    answers: null,
    thread: [],
    canWithdraw: true,
    canRespond: false,
    confirmation: 'Thanks.',
  };

  test('notes, votes, effects, reviewers and history are stripped from the portal view', () => {
    const parsed = portalApplicationSchema.parse({
      ...application,
      notes: [{ body: 'secret' }],
      votes: [{ reviewerId: ACTOR, vote: 'reject' }],
      effects: [{ kind: 'dm' }],
      assigneeId: ACTOR,
      decidedBy: ACTOR,
      history: [{ kind: 'claimed' }],
    });

    expect(Object.keys(parsed).sort()).toEqual(Object.keys(application).sort());
    expect(JSON.stringify(parsed)).not.toContain(ACTOR);
  });

  test('the portal thread only carries the applicant-visible kinds', () => {
    expect(
      portalApplicationSchema.safeParse({
        ...application,
        thread: [{ id: 't', kind: 'reopened', authorId: ACTOR, body: 'x', createdAt: 1 }],
      }).success,
    ).toBe(false);

    expect(
      applicantThread([
        { kind: 'info_request', id: '1' },
        { kind: 'info_response', id: '2' },
        { kind: 'reopened', id: '3' },
        { kind: 'decision', id: '4' },
      ]).map((entry) => entry.id),
    ).toEqual(['1', '2', '4']);
    expect([...APPLICANT_THREAD_KINDS]).toEqual(['info_request', 'info_response', 'decision']);
  });

  test('the portal form never carries the live review settings', () => {
    const shape = Object.keys(portalFormSchema.shape.form.shape).sort();
    for (const key of ['review', 'actions', 'intake', 'messages', 'notify', 'interview']) {
      expect(shape).not.toContain(key);
    }
  });
});

describe('portal bodies and results', () => {
  test('submissions carry the revision they were checked against', () => {
    expect(
      portalSubmitBodySchema.safeParse({ userId: USER, expectedRevision: 3, requestId: REQUEST })
        .success,
    ).toBe(true);
    expect(
      portalSubmitBodySchema.safeParse({ userId: USER, expectedRevision: -1, requestId: REQUEST })
        .success,
    ).toBe(false);
  });

  test('results are tagged so the page can tell a conflict from a refusal', () => {
    expect(portalSubmitResultSchema.parse({ status: 'conflict', revision: 4 })).toEqual({
      status: 'conflict',
      revision: 4,
    });
    expect(
      portalSubmitResultSchema.parse({
        status: 'invalid',
        problems: [{ questionId: 'why', label: 'Why', message: '“Why” needs an answer.' }],
      }).status,
    ).toBe('invalid');
    expect(
      draftSaveResultSchema.parse({
        status: 'conflict',
        draft: { revision: 2, answers: { why: 'Because' }, updatedAt: 5 },
      }).status,
    ).toBe('conflict');
    expect(draftSaveResultSchema.safeParse({ status: 'saved', revision: 1 }).success).toBe(false);
  });

  test('a follow-up answer is bounded', () => {
    const body = { userId: USER, requestId: REQUEST };
    expect(portalRespondBodySchema.safeParse({ ...body, message: 'x'.repeat(4000) }).success).toBe(
      true,
    );
    expect(portalRespondBodySchema.safeParse({ ...body, message: 'x'.repeat(4001) }).success).toBe(
      false,
    );
    expect(portalRespondBodySchema.safeParse({ ...body, message: '  ' }).success).toBe(false);
  });

  test('my applications list every status', () => {
    const items = APPLICATION_STATUSES.map((status, index) => ({
      id: `app-${index}`,
      number: index + 1,
      guildId: '900000000000000001',
      formId: 'mods',
      formName: 'Moderator Application',
      status,
      statusLabel: status,
      submittedAt: null,
      updatedAt: index,
    }));
    expect(myApplicationsSchema.parse({ items }).items).toHaveLength(APPLICATION_STATUSES.length);
  });

  test('an eligibility preview can say the member could not be read', () => {
    expect(eligibilityPreviewSchema.parse({ member: 'unavailable', eligibility: null })).toEqual({
      member: 'unavailable',
      eligibility: null,
    });
  });

  test('an eligibility preview says which requirements it checked', () => {
    const preview = { member: 'unavailable', eligibility: null };
    expect(eligibilityPreviewSchema.parse({ ...preview, checked: 'published' }).checked).toBe(
      'published',
    );
    expect(eligibilityPreviewSchema.parse({ ...preview, checked: 'saved' }).checked).toBe('saved');
    expect(eligibilityPreviewSchema.safeParse({ ...preview, checked: 'draft' }).success).toBe(
      false,
    );
  });

  test('a draft save can name the version the page is showing', () => {
    const body = { userId: USER, answers: {}, expectedRevision: null, requestId: REQUEST };
    expect(draftSaveBodySchema.parse(body).versionId).toBeUndefined();
    expect(draftSaveBodySchema.parse({ ...body, versionId: 'version-1' }).versionId).toBe(
      'version-1',
    );
    expect(draftSaveBodySchema.safeParse({ ...body, versionId: '' }).success).toBe(false);
    expect(draftSaveBodySchema.safeParse({ ...body, versionId: 'v'.repeat(65) }).success).toBe(
      false,
    );
  });
});

describe('formOverviewSchema', () => {
  test('lists the ids of forms that were published and then removed', () => {
    expect(formOverviewSchema.parse({ forms: [] })).toEqual({ forms: [], retiredFormIds: [] });
    expect(
      formOverviewSchema.parse({ forms: [], retiredFormIds: ['old-mods'] }).retiredFormIds,
    ).toEqual(['old-mods']);
  });
});

describe('exportQuerySchema', () => {
  test('defaults to a CSV of everything and reads dates from the query string', () => {
    expect(exportQuerySchema.parse({})).toEqual({ format: 'csv', view: 'all' });
    const query = { format: 'json', from: '10', to: '', formId: 'mods' };
    expect(exportQuerySchema.parse(query)).toEqual({
      format: 'json',
      view: 'all',
      from: 10,
      formId: 'mods',
    });
    expect(exportQuerySchema.safeParse({ format: 'xlsx' }).success).toBe(false);
  });
});

describe('effect labels', () => {
  test('every effect kind has a name and a problem label', () => {
    expect(Object.keys(EFFECT_LABELS).sort()).toEqual([...EFFECT_KINDS].sort());
    expect(Object.keys(EFFECT_PROBLEM_LABELS).sort()).toEqual([...EFFECT_KINDS].sort());
    expect(EFFECT_PROBLEM_LABELS.add_role).toBe('Role update failed');
    expect(EFFECT_PROBLEM_LABELS.dm).toBe('DM not delivered');
    expect(EFFECT_PROBLEM_LABELS.ticket).toBe('Ticket not opened');
    expect(EFFECT_PROBLEM_LABELS.card).toBe('Card not posted');
    expect(JSON.stringify([EFFECT_LABELS, EFFECT_PROBLEM_LABELS])).not.toContain('—');
  });

  test('a queue item carries its problems so the queue can say "Accepted · role update failed"', () => {
    const item = queueItemSchema.parse({
      id: '01JAPP',
      number: 12,
      formId: 'mods',
      formName: 'Moderator Application',
      applicantId: USER,
      applicantName: null,
      status: 'accepted',
      assigneeId: null,
      submittedAt: 1,
      updatedAt: 2,
      archived: false,
      problems: [{ effectId: '01JEFFECT', kind: 'add_role', label: 'Role update failed' }],
      votes: { accept: 2, reject: 0 },
    });
    expect(item.problems[0]?.label).toBe('Role update failed');
  });
});

describe('portal status helpers', () => {
  test('pending applications can be withdrawn; only information requests take an answer', () => {
    expect(APPLICATION_STATUSES.filter(canWithdraw)).toEqual([
      'submitted',
      'in_review',
      'needs_info',
      'waitlisted',
    ]);
    expect(APPLICATION_STATUSES.filter(canRespond)).toEqual(['needs_info']);
  });

  test('status sentences use the owner’s copy and no em dashes', () => {
    expect(statusSentence('submitted')).toBe('Your application has been sent.');
    expect(statusSentence('needs_info')).toBe('We need a little more information.');
    for (const status of APPLICATION_STATUSES) {
      expect(statusSentence(status)).not.toContain('—');
    }
  });

  test('portalStatus bundles the label, sentence and what the applicant may do', () => {
    expect(portalStatus({ status: 'needs_info' })).toEqual({
      status: 'needs_info',
      label: 'Needs information',
      sentence: 'We need a little more information.',
      canWithdraw: true,
      canRespond: true,
    });
    expect(portalStatus({ status: 'accepted' }).canWithdraw).toBe(false);
  });

  test('a reference is the number with a hash, and nothing before submission', () => {
    expect(referenceOf(12)).toBe('#12');
    expect(referenceOf(null)).toBe('');
  });
});
