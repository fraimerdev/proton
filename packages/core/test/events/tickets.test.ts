import { describe, expect, test } from 'bun:test';
import {
  TICKET_OPEN_OUTCOMES,
  ticketOpenAnsweredSchema,
  ticketOpenRequestedSchema,
} from '../../src/events/tickets.ts';
import { isEventType, SERVICE_EMITTED_EVENT_TYPES } from '../../src/events/types.ts';

const GUILD = '900000000000000001';

const request = {
  guildId: GUILD,
  requestId: '01J8Z0000000000000000000CC',
  sourceModule: 'applications',
  sourceRef: '01J8Z0000000000000000000AA',
  typeId: 'interview',
  ownerId: '100000000000000001',
  requestedById: '100000000000000002',
} as const;

describe('the open-a-ticket contract', () => {
  test('both halves are declared, and modules rather than a service publish them', () => {
    for (const type of ['tickets.open_requested', 'tickets.open_answered'] as const) {
      expect(isEventType(type)).toBe(true);
      expect(SERVICE_EMITTED_EVENT_TYPES as readonly string[]).not.toContain(type);
    }
  });

  test('a request fills in empty context and participants', () => {
    expect(ticketOpenRequestedSchema.parse(request)).toEqual({
      ...request,
      context: [],
      participantIds: [],
    });
  });

  test('a request survives a JSON round trip', () => {
    const full = {
      ...request,
      subject: 'Interview for Moderator Application #12',
      context: [{ label: 'Reference', value: '#12' }],
      participantIds: ['100000000000000003'],
    };

    expect(ticketOpenRequestedSchema.parse(JSON.parse(JSON.stringify(full)))).toEqual(full);
  });

  test('a request carries at most five context lines, each within Discord’s field limits', () => {
    const line = { label: 'Reference', value: '#12' };

    expect(
      ticketOpenRequestedSchema.safeParse({ ...request, context: Array(6).fill(line) }).success,
    ).toBe(false);
    expect(
      ticketOpenRequestedSchema.safeParse({
        ...request,
        context: [{ label: 'x'.repeat(46), value: '#12' }],
      }).success,
    ).toBe(false);
  });

  test('a request refuses a non-snowflake owner', () => {
    expect(ticketOpenRequestedSchema.safeParse({ ...request, ownerId: 'nobody' }).success).toBe(
      false,
    );
  });

  test.each([...TICKET_OPEN_OUTCOMES])('an answer can report %s', (status) => {
    expect(
      ticketOpenAnsweredSchema.safeParse({
        guildId: GUILD,
        requestId: request.requestId,
        sourceModule: 'applications',
        sourceRef: request.sourceRef,
        status,
      }).success,
    ).toBe(true);
  });

  test('an answer names the ticket it opened', () => {
    const answer = {
      guildId: GUILD,
      requestId: request.requestId,
      sourceModule: 'applications',
      sourceRef: request.sourceRef,
      status: 'opened',
      ticketId: '01J8Z0000000000000000000DD',
      number: 7,
      channelId: '500000000000000001',
    } as const;

    expect(ticketOpenAnsweredSchema.parse(JSON.parse(JSON.stringify(answer)))).toEqual(answer);
  });

  test('an answer refuses an outcome the requester cannot act on', () => {
    expect(
      ticketOpenAnsweredSchema.safeParse({
        guildId: GUILD,
        requestId: request.requestId,
        sourceModule: 'applications',
        sourceRef: request.sourceRef,
        status: 'maybe',
      }).success,
    ).toBe(false);
  });
});
