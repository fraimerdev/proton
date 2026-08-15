import { describe, expect, test } from 'bun:test';
import { loggingConfigSchema } from '../src/config.ts';
import { toMessageLogEntries } from '../src/events.ts';
import {
  AUTHOR,
  CHANNEL,
  EDITED_AT,
  GUILD,
  MESSAGE,
  messageBulkDeleted,
  messageDeleted,
  messageUpdated,
  OCCURRED_AT,
  OTHER_CHANNEL,
} from './harness.ts';

const optedIn = loggingConfigSchema.parse({ enabled: true });

describe('message.updated', () => {
  test('records the new text, the author and the channel', () => {
    const [entry, ...rest] = toMessageLogEntries(messageUpdated(), optedIn);

    expect(rest).toHaveLength(0);
    expect(entry).toMatchObject({
      guildId: GUILD,
      channelId: CHANNEL,
      messageId: MESSAGE,
      authorId: AUTHOR,
      kind: 'edit',
      contentAfter: 'the edited text',
    });
    expect(entry?.occurredAt.getTime()).toBe(OCCURRED_AT);
  });

  test('leaves contentBefore null — Discord does not send the previous text', () => {
    expect(toMessageLogEntries(messageUpdated(), optedIn)[0]?.contentBefore).toBeNull();
  });

  /**
   * The row id is the event id, so a redelivery writes the same row rather than
   * a second one (I4). The event id itself is the normaliser's, which carries
   * `edited_timestamp` — without it an edit would collide with the post it
   * edits, and two successive edits with each other.
   */
  test('reuses the event id, so a redelivery collides with itself (I4)', () => {
    expect(toMessageLogEntries(messageUpdated(), optedIn)[0]?.id).toBe(
      `message.updated:${MESSAGE}:${EDITED_AT}`,
    );
    expect(toMessageLogEntries(messageUpdated(), optedIn)[0]?.id).toBe(
      toMessageLogEntries(messageUpdated(), optedIn)[0]?.id ?? '',
    );
  });

  test('ignores an update that carries no content', () => {
    // Discord sends MESSAGE_UPDATE when it resolves a link embed or a pin. Those
    // would otherwise be logged as the member blanking their own message.
    const embedResolved = messageUpdated({ payload: { content: undefined } });
    expect(toMessageLogEntries(embedResolved, optedIn)).toEqual([]);
  });

  test('respects the logEdits toggle', () => {
    const config = loggingConfigSchema.parse({ enabled: true, logEdits: false });
    expect(toMessageLogEntries(messageUpdated(), config)).toEqual([]);
    // Deletions are a separate decision and must still be recorded.
    expect(toMessageLogEntries(messageDeleted(), config)).toHaveLength(1);
  });
});

describe('message.deleted', () => {
  test('records which message went, with no content and no author', () => {
    const [entry] = toMessageLogEntries(messageDeleted(), optedIn);

    expect(entry).toMatchObject({
      messageId: MESSAGE,
      kind: 'delete',
      authorId: null,
      contentBefore: null,
      contentAfter: null,
    });
  });

  test('respects the logDeletes toggle', () => {
    const config = loggingConfigSchema.parse({ enabled: true, logDeletes: false });
    expect(toMessageLogEntries(messageDeleted(), config)).toEqual([]);
    expect(toMessageLogEntries(messageUpdated(), config)).toHaveLength(1);
  });
});

describe('message.bulk_deleted', () => {
  const ids = ['600000000000000010', '600000000000000011', '600000000000000012'];

  test('becomes one row per message, so a purge reads like the deletions it was', () => {
    const entries = toMessageLogEntries(messageBulkDeleted(ids), optedIn);

    expect(entries.map((e) => e.messageId)).toEqual(ids);
    expect(entries.every((e) => e.kind === 'bulk_delete')).toBe(true);
  });

  test('gives every row a distinct but still deterministic id (I4)', () => {
    const entries = toMessageLogEntries(messageBulkDeleted(ids), optedIn);
    const rowIds = entries.map((e) => e.id);

    expect(new Set(rowIds).size).toBe(ids.length);
    expect(rowIds).toEqual(toMessageLogEntries(messageBulkDeleted(ids), optedIn).map((e) => e.id));
  });

  test('drops ids that are not strings rather than writing junk rows', () => {
    const malformed = messageBulkDeleted(ids, { payload: { ids: [ids[0], 42, null] } });
    expect(toMessageLogEntries(malformed, optedIn)).toHaveLength(1);
  });

  test('is governed by logDeletes', () => {
    const config = loggingConfigSchema.parse({ enabled: true, logDeletes: false });
    expect(toMessageLogEntries(messageBulkDeleted(ids), config)).toEqual([]);
  });
});

describe('what is never recorded', () => {
  test('channels on the ignore list', () => {
    const config = loggingConfigSchema.parse({ enabled: true, ignoredChannels: [CHANNEL] });

    expect(toMessageLogEntries(messageUpdated(), config)).toEqual([]);
    expect(toMessageLogEntries(messageDeleted(), config)).toEqual([]);
  });

  test('but only those channels', () => {
    const config = loggingConfigSchema.parse({ enabled: true, ignoredChannels: [OTHER_CHANNEL] });
    expect(toMessageLogEntries(messageUpdated(), config)).toHaveLength(1);
  });

  test('anything outside a guild — a DM has no guild that opted in', () => {
    const dm = messageUpdated({ guildId: null, payload: { guild_id: undefined } });
    expect(toMessageLogEntries(dm, optedIn)).toEqual([]);
  });

  test('a payload missing the channel it happened in', () => {
    const broken = messageDeleted({ payload: { channel_id: undefined } });
    expect(toMessageLogEntries(broken, optedIn)).toEqual([]);
  });

  test('events this module does not subscribe to', () => {
    const created = { ...messageUpdated(), type: 'message.created' as const };
    expect(toMessageLogEntries(created, optedIn)).toEqual([]);
  });
});
