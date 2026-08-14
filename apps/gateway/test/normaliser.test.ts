import { describe, expect, test } from 'bun:test';
import { dispatch } from '@proton/fixtures';
import {
  CHANNEL_OBFUSCATED,
  isObfuscatedChannel,
  normalise,
  type RawDispatch,
} from '../src/normaliser.ts';

describe('normalise', () => {
  test('maps INTERACTION_CREATE (application command) to interaction.command', () => {
    const event = normalise(dispatch('interactionCreatePing'));

    expect(event?.type).toBe('interaction.command');
    expect(event?.guildId).toBe('900000000000000001');
  });

  test('maps GUILD_CREATE to guild.available', () => {
    const event = normalise(dispatch('guildCreate'));

    expect(event?.type).toBe('guild.available');
    expect(event?.guildId).toBe('900000000000000001');
  });

  test('maps GUILD_MEMBER_ADD to member.joined with the payload timestamp', () => {
    const event = normalise(dispatch('guildMemberAdd'));

    expect(event?.type).toBe('member.joined');
    expect(event?.occurredAt).toBe(Date.parse('2026-08-14T09:00:00.000000+00:00'));
  });

  test('maps MESSAGE_CREATE to message.created', () => {
    const event = normalise(dispatch('messageCreate'));

    expect(event?.type).toBe('message.created');
  });

  test('ignores READY — it carries no internal meaning', () => {
    expect(normalise(dispatch('ready'))).toBeNull();
  });

  test('ignores an unknown dispatch without throwing', () => {
    const unknown: RawDispatch = { t: 'SOMETHING_NEW', s: 1, op: 0, d: { id: '1' } };

    expect(() => normalise(unknown)).not.toThrow();
    expect(normalise(unknown)).toBeNull();
  });

  test('ignores non-command interactions', () => {
    const raw = dispatch('interactionCreatePing');
    raw.d.type = 3; // MESSAGE_COMPONENT

    expect(normalise(raw)).toBeNull();
  });

  /**
   * The property the whole dedupe story rests on. Gateway RESUME redelivers the
   * identical dispatch; if the normaliser minted a fresh id each time, the same
   * Discord event would be handled twice and I4 would be unenforceable.
   */
  describe('event ids are deterministic across redelivery', () => {
    test('the same interaction dispatch always yields the same id', () => {
      const first = normalise(dispatch('interactionCreatePing'));
      const second = normalise(dispatch('interactionCreatePing'));

      expect(first?.id).toBe(second?.id);
      expect(first?.id).toContain('1300000000000000001');
    });

    test('the id is stable even when the sequence number differs', () => {
      // A RESUME can replay the same event under a different `s`.
      const replayed = dispatch('interactionCreatePing');
      replayed.s = 9999;

      expect(normalise(replayed)?.id).toBe(normalise(dispatch('interactionCreatePing'))?.id);
    });

    test('different messages get different ids', () => {
      const other = dispatch('messageCreate');
      other.d.id = '1400000000000000002';

      expect(normalise(dispatch('messageCreate'))?.id).not.toBe(normalise(other)?.id);
    });
  });
});

describe('channel obfuscation', () => {
  test('detects an obfuscated channel by flag, not by name', () => {
    const raw = dispatch('channelObfuscated');
    const channels = raw.d.channels as Array<{ id: string; name: string; flags: number }>;

    const visible = channels.find((c) => c.id === '500000000000000001') ?? { flags: -1 };
    const hidden = channels.find((c) => c.id === '500000000000000002') ?? { flags: -1 };

    expect(isObfuscatedChannel(visible)).toBe(false);
    expect(isObfuscatedChannel(hidden)).toBe(true);
    expect(CHANNEL_OBFUSCATED).toBe(131072);
  });

  /**
   * A guild may legitimately name a real channel `___hidden___`. Detecting by
   * string would then hide a channel the bot can actually see — and Discord's
   * docs explicitly warn against inspecting the name.
   */
  test('a real channel named ___hidden___ is NOT treated as obfuscated', () => {
    expect(isObfuscatedChannel({ flags: 0 })).toBe(false);
  });

  test('unobfuscated fields survive on an obfuscated channel', () => {
    const raw = dispatch('channelObfuscated');
    const channels = raw.d.channels as Array<Record<string, unknown>>;
    const hidden = channels.find((c) => c.id === '500000000000000002');

    // id, type, position and parent_id are never obfuscated — a backup module
    // can still record that the channel exists and where it sits.
    expect(hidden?.id).toBe('500000000000000002');
    expect(hidden?.type).toBe(0);
    expect(hidden?.position).toBe(1);
    expect(hidden?.name).toBe('___hidden___');
  });
});
