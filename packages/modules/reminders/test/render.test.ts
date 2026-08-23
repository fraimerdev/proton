import { describe, expect, test } from 'bun:test';
import { MAX_AUTOCOMPLETE_CHOICE_LENGTH, MESSAGE_CONTENT_MAX } from '@proton/core';
import {
  relativeLabel,
  reminderLabel,
  renderDelivery,
  renderPending,
  unixSeconds,
} from '../src/render.ts';
import type { Reminder } from '../src/store.ts';

const NOW = Date.UTC(2026, 0, 1, 12, 0, 0);

function reminder(overrides: Partial<Reminder> = {}): Reminder {
  return {
    id: 'reminder-1',
    guildId: '900000000000000001',
    userId: '100000000000000001',
    channelId: '500000000000000001',
    content: 'take the bread out',
    remindAt: new Date(NOW + 7_200_000),
    createdAt: new Date(NOW),
    deliveredAt: null,
    ...overrides,
  };
}

describe('relativeLabel', () => {
  test('picks one unit and rounds to it', () => {
    expect(relativeLabel(45_000)).toBe('in 45s');
    expect(relativeLabel(5_400_000)).toBe('in 2h');
    expect(relativeLabel(86_400_000 * 3)).toBe('in 3d');
  });

  test('a reminder that is due or overdue does not read as negative time', () => {
    expect(relativeLabel(0)).toBe('due now');
    expect(relativeLabel(-60_000)).toBe('due now');
  });

  test('a few milliseconds of drift does not become a second-count', () => {
    expect(relativeLabel(7_199_995)).toBe('in 2h');
  });
});

describe('reminderLabel', () => {
  test('leads with the relative time and then what it says', () => {
    expect(reminderLabel(reminder(), NOW)).toBe('in 2h — take the bread out');
  });

  test('flattens newlines, which Discord would refuse in a choice name', () => {
    expect(reminderLabel(reminder({ content: 'first\n\nsecond' }), NOW)).toBe(
      'in 2h — first second',
    );
  });

  test('never exceeds the choice-name cap, however long the reminder is', () => {
    const label = reminderLabel(reminder({ content: 'x'.repeat(400) }), NOW);

    expect(label.length).toBe(MAX_AUTOCOMPLETE_CHOICE_LENGTH);
    expect(label.endsWith('…')).toBe(true);
  });
});

describe('renderPending', () => {
  test('says there are none, and how to set one', () => {
    const text = renderPending([], 0);

    expect(text).toContain('no reminders waiting');
    expect(text).toContain('/remind');
  });

  test('gives each one a relative timestamp Discord renders locally', () => {
    const text = renderPending([reminder()], 1);

    expect(text).toContain(`<t:${unixSeconds(new Date(NOW + 7_200_000))}:R>`);
    expect(text).toContain('take the bread out');
    expect(text).toContain('1 waiting');
  });

  test('says the page is a page when there are more than it shows', () => {
    const text = renderPending([reminder(), reminder({ id: 'reminder-2' })], 40);

    expect(text).toContain('40 waiting');
    expect(text).toContain('showing the 2 soonest');
  });

  test('does not say it is a page when it shows everything', () => {
    expect(renderPending([reminder()], 1)).not.toContain('soonest');
  });
});

describe('renderDelivery', () => {
  test('pings the owner and repeats what they asked for', () => {
    expect(renderDelivery('100000000000000001', 'water the plants')).toBe(
      '<@100000000000000001> you asked me to remind you: water the plants',
    );
  });

  test('stays inside the message cap, so an overlong reminder still posts', () => {
    expect(renderDelivery('100000000000000001', 'x'.repeat(4000))).toHaveLength(
      MESSAGE_CONTENT_MAX,
    );
  });
});
