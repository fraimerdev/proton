import { describe, expect, test } from 'bun:test';
import { eventAction, lookupState, when } from '../src/pages/leveling/rows.ts';

describe('lookupState', () => {
  test('an entry whose list could not be read is unreadable, not missing', () => {
    expect(lookupState(false, false, true)).toBe('unreadable');
  });

  test('only a list that loaded without the id reports the entry missing', () => {
    expect(lookupState(false, false, false)).toBe('missing');
  });

  test('a found entry is found, and a list still in flight is loading', () => {
    expect(lookupState(true, false, false)).toBe('found');
    expect(lookupState(false, true, false)).toBe('loading');
  });
});

describe('eventAction', () => {
  const scheduled = {
    multiplier: 2,
    startsAt: '2026-09-14T18:00:00.000Z',
    endsAt: '2026-09-14T20:00:00.000Z',
  };

  test('a scheduled event is cancelled by a button that says so and names the event', () => {
    expect(eventAction(scheduled, false)).toEqual({
      text: 'Cancel event',
      label: `Cancel the ×2 XP event starting ${when(Date.parse(scheduled.startsAt))}`,
    });
  });

  test('a running event is ended by a button that names the event', () => {
    expect(eventAction(scheduled, true)).toEqual({
      text: 'End now',
      label: `End the ×2 XP event ending ${when(Date.parse(scheduled.endsAt))}`,
    });
  });

  test('two events with the same multiplier never share a button name', () => {
    const later = {
      ...scheduled,
      startsAt: '2026-09-15T18:00:00.000Z',
      endsAt: '2026-09-15T20:00:00.000Z',
    };

    expect(eventAction(later, false).label).not.toBe(eventAction(scheduled, false).label);
    expect(eventAction(later, true).label).not.toBe(eventAction(scheduled, true).label);
  });
});
