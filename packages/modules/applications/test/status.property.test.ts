import { describe, expect, test } from 'bun:test';
import {
  APPLICATION_LIFECYCLE_EVENTS,
  APPLICATION_STATUSES,
  type ApplicationStatus,
} from '@proton/core';
import fc from 'fast-check';
import {
  ACTIVE_STATUSES,
  APPLICANT_ACTIONS,
  allowedFrom,
  FINAL_STATUSES,
  isActive,
  isFinal,
  lifecycleEventFor,
  mayTransition,
  nextStatus,
  STAFF_ACTIONS,
  STATUS_LABELS,
  TRANSITION_ACTIONS,
  TRANSITIONS,
  type TransitionAction,
} from '../src/status.ts';

const action = fc.constantFrom(...TRANSITION_ACTIONS);
const status = fc.constantFrom(...APPLICATION_STATUSES);

describe('the status sets', () => {
  test('draft, the active statuses and the final ones split every status exactly once', () => {
    const all = ['draft', ...ACTIVE_STATUSES, ...FINAL_STATUSES].sort();
    expect(all).toEqual([...APPLICATION_STATUSES].sort());

    for (const value of APPLICATION_STATUSES) {
      expect(Number(isActive(value)) + Number(isFinal(value)) + Number(value === 'draft')).toBe(1);
    }
  });

  test('every status has its label', () => {
    expect(STATUS_LABELS).toEqual({
      draft: 'Draft',
      submitted: 'Submitted',
      in_review: 'In review',
      needs_info: 'Needs information',
      waitlisted: 'Waitlisted',
      accepted: 'Accepted',
      rejected: 'Rejected',
      withdrawn: 'Withdrawn',
      expired: 'Expired',
    });
  });

  test('applicant actions are the three the portal and /apply offer', () => {
    expect([...APPLICANT_ACTIONS]).toEqual(['submit', 'withdraw', 'respond']);
    expect(new Set(STAFF_ACTIONS).size).toBe(STAFF_ACTIONS.length);
  });
});

describe('the documented table', () => {
  const cases: [TransitionAction, ApplicationStatus, boolean, ApplicationStatus | null][] = [
    ['submit', 'draft', false, 'submitted'],
    ['submit', 'submitted', false, null],
    ['claim', 'submitted', true, 'in_review'],
    ['claim', 'waitlisted', true, 'in_review'],
    ['claim', 'in_review', true, 'in_review'],
    ['claim', 'needs_info', true, 'needs_info'],
    ['claim', 'accepted', true, null],
    ['assign', 'submitted', true, 'in_review'],
    ['assign', 'in_review', false, 'submitted'],
    ['assign', 'needs_info', false, 'needs_info'],
    ['assign', 'waitlisted', false, 'waitlisted'],
    ['unclaim', 'in_review', false, 'submitted'],
    ['unclaim', 'submitted', false, null],
    ['request_info', 'submitted', false, 'needs_info'],
    ['request_info', 'in_review', true, 'needs_info'],
    ['request_info', 'waitlisted', false, 'needs_info'],
    ['request_info', 'needs_info', true, null],
    ['respond', 'needs_info', true, 'in_review'],
    ['respond', 'needs_info', false, 'submitted'],
    ['respond', 'submitted', false, null],
    ['waitlist', 'submitted', false, 'waitlisted'],
    ['waitlist', 'needs_info', true, 'waitlisted'],
    ['waitlist', 'waitlisted', false, null],
    ['accept', 'submitted', false, 'accepted'],
    ['accept', 'waitlisted', true, 'accepted'],
    ['accept', 'rejected', true, null],
    ['reject', 'needs_info', true, 'rejected'],
    ['reject', 'accepted', true, null],
    ['withdraw', 'in_review', true, 'withdrawn'],
    ['withdraw', 'accepted', false, null],
    ['withdraw', 'draft', false, null],
    ['reopen', 'accepted', true, 'in_review'],
    ['reopen', 'rejected', false, 'submitted'],
    ['reopen', 'withdrawn', false, null],
    ['reopen', 'expired', false, null],
    ['expire_draft', 'draft', false, 'expired'],
    ['expire_info', 'needs_info', true, 'expired'],
    ['expire_info', 'in_review', true, null],
  ];

  for (const [act, from, assigned, to] of cases) {
    test(`${act} from ${from}${assigned ? ' (assigned)' : ''} gives ${to ?? 'nothing'}`, () => {
      expect(nextStatus(act, from, assigned)).toBe(to);
      expect(mayTransition(act, from)).toBe(to !== null);
    });
  }

  test('staff-only actions read their allowed statuses from the right place', () => {
    expect([...allowedFrom('archive')]).toEqual([...FINAL_STATUSES]);
    expect([...allowedFrom('unarchive')]).toEqual([...FINAL_STATUSES]);
    expect([...allowedFrom('vote')]).toEqual([...ACTIVE_STATUSES]);
    expect([...allowedFrom('open_ticket')]).toEqual([...ACTIVE_STATUSES]);
    expect(allowedFrom('note')).not.toContain('draft');
    expect(allowedFrom('retry_effect')).toContain('accepted');
    expect([...allowedFrom('delete')].sort()).toEqual([...APPLICATION_STATUSES].sort());
    expect(allowedFrom('accept')).toEqual(TRANSITIONS.accept.from);
  });
});

describe('transition properties', () => {
  test('nothing ever goes back to draft', () => {
    fc.assert(
      fc.property(action, status, fc.boolean(), (act, from, assigned) => {
        return nextStatus(act, from, assigned) !== 'draft';
      }),
    );
  });

  test('a final status is left only by reopening an accepted or rejected application', () => {
    fc.assert(
      fc.property(
        action,
        fc.constantFrom(...FINAL_STATUSES),
        fc.boolean(),
        (act, from, assigned) => {
          const to = nextStatus(act, from, assigned);
          if (to === null || to === from) return true;
          return act === 'reopen' && (from === 'accepted' || from === 'rejected') && isActive(to);
        },
      ),
    );
  });

  test('withdrawn and expired are dead ends', () => {
    for (const act of TRANSITION_ACTIONS) {
      for (const from of ['withdrawn', 'expired'] as const) {
        expect(nextStatus(act, from, true)).toBeNull();
        expect(nextStatus(act, from, false)).toBeNull();
      }
    }
  });

  test('nextStatus answers exactly when mayTransition allows it', () => {
    fc.assert(
      fc.property(action, status, fc.boolean(), (act, from, assigned) => {
        return (nextStatus(act, from, assigned) !== null) === mayTransition(act, from);
      }),
    );
  });

  test('a random walk from draft stays inside the table', () => {
    fc.assert(
      fc.property(fc.array(fc.tuple(action, fc.boolean()), { maxLength: 40 }), (steps) => {
        let current: ApplicationStatus = 'draft';
        let left = false;

        for (const [act, assigned] of steps) {
          const next = nextStatus(act, current, assigned);
          if (next === null) continue;
          if (current === 'withdrawn' || current === 'expired') return false;
          if (left && next === 'draft') return false;
          if (isFinal(current) && !isActive(next) && next !== current) return false;
          current = next;
          left = true;
        }

        return APPLICATION_STATUSES.includes(current);
      }),
      { numRuns: 1000 },
    );
  });

  test('every applicant or staff transition starts from a real status and lands on one', () => {
    for (const act of TRANSITION_ACTIONS) {
      expect(TRANSITIONS[act].from.length).toBeGreaterThan(0);
      for (const from of TRANSITIONS[act].from) {
        const to = nextStatus(act, from, false);
        expect(to === null ? null : APPLICATION_STATUSES.includes(to)).toBe(true);
      }
    }
  });
});

describe('lifecycle events', () => {
  function producers(): Map<string, Set<TransitionAction>> {
    const found = new Map<string, Set<TransitionAction>>();

    for (const act of TRANSITION_ACTIONS) {
      for (const from of APPLICATION_STATUSES) {
        for (const assigned of [true, false]) {
          const to = nextStatus(act, from, assigned);
          if (to === null) continue;
          const event = lifecycleEventFor(act, from, to);
          if (event === null) continue;
          const set = found.get(event) ?? new Set<TransitionAction>();
          set.add(act);
          found.set(event, set);
        }
      }
    }

    return found;
  }

  test('every lifecycle event comes from exactly one row of the table', () => {
    const found = producers();

    expect([...found.keys()].sort()).toEqual([...APPLICATION_LIFECYCLE_EVENTS].sort());
    for (const [event, actions] of found) {
      const sources: string[] = [...actions].sort();
      if (event === 'applications.review_started') expect(sources).toEqual(['assign', 'claim']);
      else expect(sources).toHaveLength(1);
    }
  });

  test('the event matches the status it lands on', () => {
    const landsOn: Record<string, ApplicationStatus | 'active'> = {
      'applications.submitted': 'submitted',
      'applications.review_started': 'in_review',
      'applications.information_requested': 'needs_info',
      'applications.information_provided': 'active',
      'applications.waitlisted': 'waitlisted',
      'applications.accepted': 'accepted',
      'applications.rejected': 'rejected',
      'applications.withdrawn': 'withdrawn',
      'applications.reopened': 'active',
      'applications.expired': 'expired',
    };

    fc.assert(
      fc.property(action, status, fc.boolean(), (act, from, assigned) => {
        const to = nextStatus(act, from, assigned);
        if (to === null) return true;
        const event = lifecycleEventFor(act, from, to);
        if (event === null) return true;
        const expected = landsOn[event];
        return expected === 'active' ? isActive(to) : expected === to;
      }),
    );
  });

  test('re-claiming, unclaiming and draft expiry announce nothing', () => {
    expect(lifecycleEventFor('claim', 'in_review', 'in_review')).toBeNull();
    expect(lifecycleEventFor('claim', 'needs_info', 'needs_info')).toBeNull();
    expect(lifecycleEventFor('assign', 'in_review', 'submitted')).toBeNull();
    expect(lifecycleEventFor('unclaim', 'in_review', 'submitted')).toBeNull();
    expect(lifecycleEventFor('expire_draft', 'draft', 'expired')).toBeNull();
    expect(lifecycleEventFor('claim', 'submitted', 'in_review')).toBe(
      'applications.review_started',
    );
  });
});
