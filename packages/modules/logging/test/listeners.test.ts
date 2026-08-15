import { describe, expect, test } from 'bun:test';
import { createMessageLogListener } from '../src/listeners.ts';
import {
  CHANNEL,
  context,
  MemoryMessageLogStore,
  messageBulkDeleted,
  messageDeleted,
  messageUpdated,
} from './harness.ts';

describe('the message log listener', () => {
  test('records nothing for a guild that has not opted in', async () => {
    const store = new MemoryMessageLogStore();
    const listener = createMessageLogListener({ store });
    const ctx = context();

    await listener.handler(messageUpdated(), ctx);
    await listener.handler(messageDeleted(), ctx);
    await listener.handler(messageBulkDeleted(['600000000000000010']), ctx);

    expect(store.appended).toEqual([]);

    expect(ctx.logs).toEqual([]);
  });

  test('records edits and deletions once the guild opts in', async () => {
    const store = new MemoryMessageLogStore();
    const listener = createMessageLogListener({ store });
    const ctx = context({ enabled: true });

    await listener.handler(messageUpdated(), ctx);
    await listener.handler(messageDeleted(), ctx);

    expect(store.appended.map((entry) => entry.kind)).toEqual(['edit', 'delete']);
    expect(store.appended[0]?.channelId).toBe(CHANNEL);
  });

  test('a redelivered event writes one row, not two (I4)', async () => {
    const store = new MemoryMessageLogStore();
    const listener = createMessageLogListener({ store });
    const ctx = context({ enabled: true });

    await listener.handler(messageUpdated(), ctx);
    await listener.handler(messageUpdated(), ctx);

    expect(store.appended).toHaveLength(1);
    expect(ctx.logs).toEqual([{ level: 'info', message: 'message log entries already recorded' }]);
  });

  test('says what is unwired instead of dropping the event silently', async () => {
    const listener = createMessageLogListener({});
    const ctx = context({ enabled: true });

    await listener.handler(messageUpdated(), ctx);

    expect(ctx.logs[0]?.level).toBe('error');

    expect(ctx.logs[0]?.message).toContain('PostgresMessageLogStore');
    expect(ctx.logs[0]?.message).toContain('createLoggingModule');
  });

  test('stays quiet when a guild that opted in produces nothing to log', async () => {
    const listener = createMessageLogListener({});
    const ctx = context({ enabled: true, ignoredChannels: [CHANNEL] });

    await listener.handler(messageUpdated(), ctx);

    expect(ctx.logs).toEqual([]);
  });
});
