import { describe, expect, test } from 'bun:test';
import type { ProtonEvent } from '@proton/core';
import type { LevelingConfig } from '../src/config.ts';
import type { LevelingDeps } from '../src/deps.ts';
import { voiceXpPayout } from '../src/multipliers.ts';
import { voiceSessionSchema } from '../src/voice-session.ts';
import { createVoiceXpListener } from '../src/voice-xp.ts';
import {
  FakeSessions,
  FakeXpEventStore,
  FakeXpStore,
  GUILD,
  guildStateOf,
  listenerContext,
  USER,
  xpEvent,
} from './fakes.ts';

const CATEGORY = '300000000000000001';
const VOICE = '300000000000000005';
const ROLE = '400000000000000001';
const T = Date.parse('2026-09-13T12:00:00.000Z');
const MINUTE = 60_000;

function window(startsAt: number, endsAt: number, multiplier: number) {
  return { multiplier, startsAt: T + startsAt * MINUTE, endsAt: T + endsAt * MINUTE };
}

describe('voiceXpPayout', () => {
  test('with nothing applying it pays minutes × XP per minute', () => {
    expect(
      voiceXpPayout({
        joinedAt: T,
        minutes: 30,
        voiceXpPerMinute: 5,
        staticCandidates: [],
        events: [],
      }),
    ).toBe(150);
  });

  test('a static multiplier applies to the whole session', () => {
    expect(
      voiceXpPayout({
        joinedAt: T,
        minutes: 30,
        voiceXpPerMinute: 5,
        staticCandidates: [2],
        events: [],
      }),
    ).toBe(300);
  });

  test('an event inside the session pays its multiplier only for the minutes it overlaps', () => {
    const amount = voiceXpPayout({
      joinedAt: T,
      minutes: 60,
      voiceXpPerMinute: 5,
      staticCandidates: [],
      events: [window(20, 40, 2)],
    });

    expect(amount).toBe(20 * 5 + 20 * 10 + 20 * 5);
  });

  test('an event already running at join and ending mid-session is cut at its end', () => {
    const amount = voiceXpPayout({
      joinedAt: T,
      minutes: 60,
      voiceXpPerMinute: 5,
      staticCandidates: [],
      events: [window(-10, 30, 3)],
    });

    expect(amount).toBe(30 * 15 + 30 * 5);
  });

  test('overlapping events pay the highest one running in each stretch', () => {
    const amount = voiceXpPayout({
      joinedAt: T,
      minutes: 60,
      voiceXpPerMinute: 1,
      staticCandidates: [],
      events: [window(0, 40, 2), window(20, 60, 3)],
    });

    expect(amount).toBe(20 * 2 + 40 * 3);
  });

  test('a higher static multiplier beats a lower event', () => {
    const amount = voiceXpPayout({
      joinedAt: T,
      minutes: 60,
      voiceXpPerMinute: 5,
      staticCandidates: [4],
      events: [window(0, 60, 2)],
    });

    expect(amount).toBe(60 * 5 * 4);
  });

  test('a static 0 pays nothing, event or not', () => {
    const amount = voiceXpPayout({
      joinedAt: T,
      minutes: 60,
      voiceXpPerMinute: 5,
      staticCandidates: [0, 3],
      events: [window(0, 60, 5)],
    });

    expect(amount).toBe(0);
  });

  test('it rounds once at the end, not per stretch', () => {
    const amount = voiceXpPayout({
      joinedAt: T,
      minutes: 1,
      voiceXpPerMinute: 1,
      staticCandidates: [],
      events: [{ multiplier: 1.5, startsAt: T, endsAt: T + 30_000 }],
    });

    expect(amount).toBe(1);
  });

  test('a positive multiplier that shrinks a session below 1 XP still pays 1', () => {
    expect(
      voiceXpPayout({
        joinedAt: T,
        minutes: 4,
        voiceXpPerMinute: 1,
        staticCandidates: [0.1],
        events: [],
      }),
    ).toBe(1);

    expect(
      voiceXpPayout({
        joinedAt: T,
        minutes: 1,
        voiceXpPerMinute: 4,
        staticCandidates: [0.1],
        events: [],
      }),
    ).toBe(1);

    expect(
      voiceXpPayout({
        joinedAt: T,
        minutes: 2,
        voiceXpPerMinute: 2,
        staticCandidates: [],
        events: [window(-5, 10, 0.1)],
      }),
    ).toBe(1);
  });
});

function voiceEvent(
  id: string,
  at: number,
  channelId: string | null,
  roles?: string[],
): ProtonEvent {
  return {
    id,
    type: 'voice.state_updated',
    guildId: GUILD,
    occurredAt: at,
    payload: {
      user_id: USER,
      channel_id: channelId,
      self_deaf: false,
      deaf: false,
      member: { user: { id: USER, bot: false }, ...(roles ? { roles } : {}) },
    },
  };
}

async function session(
  config: Partial<LevelingConfig>,
  deps: LevelingDeps & { sessions: FakeSessions },
  events: ProtonEvent[],
): Promise<{ xp: FakeXpStore; logs: string[] }> {
  const xp = new FakeXpStore();
  const { ctx, logs } = listenerContext({ enabled: true, voiceXpPerMinute: 5, ...config });
  const listener = createVoiceXpListener({ xp, ...deps });

  for (const event of events) await listener.handler(event, ctx);
  return { xp, logs };
}

describe('voice XP multipliers', () => {
  test('the roles a member held when they joined are captured on the session', async () => {
    const sessions = new FakeSessions();

    await session({}, { sessions }, [voiceEvent('join', T, VOICE, [ROLE])]);

    expect((await sessions.get(GUILD, USER))?.roleIds).toEqual([ROLE]);
  });

  test('those captured roles decide the payout when the member leaves', async () => {
    const sessions = new FakeSessions();

    const { xp } = await session(
      { roleMultipliers: [{ roleId: ROLE, multiplier: 2 }] },
      { sessions },
      [voiceEvent('join', T, VOICE, [ROLE]), voiceEvent('leave', T + 30 * MINUTE, null)],
    );

    expect(xp.credits[0]).toMatchObject({ amount: 30 * 5 * 2, seconds: 30 * 60 });
  });

  test('a session opened before roles were captured still parses and pays at 1×', async () => {
    const legacy = { guildId: GUILD, userId: USER, channelId: VOICE, joinedAt: T };
    expect(voiceSessionSchema.safeParse(legacy).success).toBe(true);

    const sessions = new FakeSessions();
    await sessions.open(legacy);

    const { xp } = await session(
      { roleMultipliers: [{ roleId: ROLE, multiplier: 3 }] },
      { sessions },
      [voiceEvent('leave', T + 10 * MINUTE, null)],
    );

    expect(xp.credits[0]?.amount).toBe(10 * 5);
  });

  test('the session channel’s category multiplier applies', async () => {
    const sessions = new FakeSessions();

    const { xp } = await session(
      { channelMultipliers: [{ channelId: CATEGORY, multiplier: 1.5 }] },
      { sessions, guildState: guildStateOf({ [VOICE]: CATEGORY, [CATEGORY]: null }) },
      [voiceEvent('join', T, VOICE), voiceEvent('leave', T + 20 * MINUTE, null)],
    );

    expect(xp.credits[0]?.amount).toBe(20 * 5 * 1.5);
  });

  test('an XP event is split at its boundaries across the session', async () => {
    const sessions = new FakeSessions();
    const xpEvents = new FakeXpEventStore().seed(
      xpEvent({ startsAt: T + 10 * MINUTE, endsAt: T + 20 * MINUTE, multiplier: 3 }),
    );

    const { xp } = await session({}, { sessions, xpEvents }, [
      voiceEvent('join', T, VOICE),
      voiceEvent('leave', T + 30 * MINUTE, null),
    ]);

    expect(xp.credits[0]?.amount).toBe(10 * 5 + 10 * 15 + 10 * 5);
  });

  test('a 0× multiplier pays nothing and credits no voice time', async () => {
    const sessions = new FakeSessions();

    const { xp, logs } = await session(
      { channelMultipliers: [{ channelId: VOICE, multiplier: 0 }] },
      { sessions },
      [voiceEvent('join', T, VOICE), voiceEvent('leave', T + 30 * MINUTE, null)],
    );

    expect(xp.credits).toEqual([]);
    expect(logs.some((line) => line.includes('0×'))).toBe(true);
  });

  test('a small positive multiplier still pays 1 XP and credits the voice time', async () => {
    const sessions = new FakeSessions();

    const { xp, logs } = await session(
      { voiceXpPerMinute: 1, channelMultipliers: [{ channelId: VOICE, multiplier: 0.1 }] },
      { sessions },
      [voiceEvent('join', T, VOICE), voiceEvent('leave', T + 4 * MINUTE, null)],
    );

    expect(xp.credits).toHaveLength(1);
    expect(xp.credits[0]).toMatchObject({ amount: 1, seconds: 4 * 60 });
    expect(logs.some((line) => line.includes('0×'))).toBe(false);
  });

  test('the base window keeps its 24 hour cap and whole minutes', async () => {
    const sessions = new FakeSessions();

    const { xp } = await session({}, { sessions }, [
      voiceEvent('join', T, VOICE),
      voiceEvent('leave', T + 30 * 60 * MINUTE + 59_000, null),
    ]);

    expect(xp.credits[0]).toMatchObject({ amount: 24 * 60 * 5, seconds: 24 * 60 * 60 });
  });
});

const PARTIAL_VOICE_STATE = { user_id: USER, channel_id: VOICE, self_deaf: false, deaf: false };

function available(members?: unknown[]): ProtonEvent {
  return {
    id: 'available',
    type: 'guild.available',
    guildId: GUILD,
    occurredAt: T,
    payload: { id: GUILD, voice_states: [PARTIAL_VOICE_STATE], ...(members ? { members } : {}) },
  };
}

describe('voice sessions adopted when a guild becomes available', () => {
  test('take their roles from the members list, since those voice states carry no member', async () => {
    const sessions = new FakeSessions();

    await session({}, { sessions }, [
      available([{ user: { id: USER, bot: false }, roles: [ROLE] }]),
    ]);

    expect(await sessions.get(GUILD, USER)).toEqual({
      guildId: GUILD,
      userId: USER,
      channelId: VOICE,
      joinedAt: T,
      roleIds: [ROLE],
    });
  });

  test('a 0× role held by an adopted member pays nothing', async () => {
    const sessions = new FakeSessions();

    const { xp } = await session(
      { roleMultipliers: [{ roleId: ROLE, multiplier: 0 }] },
      { sessions },
      [
        available([{ user: { id: USER, bot: false }, roles: [ROLE] }]),
        voiceEvent('leave', T + 30 * MINUTE, null),
      ],
    );

    expect(xp.credits).toEqual([]);
  });

  test('a bot known only from the members list is not adopted', async () => {
    const sessions = new FakeSessions();

    await session({}, { sessions }, [available([{ user: { id: USER, bot: true }, roles: [] }])]);

    expect(await sessions.get(GUILD, USER)).toBeNull();
  });

  test('a later update in the same channel that carries roles fills them in, keeping the join time', async () => {
    const sessions = new FakeSessions();

    const { xp } = await session(
      { roleMultipliers: [{ roleId: ROLE, multiplier: 2 }] },
      { sessions },
      [
        available(),
        voiceEvent('mute', T + 5 * MINUTE, VOICE, [ROLE]),
        voiceEvent('leave', T + 30 * MINUTE, null),
      ],
    );

    expect(xp.credits[0]).toMatchObject({ amount: 30 * 5 * 2, seconds: 30 * 60 });
  });
});
