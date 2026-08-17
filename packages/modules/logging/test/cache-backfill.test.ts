import { describe, expect, test } from 'bun:test';
import type { CachedMessage } from '@proton/core';
import { loggingConfigSchema } from '../src/config.ts';
import { messageIdsOf, toMessageLogEntries } from '../src/events.ts';
import { messageBulkDeleted, messageDeleted, messageUpdated } from './harness.ts';

const bulkDeleted = () =>
  messageBulkDeleted(['1400000000000000001', '1400000000000000002', '1400000000000000003']);

const config = loggingConfigSchema.parse({ enabled: true });

const AUTHOR = '100000000000000002';

function cached(overrides: Partial<CachedMessage> = {}): CachedMessage {
  return {
    authorId: AUTHOR,
    authorBot: false,
    channelId: '500000000000000001',
    content: 'what it said before',
    attachments: [],
    createdAt: 0,
    ...overrides,
  };
}

describe('contentBefore backfill', () => {
  test('an edit records the previous text when it was remembered', () => {
    const event = messageUpdated();
    const ids = messageIdsOf(event);
    const map = new Map([[ids[0] ?? '', cached()]]);

    const [entry] = toMessageLogEntries(event, config, map);

    expect(entry?.contentBefore).toBe('what it said before');
    expect(entry?.contentAfter).not.toBe('what it said before');
  });

  test('without the cache contentBefore stays null rather than guessing', () => {
    const [entry] = toMessageLogEntries(messageUpdated(), config);

    expect(entry?.contentBefore).toBeNull();
  });

  test('a delete finally records who wrote it — Discord never says', () => {
    const event = messageDeleted();
    const map = new Map([[messageIdsOf(event)[0] ?? '', cached()]]);

    const [entry] = toMessageLogEntries(event, config, map);

    expect(entry?.authorId).toBe(AUTHOR);
    expect(entry?.contentBefore).toBe('what it said before');
  });

  test('a delete with no cached entry still records the deletion', () => {
    const [entry] = toMessageLogEntries(messageDeleted(), config);

    expect(entry?.kind).toBe('delete');
    expect(entry?.authorId).toBeNull();
    expect(entry?.contentBefore).toBeNull();
  });

  test('a bulk delete backfills per message, not all-or-nothing', () => {
    const event = bulkDeleted();
    const ids = messageIdsOf(event);
    const map = new Map([[ids[0] ?? '', cached({ content: 'only the first' })]]);

    const entries = toMessageLogEntries(event, config, map);

    expect(entries).toHaveLength(ids.length);
    expect(entries[0]?.contentBefore).toBe('only the first');
    expect(entries[1]?.contentBefore).toBeNull();
  });
});

describe('messageIdsOf', () => {
  test('reads the single id from an edit or a delete', () => {
    expect(messageIdsOf(messageUpdated())).toHaveLength(1);
    expect(messageIdsOf(messageDeleted())).toHaveLength(1);
  });

  test('reads every id from a bulk delete, so one MGET covers the batch', () => {
    expect(messageIdsOf(bulkDeleted()).length).toBeGreaterThan(1);
  });
});
