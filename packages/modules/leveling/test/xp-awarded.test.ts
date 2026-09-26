import { describe, expect, test } from 'bun:test';
import type { ProtonEvent, RawOption } from '@proton/core';
import { xpCommand } from '../src/commands.ts';
import { createMessageXpListener } from '../src/message-xp.ts';
import { createVoiceXpListener } from '../src/voice-xp.ts';
import {
  capturePublishes,
  commandContext,
  FakeSessions,
  FakeXpStore,
  GUILD,
  listenerContext,
  USER,
} from './fakes.ts';

const CHANNEL = '300000000000000002';
const VOICE = '300000000000000005';
const TARGET = '400000000000000004';
const COMMAND_CHANNEL = '300000000000000009';
const AT = Date.parse('2026-09-19T12:00:00.000Z');
const MINUTE = 60_000;

function messageEvent(id = 'message-event-1'): ProtonEvent {
  return {
    id,
    type: 'message.created',
    guildId: GUILD,
    occurredAt: AT,
    payload: {
      id: '500000000000000001',
      channel_id: CHANNEL,
      author: { id: USER },
      type: 0,
      member: { roles: [] },
    },
  };
}

function voiceEvent(id: string, at: number, channelId: string | null): ProtonEvent {
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
      member: { user: { id: USER, bot: false } },
    },
  };
}

function adjustOptions(subcommand: 'give' | 'take', amount: number): RawOption[] {
  return [
    {
      name: subcommand,
      type: 1,
      options: [
        { name: 'user', type: 6, value: TARGET },
        { name: 'amount', type: 4, value: amount },
      ],
    },
  ];
}

describe('xp.awarded', () => {
  test('a message that earns XP publishes it, keyed by the message event', async () => {
    const xp = new FakeXpStore();
    const { ctx } = listenerContext({ enabled: true, xpPerMessageMin: 10, xpPerMessageMax: 10 });
    const published = capturePublishes(ctx);

    await createMessageXpListener({ xp }).handler(messageEvent(), ctx);

    expect(published).toEqual([
      {
        type: 'xp.awarded',
        key: 'message-event-1',
        payload: {
          guildId: GUILD,
          userId: USER,
          amount: 10,
          source: 'message',
          channelId: CHANNEL,
          activityAt: AT,
          xp: 10,
          level: 0,
          causation: { kind: 'organic', rootId: 'message-event-1', depth: 0 },
        },
      },
    ]);
  });

  test('a message still inside its cooldown publishes nothing', async () => {
    const xp = new FakeXpStore();
    xp.award = async () => ({ xp: 40, level: 0, previousLevel: 0, awarded: false });
    const { ctx } = listenerContext({ enabled: true });
    const published = capturePublishes(ctx);

    await createMessageXpListener({ xp }).handler(messageEvent(), ctx);

    expect(published).toEqual([]);
  });

  test('a message level-up carries the channel it happened in and what caused it', async () => {
    const xp = new FakeXpStore();
    xp.award = async () => ({ xp: 120, level: 1, previousLevel: 0, awarded: true });
    const { ctx } = listenerContext({ enabled: true, xpPerMessageMin: 20, xpPerMessageMax: 20 });
    const published = capturePublishes(ctx);

    await createMessageXpListener({ xp }).handler(messageEvent(), ctx);

    expect(published.map((entry) => entry.type)).toEqual(['xp.awarded', 'xp.level_gained']);
    expect(published[1]).toEqual({
      type: 'xp.level_gained',
      key: `${GUILD}:${USER}:1`,
      payload: {
        guildId: GUILD,
        userId: USER,
        level: 1,
        previousLevel: 0,
        xp: 120,
        source: 'message',
        channelId: CHANNEL,
        causation: { kind: 'organic', rootId: 'message-event-1', depth: 0 },
      },
    });
  });

  test('an award whose level-up throws is published before it, so the XP is not lost', async () => {
    const xp = new FakeXpStore();
    xp.award = async () => ({ xp: 120, level: 1, previousLevel: 0, awarded: true });
    const { ctx } = listenerContext({ enabled: true, xpPerMessageMin: 20, xpPerMessageMax: 20 });
    const published = capturePublishes(ctx);
    ctx.executor = {
      async execute() {
        throw new Error('fetch failed: connection refused');
      },
    };

    await expect(createMessageXpListener({ xp }).handler(messageEvent(), ctx)).rejects.toThrow(
      'connection refused',
    );

    expect(published.map((entry) => entry.type)).toEqual(['xp.awarded', 'xp.level_gained']);
  });

  test('a roll of zero XP publishes nothing and reports no malformed event', async () => {
    const xp = new FakeXpStore();
    const { ctx, logs } = listenerContext({
      enabled: true,
      xpPerMessageMin: 0,
      xpPerMessageMax: 5,
    });
    const published = capturePublishes(ctx);

    await createMessageXpListener({ xp, random: () => 0 }).handler(messageEvent(), ctx);

    expect(xp.awards).toHaveLength(1);
    expect(published).toEqual([]);
    expect(logs.filter((line) => line.startsWith('error:'))).toEqual([]);
  });

  test('a paid voice session publishes once, keyed by the member and when they joined', async () => {
    const xp = new FakeXpStore();
    const sessions = new FakeSessions();
    const { ctx } = listenerContext({ enabled: true, voiceXpPerMinute: 5 });
    const published = capturePublishes(ctx);
    const listener = createVoiceXpListener({ xp, sessions });

    await listener.handler(voiceEvent('join', AT, VOICE), ctx);
    await listener.handler(voiceEvent('leave', AT + 30 * MINUTE, null), ctx);

    expect(published).toEqual([
      {
        type: 'xp.awarded',
        key: `voice:${USER}:${AT}`,
        payload: {
          guildId: GUILD,
          userId: USER,
          amount: 150,
          source: 'voice',
          channelId: VOICE,
          activityAt: AT + 30 * MINUTE,
          xp: 150,
          level: 0,
          causation: { kind: 'organic', rootId: 'leave', depth: 0 },
        },
      },
    ]);
  });

  test('a voice session too short to pay publishes nothing', async () => {
    const xp = new FakeXpStore();
    const sessions = new FakeSessions();
    const { ctx } = listenerContext({ enabled: true, voiceXpPerMinute: 5 });
    const published = capturePublishes(ctx);
    const listener = createVoiceXpListener({ xp, sessions });

    await listener.handler(voiceEvent('join', AT, VOICE), ctx);
    await listener.handler(voiceEvent('leave', AT + 30_000, null), ctx);

    expect(published).toEqual([]);
  });

  test('/xp give publishes admin XP keyed by the interaction, with the level-up it caused', async () => {
    const xp = new FakeXpStore();
    xp.adjust = async () => ({ xp: 1250, level: 3, previousLevel: 2, awarded: true });
    const { ctx } = commandContext(adjustOptions('give', 500));
    const published = capturePublishes(ctx);

    await xpCommand({ xp, now: () => AT }).handler(ctx);

    const causation = { kind: 'admin', rootId: 'interaction-event-1', depth: 0 };
    expect(published).toEqual([
      {
        type: 'xp.level_gained',
        key: `${GUILD}:${TARGET}:3`,
        payload: {
          guildId: GUILD,
          userId: TARGET,
          level: 3,
          previousLevel: 2,
          xp: 1250,
          source: 'admin',
          channelId: COMMAND_CHANNEL,
          causation,
        },
      },
      {
        type: 'xp.awarded',
        key: 'interaction-event-1',
        payload: {
          guildId: GUILD,
          userId: TARGET,
          amount: 500,
          source: 'admin',
          channelId: COMMAND_CHANNEL,
          activityAt: AT,
          xp: 1250,
          level: 3,
          causation,
        },
      },
    ]);
  });

  test('/xp take awards nothing, so it publishes no xp.awarded', async () => {
    const xp = new FakeXpStore();
    xp.adjust = async () => ({ xp: 100, level: 1, previousLevel: 1, awarded: true });
    const { ctx } = commandContext(adjustOptions('take', 50));
    const published = capturePublishes(ctx);

    await xpCommand({ xp, now: () => AT }).handler(ctx);

    expect(published).toEqual([]);
  });

  test('a publish that fails is logged and costs neither the award nor the announcement', async () => {
    const xp = new FakeXpStore();
    xp.award = async () => ({ xp: 120, level: 1, previousLevel: 0, awarded: true });
    const { ctx, logs, sent } = listenerContext({ enabled: true });
    ctx.publish = async () => {
      throw new Error('redis is down');
    };

    await createMessageXpListener({ xp }).handler(messageEvent(), ctx);

    expect(sent.some((request) => request.kind === 'send')).toBe(true);
    expect(
      logs.filter((line) => line.startsWith('error:') && line.includes('redis is down')),
    ).toHaveLength(2);
  });

  test('a context with no publish port warns instead of failing', async () => {
    const xp = new FakeXpStore();
    const { ctx, logs } = listenerContext({ enabled: true });
    delete ctx.publish;

    await createMessageXpListener({ xp }).handler(messageEvent(), ctx);

    expect(xp.awards).toHaveLength(1);
    expect(logs.some((line) => line.startsWith('warn:') && line.includes('xp.awarded'))).toBe(true);
  });
});
