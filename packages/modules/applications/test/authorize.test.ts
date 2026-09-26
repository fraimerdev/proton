import { describe, expect, test } from 'bun:test';
import { APPLICATION_STATUSES, type ApplicationStatus, Permissions } from '@proton/core';
import {
  authorizeAction,
  CAPABILITIES,
  type Capability,
  capabilitiesFor,
  capabilityFor,
  isAdmin,
  type ReviewActor,
  twoReviewerCheck,
  viewableFormIds,
} from '../src/authorize.ts';
import { applicationsConfigSchema, type FormConfig } from '../src/config.ts';
import { STAFF_ACTIONS, type StaffAction } from '../src/status.ts';

const REVIEWER = '200000000000000001';
const DECIDER = '200000000000000002';
const VIEWER = '200000000000000003';
const OVERRIDE = '200000000000000004';
const EXPORT = '200000000000000005';
const DELETE = '200000000000000006';
const EVENT_TEAM = '200000000000000007';

const APPLICANT = '400000000000000001';
const STAFF = '400000000000000002';
const OTHER = '400000000000000003';

function config(overrides: Record<string, unknown> = {}) {
  return applicationsConfigSchema.parse({
    reviewerRoleIds: [REVIEWER],
    deciderRoleIds: [DECIDER],
    viewerRoleIds: [VIEWER],
    overrideRoleIds: [OVERRIDE],
    exportRoleIds: [EXPORT],
    deleteRoleIds: [DELETE],
    forms: [
      { id: 'mods', name: 'Moderator Application' },
      {
        id: 'events',
        name: 'Event Application',
        review: { useDefaultTeam: false, reviewerRoleIds: [EVENT_TEAM] },
      },
    ],
    ...overrides,
  });
}

const CONFIG = config();

function form(id: string): FormConfig {
  const found = CONFIG.forms.find((entry) => entry.id === id);
  if (found === undefined) throw new Error(`no form ${id}`);
  return found;
}

const MODS = form('mods');
const EVENTS = form('events');

function actor(roleIds: string[], overrides: Partial<ReviewActor> = {}): ReviewActor {
  return { id: STAFF, roleIds, permissions: 0n, owner: false, ...overrides };
}

function caps(
  roleIds: string[],
  target = MODS,
  overrides: Partial<ReviewActor> = {},
): Capability[] {
  return [...capabilitiesFor(CONFIG, target, actor(roleIds, overrides))].sort();
}

const BLOCKED_PHRASES = [
  'forbidden',
  'not signed in',
  'do not administer',
  'lack the required permission',
];

describe('isAdmin', () => {
  test('the owner, Administrator and Manage Server are admins, and nothing else is', () => {
    expect(isAdmin({ owner: true, permissions: 0n })).toBe(true);
    expect(isAdmin({ owner: false, permissions: Permissions.Administrator })).toBe(true);
    expect(isAdmin({ owner: false, permissions: Permissions.ManageGuild })).toBe(true);
    expect(
      isAdmin({
        owner: false,
        permissions: Permissions.ManageRoles | Permissions.BanMembers | Permissions.ManageMessages,
      }),
    ).toBe(false);
  });
});

describe('capabilitiesFor', () => {
  test('an admin has every capability on every form, with no roles at all', () => {
    expect(caps([], MODS, { permissions: Permissions.ManageGuild })).toEqual(
      [...CAPABILITIES].sort(),
    );
    expect(caps([], EVENTS, { owner: true })).toEqual([...CAPABILITIES].sort());
  });

  test('reviewers review, deciders also decide, viewers only read', () => {
    expect(caps([REVIEWER])).toEqual(['review', 'view']);
    expect(caps([DECIDER])).toEqual(['decide', 'review', 'view']);
    expect(caps([VIEWER])).toEqual(['view']);
    expect(caps([])).toEqual([]);
  });

  test('with no decider roles, reviewers decide', () => {
    const open = config({ deciderRoleIds: [] });
    const [mods] = open.forms;
    if (mods === undefined) throw new Error('no form');

    expect([...capabilitiesFor(open, mods, actor([REVIEWER]))].sort()).toEqual([
      'decide',
      'review',
      'view',
    ]);
  });

  test('export needs to read the form as well; override and delete stand alone', () => {
    expect(caps([EXPORT])).toEqual([]);
    expect(caps([EXPORT, VIEWER])).toEqual(['export', 'view']);
    expect(caps([OVERRIDE])).toEqual(['override']);
    expect(caps([DELETE])).toEqual(['delete']);
  });

  test('a form with its own team ignores the server team', () => {
    expect(caps([REVIEWER, DECIDER, VIEWER], EVENTS)).toEqual([]);
    expect(caps([EVENT_TEAM], EVENTS)).toEqual(['decide', 'review', 'view']);
    expect(caps([EVENT_TEAM], MODS)).toEqual([]);
  });

  test('viewableFormIds lists the forms a member can read', () => {
    expect(viewableFormIds(CONFIG, actor([REVIEWER]))).toEqual(['mods']);
    expect(viewableFormIds(CONFIG, actor([EVENT_TEAM]))).toEqual(['events']);
    expect(viewableFormIds(CONFIG, actor([OVERRIDE]))).toEqual([]);
    expect(viewableFormIds(CONFIG, actor([], { owner: true }))).toEqual(['mods', 'events']);
  });
});

function authorize(
  action: StaffAction,
  roleIds: string[],
  application: {
    applicantId?: string;
    status?: ApplicationStatus;
    assigneeId?: string | null;
  } = {},
  overrides: Partial<ReviewActor> = {},
) {
  return authorizeAction({
    config: CONFIG,
    form: MODS,
    actor: actor(roleIds, overrides),
    application: {
      applicantId: application.applicantId ?? APPLICANT,
      status: application.status ?? 'submitted',
      assigneeId: application.assigneeId ?? null,
    },
    action,
  });
}

describe('authorizeAction', () => {
  test('each staff action needs its capability', () => {
    expect(capabilityFor('claim')).toBe('review');
    expect(capabilityFor('note')).toBe('review');
    expect(capabilityFor('open_ticket')).toBe('review');
    expect(capabilityFor('retry_effect')).toBe('review');
    expect(capabilityFor('cancel_effect')).toBe('review');
    expect(capabilityFor('repost_card')).toBe('review');
    expect(capabilityFor('accept')).toBe('decide');
    expect(capabilityFor('reject')).toBe('decide');
    expect(capabilityFor('archive')).toBe('decide');
    expect(capabilityFor('reopen')).toBe('override');
    expect(capabilityFor('delete')).toBe('delete');
  });

  test('a reviewer can claim and note but not decide', () => {
    expect(authorize('claim', [REVIEWER])).toEqual({ ok: true });
    expect(authorize('note', [REVIEWER])).toEqual({ ok: true });
    expect(authorize('accept', [REVIEWER])).toEqual({
      ok: false,
      code: 'not_allowed',
      humanReason: 'Only deciders on the Moderator Application review team can do that.',
    });
  });

  test('someone off the team is told so, whatever they tried', () => {
    for (const action of ['claim', 'accept', 'vote'] as const) {
      expect(authorize(action, [])).toEqual({
        ok: false,
        code: 'not_allowed',
        humanReason: 'You aren’t on the review team for Moderator Application.',
      });
    }
  });

  test('nobody reviews their own application, not even the owner', () => {
    for (const action of ['claim', 'accept', 'reject', 'note', 'vote', 'request_info'] as const) {
      expect(authorize(action, [DECIDER], { applicantId: STAFF })).toEqual({
        ok: false,
        code: 'self',
        humanReason: 'You can’t review your own application.',
      });
      expect(authorize(action, [], { applicantId: STAFF }, { owner: true }).ok).toBe(false);
    }
  });

  test('reopening needs the reopen roles, even for deciders', () => {
    expect(authorize('reopen', [DECIDER], { status: 'accepted' })).toEqual({
      ok: false,
      code: 'not_allowed',
      humanReason:
        'Reopening a decided application needs one of the reopen roles in Applications settings.',
    });
    expect(authorize('reopen', [OVERRIDE], { status: 'accepted' })).toEqual({ ok: true });
    expect(authorize('reopen', [OVERRIDE], { status: 'withdrawn' })).toEqual({
      ok: false,
      code: 'wrong_status',
      humanReason: 'This application was withdrawn.',
    });
  });

  test('deleting needs the delete roles, and privacy deletion of your own is allowed', () => {
    expect(authorize('delete', [DECIDER]).ok).toBe(false);
    expect(authorize('delete', [DELETE])).toEqual({ ok: true });
    expect(authorize('delete', [DELETE], { applicantId: STAFF })).toEqual({ ok: true });
  });

  test('archiving is for deciders, and only once decided', () => {
    expect(authorize('archive', [REVIEWER], { status: 'accepted' }).ok).toBe(false);
    expect(authorize('archive', [DECIDER], { status: 'accepted' })).toEqual({ ok: true });
    expect(authorize('archive', [DECIDER], { status: 'in_review' })).toEqual({
      ok: false,
      code: 'wrong_status',
      humanReason: 'Only decided applications can be archived.',
    });
  });

  test('a stale decision explains what already happened', () => {
    expect(authorize('accept', [DECIDER], { status: 'rejected' })).toEqual({
      ok: false,
      code: 'wrong_status',
      humanReason: 'This application has already been reviewed. It was rejected.',
    });
    expect(authorize('claim', [REVIEWER], { status: 'accepted' })).toEqual({
      ok: false,
      code: 'wrong_status',
      humanReason: 'This application has already been reviewed. It was accepted.',
    });
    expect(authorize('vote', [REVIEWER], { status: 'accepted' })).toEqual({
      ok: false,
      code: 'wrong_status',
      humanReason: 'Voting has closed on this application.',
    });
    expect(authorize('request_info', [REVIEWER], { status: 'needs_info' })).toEqual({
      ok: false,
      code: 'wrong_status',
      humanReason: 'This application is already waiting for more information.',
    });
    expect(authorize('unclaim', [REVIEWER], { status: 'submitted' })).toEqual({
      ok: false,
      code: 'wrong_status',
      humanReason: 'Nobody has claimed this application.',
    });
    expect(authorize('note', [REVIEWER], { status: 'draft' })).toEqual({
      ok: false,
      code: 'wrong_status',
      humanReason: 'This application hasn’t been sent yet.',
    });
  });

  test('no refusal reads like a lost sign-in or carries an em dash', () => {
    const roleSets = [[], [VIEWER], [REVIEWER], [DECIDER], [OVERRIDE], [DELETE]];

    for (const action of STAFF_ACTIONS) {
      for (const status of APPLICATION_STATUSES) {
        for (const roleIds of roleSets) {
          for (const applicantId of [APPLICANT, STAFF]) {
            const result = authorize(action, roleIds, { applicantId, status });
            if (result.ok) continue;

            const reason = result.humanReason.toLowerCase();
            for (const phrase of BLOCKED_PHRASES) expect(reason).not.toContain(phrase);
            expect(result.humanReason).not.toContain('—');
            expect(result.humanReason.endsWith('.')).toBe(true);
          }
        }
      }
    }
  });
});

describe('twoReviewerCheck', () => {
  const pair = config({
    forms: [{ id: 'mods', name: 'Moderator Application', review: { requireTwoReviewers: true } }],
  }).forms[0];
  if (pair === undefined) throw new Error('no form');

  function check(votes: { reviewerId: string; vote: 'accept' | 'reject' }[], decision = 'accept') {
    return twoReviewerCheck({
      form: pair as FormConfig,
      decision: decision as 'accept' | 'reject',
      deciderId: STAFF,
      votes,
      applicantId: APPLICANT,
    });
  }

  test('a form without the rule never asks for a second reviewer', () => {
    expect(
      twoReviewerCheck({
        form: MODS,
        decision: 'accept',
        deciderId: STAFF,
        votes: [],
        applicantId: APPLICANT,
      }),
    ).toEqual({ ok: true });
  });

  test('the decider counts once, and needs one other reviewer voting the same way', () => {
    const refusal = {
      ok: false,
      humanReason:
        'Moderator Application needs two reviewers to agree. Ask another reviewer to vote to accept first.',
    };

    expect(check([])).toEqual(refusal);
    expect(check([{ reviewerId: STAFF, vote: 'accept' }])).toEqual(refusal);
    expect(check([{ reviewerId: OTHER, vote: 'reject' }])).toEqual(refusal);
    expect(check([{ reviewerId: APPLICANT, vote: 'accept' }])).toEqual(refusal);
    expect(check([{ reviewerId: OTHER, vote: 'accept' }])).toEqual({ ok: true });
    expect(check([{ reviewerId: OTHER, vote: 'reject' }], 'reject')).toEqual({ ok: true });
    expect(check([{ reviewerId: OTHER, vote: 'accept' }], 'reject')).toEqual({
      ok: false,
      humanReason:
        'Moderator Application needs two reviewers to agree. Ask another reviewer to vote to reject first.',
    });
  });
});
