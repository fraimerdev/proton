import { describe, expect, test } from 'bun:test';
import { EVENT_TYPES, isEventType, SERVICE_EMITTED_EVENT_TYPES } from '../../src/events/types.ts';

describe('the event type registry', () => {
  test('names every type once', () => {
    expect(new Set(EVENT_TYPES).size).toBe(EVENT_TYPES.length);
  });

  test('recognises its own members and nothing else', () => {
    expect(EVENT_TYPES.filter((type) => !isEventType(type))).toEqual([]);
    expect(isEventType('message.exploded')).toBe(false);
  });

  test('every service-emitted type is itself a declared event type', () => {
    expect(SERVICE_EMITTED_EVENT_TYPES.filter((type) => !isEventType(type))).toEqual([]);
  });

  test('carries the interaction kinds the gateway can normalise', () => {
    expect(isEventType('interaction.command')).toBe(true);
    expect(isEventType('interaction.component')).toBe(true);
    expect(isEventType('interaction.modal')).toBe(true);
    expect(isEventType('interaction.autocomplete')).toBe(true);
  });

  test('carries both directions of a poll vote', () => {
    expect(isEventType('poll.voted')).toBe(true);
    expect(isEventType('poll.vote_removed')).toBe(true);
  });
});
