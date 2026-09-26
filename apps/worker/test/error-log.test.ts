import { describe, expect, test } from 'bun:test';
import type { ProtonEvent } from '@proton/core';
import { loggableError, logHandlerError } from '../src/error-log.ts';
import { queryError } from './query-error.ts';

const EVENT: ProtonEvent = {
  id: 'interaction.modal:1',
  type: 'interaction.modal',
  guildId: '900000000000000001',
  occurredAt: 1_770_000_000_000,
  payload: {},
};

function capture() {
  const lines: Array<{ message: string; meta: Record<string, unknown> }> = [];
  return { lines, log: logHandlerError((message, meta) => lines.push({ message, meta })) };
}

describe('logging a handler that threw', () => {
  test('a failed query is named by its code, never by its query or bound values', () => {
    const { lines, log } = capture();

    log(EVENT, queryError(['SECRET reporter comment', '{"content":"member message"}']), 'g');

    expect(lines).toHaveLength(1);
    expect(lines[0]?.message).toBe(
      'g failed to handle interaction.modal, so it will be redelivered: database query failed (08006)',
    );
    expect(lines[0]?.meta).toEqual({
      group: 'g',
      eventId: EVENT.id,
      guildId: EVENT.guildId,
    });
    expect(JSON.stringify(lines)).not.toContain('SECRET');
    expect(JSON.stringify(lines)).not.toContain('member message');
  });

  test('any other error keeps its message and stack', () => {
    const { lines, log } = capture();
    const error = new Error('the api answered 503');

    log(EVENT, error, 'g');

    expect(lines[0]?.message).toContain('the api answered 503');
    expect(lines[0]?.meta.stack).toBe(error.stack);
  });

  test('something thrown that is not an Error is still described', () => {
    expect(loggableError('plain words')).toEqual({ message: 'plain words' });
  });
});

describe('the worker wires it to the bus', () => {
  test('index.ts hands the bus the redacting logger', async () => {
    const source = await Bun.file(`${import.meta.dir}/../src/index.ts`).text();

    expect(source).toContain('onHandlerError: logHandlerError(');
  });
});
