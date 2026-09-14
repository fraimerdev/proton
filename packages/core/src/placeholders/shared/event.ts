import type { PlaceholderDefinitionInput } from '../definitions.ts';
import { type ResolvedValue, typeOf, placeholderValue as v } from '../values.ts';

export interface EventFacts {
  id: string;
  occurredAt: number;
}

const EXAMPLE_AT = Date.UTC(2026, 8, 14, 9);

export function eventDefinitions(): PlaceholderDefinitionInput[] {
  const id = v.text('01J8Z3K5N2V7Q4R6T8W0X2Y4Z6');
  const at = v.datetime(EXAMPLE_AT);

  return [
    {
      key: 'event.id',
      label: 'Event ID',
      description: "Proton's id for the event behind this message",
      group: 'Event',
      type: typeOf(id),
      example: id,
    },
    {
      key: 'event.created_at',
      label: 'When it happened',
      description: 'When the event behind this message happened',
      group: 'Event',
      type: typeOf(at),
      example: at,
    },
  ];
}

export function timeDefinitions(): PlaceholderDefinitionInput[] {
  const now = v.datetime(EXAMPLE_AT);
  const today = v.datetime(Date.UTC(2026, 8, 14));
  const year = v.integer(2026);

  return [
    {
      key: 'now',
      label: 'Now',
      description: 'The moment the message is written',
      group: 'Time',
      type: typeOf(now),
      example: now,
    },
    {
      key: 'today',
      label: 'Today',
      description: 'The start of today, in UTC',
      group: 'Time',
      type: typeOf(today),
      example: today,
    },
    {
      key: 'year',
      label: 'Year',
      description: 'The current year, in UTC',
      group: 'Time',
      type: typeOf(year),
      example: year,
    },
  ];
}

export function buildEventValues(event: EventFacts | null): Record<string, ResolvedValue> {
  if (event === null) {
    const reason = 'this message is not written for an event';
    return { 'event.id': v.unavailable(reason), 'event.created_at': v.unavailable(reason) };
  }

  return {
    'event.id': v.text(event.id),
    'event.created_at': Number.isInteger(event.occurredAt)
      ? v.datetime(event.occurredAt)
      : v.failed('the time Proton holds for this event is not a whole number of milliseconds'),
  };
}

export function buildTimeValues(now: number): Record<string, ResolvedValue> {
  if (!Number.isFinite(now)) {
    const failed = v.failed('the clock Proton was given is not a time');
    return { now: failed, today: failed, year: failed };
  }

  const at = Math.floor(now);
  const date = new Date(at);

  return {
    now: v.datetime(at),
    today: v.datetime(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())),
    year: v.integer(date.getUTCFullYear()),
  };
}
