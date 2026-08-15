import { describe, expect, test } from 'bun:test';
import { dispatch } from '@proton/fixtures';
import { normalise } from '@proton/gateway/normaliser';
import { loggingDefaultConfig, toMessageLogEntries } from '@proton/module-logging';
import { readMessage } from '@proton/module-phishing';

/**
 * Does what the gateway emits match what the modules can actually read?
 *
 * This crosses a boundary nothing else tests, and the gap is where Phase 1's
 * worst bug lived: `logging` subscribed to three event types, parsed a payload
 * shape of its own devising in its own tests, and passed — while the normaliser
 * emitted none of those types, so in production it read nothing at all. The
 * registry's subset guard now stops a module subscribing to an event nobody
 * emits; this stops a module subscribing to an event whose *shape* it cannot
 * parse, which fails just as silently.
 *
 * It lives in `apps/worker` because the worker is the process that actually
 * joins the two: it depends on the gateway's normaliser and on every module.
 */
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
    // Discord does not send the previous content, so this is always null (§6:
    // recovering it would mean storing every message, a different product).
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
    // Distinct ids, or a redelivered purge would double every row (I4).
    expect(new Set(rows.map((r) => r.id)).size).toBe(3);
  });

  /**
   * A redelivered dispatch must produce the same row ids, or the "insert
   * ignoring conflicts" dedupe in the store has nothing to conflict on.
   */
  test('replaying the same dispatch produces identical row ids', () => {
    const first = toMessageLogEntries(normalise(dispatch('messageUpdate')) as never, config);
    const second = toMessageLogEntries(normalise(dispatch('messageUpdate')) as never, config);

    expect(first.map((r) => r.id)).toEqual(second.map((r) => r.id));
  });

  /**
   * The phantom-edit case, and the reason the discriminator is
   * `edited_timestamp` rather than the presence of `content`.
   *
   * Discord raises MESSAGE_UPDATE for its own embed resolution, and the gateway
   * reference is explicit that the inner payload is "a message object with the
   * same extra fields as MESSAGE_CREATE" — the full object, original content
   * attached. Testing `content !== null` would log every link unfurl as a member
   * edit, and would retain the verbatim content of messages nobody edited, which
   * is exactly the content §6 treats as a legal surface.
   */
  test('an embed-resolution update is not logged as an edit', () => {
    const raw = dispatch('messageUpdate');
    // A full message object, as Discord really sends — but nobody edited it.
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

  /**
   * The edit path, which is the entire reason MESSAGE_UPDATE is watched: posting
   * something harmless and editing a scam link in later is the oldest way past a
   * create-only filter. Before this change the event type was declared, the
   * listener subscribed to it, and the normaliser never emitted it.
   */
  test('an edited message yields the NEW content, so the edit is what gets checked', () => {
    const event = normalise(dispatch('messageUpdate'));
    const message = readMessage((event as NonNullable<typeof event>).payload);

    expect(message?.content).toContain('https://discord-nitro-gift.example.com/claim');
  });

  /**
   * Discord's MESSAGE_UPDATE is a *partial* message object — an embed-resolution
   * update carries neither author nor content. `readMessage` must decline rather
   * than throw, or one embed resolution would unack the event and have the bus
   * redeliver it five times before dead-lettering.
   */
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

    // No `content` means Discord resolving an embed, not a member editing text.
    // Logging it as an edit would read as "the message was blanked".
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
