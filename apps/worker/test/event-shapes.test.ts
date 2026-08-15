import { describe, expect, test } from 'bun:test';
import { dispatch } from '@proton/fixtures';
import { normalise } from '@proton/gateway/normaliser';
import { loggingDefaultConfig, toMessageLogEntries } from '@proton/module-logging';
import { readMessage } from '@proton/module-phishing';

describe('the normaliser emits payloads the logging module can read', () => {
  const config = {
    ...loggingDefaultConfig,
    enabled: true,
    logEdits: true,
    logDeletes: true,
    ignoredChannels: [],
  };

  test('an edit becomes one edit row carrying the new content and the author', () => {
    const event = normalise(dispatch('messageUpdate'));
    const rows = toMessageLogEntries(event as NonNullable<typeof event>, config);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.kind).toBe('edit');
    expect(rows[0]?.messageId).toBe('1400000000000000001');
    expect(rows[0]?.authorId).toBe('100000000000000001');
    expect(rows[0]?.contentAfter).toContain('discord-nitro-gift');

    expect(rows[0]?.contentBefore).toBeNull();
    expect(rows[0]?.guildId).toBe('900000000000000001');
  });

  test('a deletion becomes one delete row', () => {
    const event = normalise(dispatch('messageDelete'));
    const rows = toMessageLogEntries(event as NonNullable<typeof event>, config);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.kind).toBe('delete');
    expect(rows[0]?.messageId).toBe('1400000000000000001');
  });

  test('a bulk delete becomes one row per message, each deterministically keyed', () => {
    const event = normalise(dispatch('messageDeleteBulk'));
    const rows = toMessageLogEntries(event as NonNullable<typeof event>, config);

    expect(rows).toHaveLength(3);
    expect(new Set(rows.map((r) => r.kind))).toEqual(new Set(['bulk_delete']));

    expect(new Set(rows.map((r) => r.id)).size).toBe(3);
  });

  test('replaying the same dispatch produces identical row ids', () => {
    const first = toMessageLogEntries(normalise(dispatch('messageUpdate')) as never, config);
    const second = toMessageLogEntries(normalise(dispatch('messageUpdate')) as never, config);

    expect(first.map((r) => r.id)).toEqual(second.map((r) => r.id));
  });

  test('an embed-resolution update is not logged as an edit', () => {
    const raw = dispatch('messageUpdate');

    raw.d.edited_timestamp = null;

    expect(toMessageLogEntries(normalise(raw) as never, config)).toEqual([]);
  });

  test('a guild that opted out of edit logging gets no edit rows', () => {
    const rows = toMessageLogEntries(normalise(dispatch('messageUpdate')) as never, {
      ...config,
      logEdits: false,
    });

    expect(rows).toEqual([]);
  });
});

describe('the normaliser emits payloads the phishing module can read', () => {
  test('a created message yields an inspectable message', () => {
    const event = normalise(dispatch('messageCreate'));
    const message = readMessage((event as NonNullable<typeof event>).payload);

    expect(message?.messageId).toBe('1400000000000000001');
    expect(message?.channelId).toBe('500000000000000001');
    expect(message?.authorId).toBe('100000000000000001');
    expect(message?.content).toBe('hello world');
  });

  test('an edited message yields the NEW content, so the edit is what gets checked', () => {
    const event = normalise(dispatch('messageUpdate'));
    const message = readMessage((event as NonNullable<typeof event>).payload);

    expect(message?.content).toContain('https://discord-nitro-gift.example.com/claim');
  });

  test('a partial update with no author or content is declined, not thrown on', () => {
    const raw = dispatch('messageUpdate');
    raw.d = { id: raw.d.id, channel_id: raw.d.channel_id, guild_id: raw.d.guild_id };
    const event = normalise(raw);

    expect(event?.type).toBe('message.updated');
    expect(() => readMessage((event as NonNullable<typeof event>).payload)).not.toThrow();
    expect(readMessage((event as NonNullable<typeof event>).payload)).toBeNull();
  });

  test('a partial update is also declined by the logging module', () => {
    const raw = dispatch('messageUpdate');
    raw.d = { id: raw.d.id, channel_id: raw.d.channel_id, guild_id: raw.d.guild_id };

    expect(
      toMessageLogEntries(normalise(raw) as never, {
        ...loggingDefaultConfig,
        enabled: true,
        logEdits: true,
        ignoredChannels: [],
      }),
    ).toEqual([]);
  });
});
