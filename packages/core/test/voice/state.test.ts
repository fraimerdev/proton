import { describe, expect, test } from 'bun:test';
import { dispatch } from '@proton/fixtures';
import { isVoiceEligible, readVoiceState, type VoiceState } from '../../src/voice/state.ts';

const USER = '100000000000000001';
const VOICE = '500000000000000009';
const AFK = '500000000000000010';
const ROLE = '700000000000000001';

const NONE: ReadonlySet<string> = new Set();

function state(overrides: Partial<VoiceState> = {}): VoiceState {
  return {
    userId: USER,
    channelId: VOICE,
    selfDeaf: false,
    serverDeaf: false,
    isBot: false,
    roleIds: [],
    joinedAt: null,
    premiumSince: null,
    ...overrides,
  };
}

describe('readVoiceState', () => {
  test('reads a join, with the member it carries', () => {
    expect(readVoiceState(dispatch('voiceStateJoin').d)).toEqual({
      userId: USER,
      channelId: VOICE,
      selfDeaf: false,
      serverDeaf: false,
      isBot: false,
      roleIds: [],
      joinedAt: '2026-08-14T09:00:00.000000+00:00',
      premiumSince: null,
    });
  });

  test('reads a leave, which carries no member, as unknown bot flag and roles', () => {
    expect(readVoiceState(dispatch('voiceStateLeave').d)).toEqual({
      userId: USER,
      channelId: null,
      selfDeaf: false,
      serverDeaf: false,
      isBot: null,
      roleIds: null,
      joinedAt: null,
      premiumSince: null,
    });
  });

  test('reads Discord’s deaf as a server deafen and self_deaf as a self deafen', () => {
    const { d } = dispatch('voiceStateJoin');

    expect(readVoiceState({ ...d, deaf: true })?.serverDeaf).toBe(true);
    expect(readVoiceState({ ...d, self_deaf: true })?.selfDeaf).toBe(true);
  });

  test('reads the boost date when the member is boosting', () => {
    const { d } = dispatch('voiceStateJoin');
    const member = d.member as Record<string, unknown>;

    expect(
      readVoiceState({ ...d, member: { ...member, premium_since: '2026-01-02T03:04:05.000Z' } })
        ?.premiumSince,
    ).toBe('2026-01-02T03:04:05.000Z');
  });

  test('keeps only the role ids that are text', () => {
    const { d } = dispatch('voiceStateJoin');
    const member = d.member as Record<string, unknown>;

    expect(
      readVoiceState({ ...d, member: { ...member, roles: [ROLE, 7, null] } })?.roleIds,
    ).toEqual([ROLE]);
  });

  test('reads a member entry the way a GUILD_CREATE members list supplies it', () => {
    const read = readVoiceState({
      user_id: USER,
      member: { user: { id: USER, bot: true }, roles: [ROLE] },
    });

    expect(read).toMatchObject({ userId: USER, channelId: null, isBot: true, roleIds: [ROLE] });
  });

  test.each([
    ['nothing', undefined],
    ['null', null],
    ['text', 'voice'],
    ['a state with no user', { channel_id: VOICE }],
    ['a state whose user id is a number', { user_id: 1, channel_id: VOICE }],
  ])('returns null for %s', (_label, payload) => {
    expect(readVoiceState(payload)).toBeNull();
  });
});

describe('isVoiceEligible', () => {
  test('a member in a voice channel who can hear counts', () => {
    expect(isVoiceEligible(state(), { excludedChannelIds: NONE })).toBe(true);
  });

  test('muted still counts, since a listener is still taking part', () => {
    expect(isVoiceEligible(state(), { excludedChannelIds: NONE })).toBe(true);
  });

  test('a member whose bot flag is unknown still counts', () => {
    expect(isVoiceEligible(state({ isBot: null }), { excludedChannelIds: NONE })).toBe(true);
  });

  test('a member who left voice does not count', () => {
    expect(isVoiceEligible(state({ channelId: null }), { excludedChannelIds: NONE })).toBe(false);
  });

  test('a bot never counts', () => {
    expect(isVoiceEligible(state({ isBot: true }), { excludedChannelIds: NONE })).toBe(false);
  });

  test('a member who deafened themselves does not count', () => {
    expect(isVoiceEligible(state({ selfDeaf: true }), { excludedChannelIds: NONE })).toBe(false);
  });

  test('a member deafened by the server does not count', () => {
    expect(isVoiceEligible(state({ serverDeaf: true }), { excludedChannelIds: NONE })).toBe(false);
  });

  test('a member in an excluded channel, such as the AFK channel, does not count', () => {
    expect(isVoiceEligible(state({ channelId: AFK }), { excludedChannelIds: new Set([AFK]) })).toBe(
      false,
    );
  });

  test('excluding one channel leaves every other channel counting', () => {
    expect(isVoiceEligible(state(), { excludedChannelIds: new Set([AFK]) })).toBe(true);
  });

  test('reads a fixture join as eligible and a fixture leave as not', () => {
    const join = readVoiceState(dispatch('voiceStateJoin').d);
    const leave = readVoiceState(dispatch('voiceStateLeave').d);
    if (!join || !leave) throw new Error('the fixtures did not read');

    expect(isVoiceEligible(join, { excludedChannelIds: NONE })).toBe(true);
    expect(isVoiceEligible(leave, { excludedChannelIds: NONE })).toBe(false);
  });
});
