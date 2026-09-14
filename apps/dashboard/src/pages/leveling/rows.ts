import type { XpEventView } from '@proton/module-leveling/config';

export type LookupState = 'found' | 'loading' | 'unreadable' | 'missing';

export function lookupState(found: boolean, pending: boolean, readFailed: boolean): LookupState {
  if (found) return 'found';
  if (pending) return 'loading';
  return readFailed ? 'unreadable' : 'missing';
}

export function when(ms: number): string {
  return new Date(ms).toLocaleString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

export function eventAction(
  event: Pick<XpEventView, 'multiplier' | 'startsAt' | 'endsAt'>,
  running: boolean,
): { text: string; label: string } {
  return running
    ? {
        text: 'End now',
        label: `End the ×${event.multiplier} XP event ending ${when(Date.parse(event.endsAt))}`,
      }
    : {
        text: 'Cancel event',
        label: `Cancel the ×${event.multiplier} XP event starting ${when(Date.parse(event.startsAt))}`,
      };
}
