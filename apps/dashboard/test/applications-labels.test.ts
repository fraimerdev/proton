import { describe, expect, test } from 'bun:test';
import type { ApplicationDetail, EffectView } from '@proton/module-applications/view';
import * as labels from '../src/pages/applications/labels.ts';

const {
  accessRefusal,
  actionsFor,
  answerGroups,
  applicationsReadFailure,
  averageScore,
  canCancel,
  canRetry,
  detailMemberIds,
  downgradeNotice,
  effectLabel,
  effectRoleId,
  effectTrigger,
  exportedLine,
  exportScope,
  filenameOf,
  historyLabel,
  historyTone,
  isLink,
  isWorking,
  problemSummary,
  queueRequest,
  shownEffects,
  statusChange,
  viewOf,
  viewTabs,
  voteLine,
} = labels;

const APPLICANT = '400000000000000001';
const REVIEWER = '400000000000000002';
const ROLE = '600000000000000001';

function effect(overrides: Partial<EffectView>): EffectView {
  return {
    id: 'effect-1',
    key: 'card',
    kind: 'card',
    status: 'succeeded',
    attempts: 1,
    error: null,
    errorCode: null,
    updatedAt: 0,
    label: 'Review card',
    ...overrides,
  };
}

function detail(overrides: {
  application?: Partial<ApplicationDetail['application']>;
  capabilities?: ApplicationDetail['capabilities'];
  twoReviewers?: boolean;
  scoring?: boolean;
}): ApplicationDetail {
  return {
    application: {
      id: 'app-1',
      number: 12,
      formId: 'moderator',
      formName: 'Moderator Application',
      applicantId: APPLICANT,
      applicantName: 'Riley',
      status: 'submitted',
      assigneeId: null,
      submittedAt: 1,
      updatedAt: 1,
      archived: false,
      problems: [],
      votes: { accept: 0, reject: 0 },
      versionId: 'v1',
      version: 1,
      decidedAt: null,
      decidedBy: null,
      decisionReason: null,
      reopenedCount: 0,
      archivedAt: null,
      contentPurgedAt: null,
      deletedAt: null,
      interview: null,
      cardUrl: null,
      ...overrides.application,
    },
    answers: [],
    sections: [],
    thread: [],
    notes: [],
    votes: [],
    history: [],
    effects: [],
    capabilities: overrides.capabilities ?? [
      'view',
      'review',
      'decide',
      'override',
      'export',
      'delete',
    ],
    moderation: null,
    twoReviewers: overrides.twoReviewers ?? false,
    scoring: overrides.scoring ?? false,
  };
}

describe('the queue’s status views', () => {
  test('an unknown view falls back to awaiting review', () => {
    expect(viewOf(undefined)).toBe('awaiting');
    expect(viewOf('nonsense')).toBe('awaiting');
    expect(viewOf('needs_info')).toBe('needs_info');
  });

  test('tabs carry the cheap counts, and only when there is something to count', () => {
    const tabs = viewTabs({
      awaiting: 3,
      unassigned: 1,
      needsInfo: 0,
      waitlisted: 2,
      problems: 5,
      oldestAwaitingAt: null,
    });

    expect(tabs.map((tab) => tab.label)).toEqual([
      'Awaiting review (3)',
      'Needs information',
      'Waitlisted (2)',
      'Accepted',
      'Rejected',
      'Withdrawn',
      'Expired',
      'All',
      'Archived',
    ]);
    expect(viewTabs(undefined)[0]?.label).toBe('Awaiting review');
  });
});

describe('the queue request', () => {
  test('defaults to the first page of applications awaiting review, newest first', () => {
    expect(queueRequest({}, {})).toEqual({
      view: 'awaiting',
      formId: undefined,
      assignee: undefined,
      q: undefined,
      page: 1,
      pageSize: 25,
      sort: 'submitted',
      dir: 'desc',
    });
  });

  test('clamps what a hand-edited link can ask for', () => {
    const request = queueRequest(
      { view: 'all', q: `  ${'x'.repeat(140)}  `, page: -4 },
      { pageSize: 1000, assignee: 'me', formId: 'team' },
    );

    expect(request.view).toBe('all');
    expect(request.q).toHaveLength(100);
    expect(request.page).toBe(1);
    expect(request.pageSize).toBe(25);
    expect(request.assignee).toBe('me');
    expect(request.formId).toBe('team');
  });

  test('a blank search sends no search at all', () => {
    expect(queueRequest({ q: '   ' }, {}).q).toBeUndefined();
    expect(queueRequest({ q: ' #12 ' }, {}).q).toBe('#12');
  });
});

describe('problems and votes', () => {
  test('the problem summary names the status and each distinct failure once', () => {
    expect(
      problemSummary('accepted', [
        { label: 'Role update failed' },
        { label: 'Role update failed' },
        { label: 'DM not delivered' },
      ]),
    ).toBe('Accepted · role update failed, DM not delivered');
    expect(problemSummary('accepted', [])).toBeNull();
  });

  test('votes read as a tally, or not at all', () => {
    expect(voteLine({ accept: 2, reject: 1 })).toBe('2 accept · 1 reject');
    expect(voteLine({ accept: 0, reject: 0 })).toBeNull();
    expect(averageScore([{ score: 4 }, { score: 5 }, { score: null }])).toBe(4.5);
    expect(averageScore([{ score: null }])).toBeNull();
  });
});

describe('effects', () => {
  test('work in progress is anything waiting, running or asked of another module', () => {
    expect(isWorking([effect({ status: 'succeeded' }), effect({ status: 'failed' })])).toBe(false);
    expect(isWorking([effect({ status: 'requested' })])).toBe(true);
    expect(isWorking([effect({ status: 'pending' })])).toBe(true);
  });

  test('only a failed action can be retried, and a finished one can’t be cancelled', () => {
    expect(canRetry(effect({ status: 'failed' }))).toBe(true);
    expect(canRetry(effect({ status: 'pending' }))).toBe(false);
    expect(canCancel(effect({ status: 'pending' }))).toBe(true);
    expect(canCancel(effect({ status: 'requested' }))).toBe(true);
    expect(canCancel(effect({ status: 'succeeded' }))).toBe(false);
    expect(canCancel(effect({ status: 'cancelled' }))).toBe(false);
  });

  test('triggers and roles are read from the effect key', () => {
    expect(effectTrigger('accepted:3:add_role:600000000000000001')).toBe('When it was accepted');
    expect(effectTrigger('event:submitted:1')).toBe('When it was submitted');
    expect(effectTrigger('card')).toBeNull();
    expect(effectRoleId(effect({ key: `accepted:3:add_role:${ROLE}`, kind: 'add_role' }))).toBe(
      ROLE,
    );
    expect(effectRoleId(effect({ key: 'accepted:3:dm', kind: 'dm' }))).toBeNull();
    expect(effectLabel(effect({ key: 'rejected:2:cleanup', kind: 'remove_role' }))).toBe(
      'Remove roles given on submission',
    );
  });

  test('updates for other modules stay out of sight unless they failed', () => {
    const shown = shownEffects([
      effect({ id: 'a', kind: 'event' }),
      effect({ id: 'b', kind: 'event', status: 'failed' }),
      effect({ id: 'c', kind: 'dm' }),
    ]);

    expect(shown.map((entry) => entry.id)).toEqual(['b', 'c']);
  });

  test('a card without answers explains why', () => {
    expect(downgradeNotice(effect({ errorCode: 'channel_not_private' }))).toBe(
      'The review card shows no answers, because members outside the review team can read its ' +
        'channel.',
    );
    expect(downgradeNotice(effect({ errorCode: 'audience_unknown' }))).toContain('couldn’t check');
    expect(downgradeNotice(effect({ errorCode: 'audience_unknown' }))).not.toContain('summary');
    expect(downgradeNotice(effect({ kind: 'dm', errorCode: 'channel_not_private' }))).toBeNull();
  });
});

describe('history and answers', () => {
  test('known events read as sentences, unknown ones as words', () => {
    expect(historyLabel('override_two_reviewers')).toBe('Decided without a second reviewer');
    expect(historyLabel('reminded')).toBe('Review reminder posted');
    expect(historyLabel('review_overdue')).toBe('Review overdue');
    expect(historyTone('review_overdue')).toBe('warning');
    expect(historyLabel('something_new')).toBe('Something new');
    expect(statusChange('submitted', 'in_review')).toBe('Submitted → In review');
    expect(statusChange('accepted', 'accepted')).toBeNull();
    expect(statusChange(null, 'accepted')).toBeNull();
  });

  test('answers group under their sections in form order, with strays last', () => {
    const answer = (questionId: string, sectionId: string) => ({
      questionId,
      sectionId,
      label: questionId,
      type: 'short' as const,
      value: 'x',
      display: 'x',
    });

    const groups = answerGroups(
      [answer('b1', 'second'), answer('a1', 'first'), answer('z1', 'gone'), answer('a2', 'first')],
      [
        { id: 'first', title: 'About you' },
        { id: 'second', title: 'Experience' },
        { id: 'empty', title: 'Unused' },
      ],
    );

    expect(groups.map((group) => [group.title, group.answers.map((a) => a.questionId)])).toEqual([
      ['About you', ['a1', 'a2']],
      ['Experience', ['b1']],
      ['', ['z1']],
    ]);
  });

  test('only a web link answer becomes a link', () => {
    expect(isLink({ type: 'url', display: 'https://example.com/work' })).toBe(true);
    expect(isLink({ type: 'url', display: 'javascript:alert(1)' })).toBe(false);
    expect(isLink({ type: 'short', display: 'https://example.com' })).toBe(false);
  });

  test('member ids come from everyone the page shows, without repeats', () => {
    const shown = detail({ application: { assigneeId: REVIEWER } });
    shown.history.push({
      id: 'e1',
      kind: 'claimed',
      actorId: REVIEWER,
      source: 'dashboard',
      fromStatus: 'submitted',
      toStatus: 'in_review',
      createdAt: 1,
    });
    shown.history.push({
      id: 'e2',
      kind: 'reminded',
      actorId: 'proton:applications',
      source: 'system',
      fromStatus: null,
      toStatus: null,
      createdAt: 2,
    });

    expect(detailMemberIds(shown)).toEqual([APPLICANT, REVIEWER]);
  });
});

describe('what the detail page offers', () => {
  test('a decider sees the decision, the claim and the rest of the review', () => {
    const can = actionsFor(detail({}), true);

    expect(can).toMatchObject({
      claim: true,
      unclaim: false,
      decide: true,
      requestInfo: true,
      waitlist: true,
      reopen: false,
      archive: false,
      remove: true,
      exportForm: true,
      vote: false,
    });
  });

  test('a reviewer who can’t decide gets no Accept or Reject', () => {
    const can = actionsFor(detail({ capabilities: ['view', 'review'] }), true);

    expect(can.decide).toBe(false);
    expect(can.claim).toBe(true);
    expect(can.remove).toBe(false);
  });

  test('a viewer can only read', () => {
    const can = actionsFor(detail({ capabilities: ['view'] }), true);

    expect(Object.values(can).every((allowed) => !allowed)).toBe(true);
  });

  test('voting appears only when the form scores or needs two reviewers', () => {
    expect(actionsFor(detail({ scoring: true }), true).vote).toBe(true);
    expect(actionsFor(detail({ twoReviewers: true }), true).vote).toBe(true);
  });

  test('a decided application can be reopened with the override role, until it’s purged', () => {
    const decided = detail({ application: { status: 'accepted', decidedAt: 5 } });
    expect(actionsFor(decided, true)).toMatchObject({ reopen: true, archive: true, decide: false });

    const purged = detail({ application: { status: 'accepted', contentPurgedAt: 9 } });
    expect(actionsFor(purged, true).reopen).toBe(false);

    const noOverride = detail({
      application: { status: 'rejected' },
      capabilities: ['view', 'review', 'decide'],
    });
    expect(actionsFor(noOverride, true).reopen).toBe(false);
  });

  test('with Applications off only reading, exporting and deleting remain', () => {
    const can = actionsFor(detail({}), false);

    expect(can.decide).toBe(false);
    expect(can.claim).toBe(false);
    expect(can.remove).toBe(true);
    expect(can.exportForm).toBe(true);
  });

  test('a deleted application offers nothing', () => {
    const can = actionsFor(detail({ application: { deletedAt: 3 } }), true);

    expect(Object.values(can).every((allowed) => !allowed)).toBe(true);
  });
});

describe('failures', () => {
  test('a refusal from the review team check is shown as it was written', () => {
    expect(
      accessRefusal(new Error('You aren’t on the review team for Moderator Application.')),
    ).toBe('You aren’t on the review team for Moderator Application.');
    expect(accessRefusal(new Error('forbidden: you are not a member of that server'))).toBe(
      'You’re no longer a member of this server.',
    );
    expect(accessRefusal(new Error('Proton didn’t respond.'))).toBeNull();
  });

  test('the api’s own sentences survive a failed read', () => {
    expect(
      applicationsReadFailure(
        new Error('Proton can’t find that application in this server.'),
        'this application',
      ),
    ).toBe('Couldn’t load this application. Proton can’t find that application in this server.');
    expect(applicationsReadFailure(new Error('fetch failed'), 'the applications')).toBe(
      'Couldn’t load the applications. Proton didn’t respond. Try again in a moment.',
    );
  });
});

describe('downloads', () => {
  test('the file name comes from the api and can’t name a path', () => {
    expect(filenameOf('attachment; filename="applications-12.csv"', 'x.csv')).toBe(
      'applications-12.csv',
    );
    expect(filenameOf('attachment; filename="../../evil.csv"', 'x.csv')).toBe('..-..-evil.csv');
    expect(filenameOf(null, 'applications.json')).toBe('applications.json');
  });

  test('the export only promises answers the file will hold', () => {
    const allCsv = exportScope({ view: 'all' }, 'csv');
    expect(allCsv).toContain('All applications from every form you can export.');
    expect(allCsv).toContain('A CSV of several forms has no answer columns');
    expect(allCsv).toContain('pick one form, or choose JSON, to include answers');
    expect(allCsv).not.toContain('with their answers');

    expect(exportScope({ view: 'all' }, 'json')).toBe(
      'All applications from every form you can export, with their answers. Up to 5,000 at a time.',
    );
    expect(
      exportScope({ view: 'accepted', formId: 'mods', formName: 'Moderator Application' }, 'csv'),
    ).toBe(
      'Accepted applications from Moderator Application, with their answers. Up to 5,000 at a time.',
    );
  });

  test('a cut-short export says so', () => {
    expect(exportedLine(5000, true)).toBe(
      'Downloaded the first 5,000 applications. Narrow the filters to get the rest.',
    );
    expect(exportedLine(1, false)).toBe('Downloaded 1 application.');
  });
});

describe('the copy', () => {
  test('never uses an em dash', () => {
    const strings = Object.values(labels).flatMap((value) =>
      typeof value === 'object' && value !== null && !Array.isArray(value)
        ? Object.values(value).flatMap((entry) =>
            typeof entry === 'string'
              ? [entry]
              : typeof entry === 'object' && entry !== null
                ? Object.values(entry).filter((inner) => typeof inner === 'string')
                : [],
          )
        : [],
    );

    expect(strings.length).toBeGreaterThan(40);
    expect(strings.filter((text) => text.includes('—'))).toEqual([]);
  });
});
