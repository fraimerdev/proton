import { MAX_AUTOCOMPLETE_CHOICE_LENGTH, MESSAGE_CONTENT_MAX } from '@proton/core';
import type { Reminder } from './store.ts';

const PENDING_CONTENT_MAX = 120;

const UNITS: ReadonlyArray<readonly [number, string]> = [
  [86_400_000, 'd'],
  [3_600_000, 'h'],
  [60_000, 'm'],
  [1_000, 's'],
];

export function unixSeconds(date: Date): number {
  return Math.floor(date.getTime() / 1000);
}

// Rounded to one unit rather than formatDuration's exact form: the delta between "in 2h" and now
// is never a whole number of hours by the time a keystroke reaches us, and "in 7199s" is useless.
export function relativeLabel(ms: number): string {
  for (const [size, suffix] of UNITS) {
    if (ms >= size) return `in ${Math.round(ms / size)}${suffix}`;
  }

  return 'due now';
}

function collapse(content: string): string {
  return content.replace(/\s+/g, ' ').trim();
}

function clip(content: string, max: number): string {
  return content.length <= max ? content : `${content.slice(0, Math.max(1, max - 1))}…`;
}

export function reminderLabel(reminder: Reminder, now: number): string {
  const prefix = `${relativeLabel(reminder.remindAt.getTime() - now)} — `;

  return prefix + clip(collapse(reminder.content), MAX_AUTOCOMPLETE_CHOICE_LENGTH - prefix.length);
}

export function renderPending(pending: readonly Reminder[], total: number): string {
  if (total === 0) {
    return (
      'You have no reminders waiting in this server. `/remind 2h take the bread out` sets one, ' +
      'and I post it right where you set it.'
    );
  }

  const trimmed = pending.length < total ? `, showing the ${pending.length} soonest` : '';
  const lines = pending.map(
    (reminder) =>
      `• <t:${unixSeconds(reminder.remindAt)}:R> — ${clip(collapse(reminder.content), PENDING_CONTENT_MAX)}`,
  );

  return `**Your reminders** — ${total} waiting${trimmed}\n${lines.join('\n')}`;
}

export function renderDelivery(userId: string, content: string): string {
  return `<@${userId}> you asked me to remind you: ${collapse(content)}`.slice(
    0,
    MESSAGE_CONTENT_MAX,
  );
}
