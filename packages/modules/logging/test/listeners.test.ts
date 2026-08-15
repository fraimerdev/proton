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
    const ctx = context(); // defaults — enabled is false

    await listener.handler(messageUpdated(), ctx);
    await listener.handler(messageDeleted(), ctx);
    await listener.handler(messageBulkDeleted(['600000000000000010']), ctx);

    expect(store.appended).toEqual([]);
    // Silence, not a warning: not opting in is a choice, not a misconfiguration.
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

    // The gateway derives the event id from the dispatch, so a RESUME redelivers
    // the identical event rather than a new one.
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
    // "The bot did nothing" is a bug (§1): the message names the missing piece
    // and the call that supplies it.
    expect(ctx.logs[0]?.message).toContain('PostgresMessageLogStore');
    expect(ctx.logs[0]?.message).toContain('createLoggingModule');
  });

  test('stays quiet when a guild that opted in produces nothing to log', async () => {
    const listener = createMessageLogListener({});
    const ctx = context({ enabled: true, ignoredChannels: [CHANNEL] });

    // No store bound, but nothing to store either — an ignored channel must not
    // produce an alarm about wiring.
    await listener.handler(messageUpdated(), ctx);

    expect(ctx.logs).toEqual([]);
  });
});
