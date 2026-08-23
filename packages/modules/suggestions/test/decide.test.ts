import { describe, expect, test } from 'bun:test';
import {
  DECISIONS,
  decide,
  isDecided,
  isDecision,
  isSuggestionStatus,
  SUGGESTION_STATUSES,
  type SuggestionStatus,
  statusFor,
  votingOpen,
} from '../src/decide.ts';

describe('statusFor', () => {
  test('maps each decision onto the status it leaves behind', () => {
    expect(statusFor('accept')).toBe('accepted');
    expect(statusFor('deny')).toBe('denied');
    expect(statusFor('implement')).toBe('implemented');
  });

  test('every decision lands on a real status', () => {
    for (const decision of DECISIONS) {
      expect(SUGGESTION_STATUSES).toContain(statusFor(decision));
    }
  });
});

describe('isDecision and isSuggestionStatus', () => {
  test('accept only the strings the command and the column actually use', () => {
    expect(isDecision('accept')).toBe(true);
    expect(isDecision('accepted')).toBe(false);
    expect(isDecision('drop')).toBe(false);
    expect(isDecision('')).toBe(false);

    expect(isSuggestionStatus('implemented')).toBe(true);
    expect(isSuggestionStatus('implement')).toBe(false);
    expect(isSuggestionStatus('constructor')).toBe(false);
  });
});

describe('isDecided and votingOpen', () => {
  test('open is the only undecided status, and the only one that still takes votes', () => {
    for (const status of SUGGESTION_STATUSES) {
      expect(isDecided(status)).toBe(status !== 'open');
      expect(votingOpen(status)).toBe(status === 'open');
    }
  });
});

describe('decide', () => {
  test('a first decision moves an open suggestion and is not a re-decision', () => {
    expect(decide('open', 'accept')).toEqual({
      outcome: 'decided',
      from: 'open',
      to: 'accepted',
      redecided: false,
    });
  });

  test('staff may change their mind, and the change is flagged as one', () => {
    expect(decide('accepted', 'deny')).toEqual({
      outcome: 'decided',
      from: 'accepted',
      to: 'denied',
      redecided: true,
    });
  });

  test('accepted then implemented is the ordinary path and still counts as a re-decision', () => {
    expect(decide('accepted', 'implement')).toEqual({
      outcome: 'decided',
      from: 'accepted',
      to: 'implemented',
      redecided: true,
    });
  });

  test('deciding a suggestion the way it already stands changes nothing', () => {
    for (const decision of DECISIONS) {
      expect(decide(statusFor(decision), decision)).toEqual({
        outcome: 'unchanged',
        status: statusFor(decision),
      });
    }
  });

  test('every status can be moved to every other one — nothing is a dead end', () => {
    for (const from of SUGGESTION_STATUSES) {
      for (const decision of DECISIONS) {
        const outcome = decide(from, decision);
        const to: SuggestionStatus = statusFor(decision);

        if (from === to) {
          expect(outcome.outcome).toBe('unchanged');
          continue;
        }

        expect(outcome).toEqual({ outcome: 'decided', from, to, redecided: from !== 'open' });
      }
    }
  });

  test('a decision never lands back on open, so a decided suggestion never reopens by accident', () => {
    for (const from of SUGGESTION_STATUSES) {
      for (const decision of DECISIONS) {
        const outcome = decide(from, decision);
        if (outcome.outcome === 'decided') expect(outcome.to).not.toBe('open');
      }
    }
  });
});
