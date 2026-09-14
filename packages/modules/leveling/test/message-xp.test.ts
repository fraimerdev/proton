import { describe, expect, test } from 'bun:test';
import type { ProtonEvent } from '@proton/core';
import type { LevelingConfig } from '../src/config.ts';
import type { LevelingDeps } from '../src/deps.ts';
import { createMessageXpListener } from '../src/message-xp.ts';
import {
  FakeXpEventStore,
  FakeXpStore,
  GUILD,
  guildStateOf,
  listenerContext,
  USER,
  xpEvent,
} from './fakes.ts';

const CATEGORY = '300000000000000001';
const CHANNEL = '300000000000000002';
const THREAD = '300000000000000003';
const ROLE = '400000000000000001';
const ROLE_B = '400000000000000002';
const AT = Date.parse('2026-09-13T12:00:00.000Z');
const MINUTE = 60_000;

const PARENTS = { [THREAD]: CHANNEL, [CHANNEL]: CATEGORY, [CATEGORY]: null };

function messageEvent(options: { channelId?: string; roles?: string[] | null } = {}): ProtonEvent {
  const roles = options.roles === undefined ? [] : options.roles;

  return {
    id: 'message-event-1',
    type: 'message.created',
    guildId: GUILD,
    occurredAt: AT,
    payload: {
      id: '500000000000000001',
      channel_id: options.channelId ?? CHANNEL,
      author: { id: USER },
      type: 0,
      ...(roles === null ? {} : { member: { roles } }),
    },
  };
}

async function award(
  config: Partial<LevelingConfig>,
  event: ProtonEvent,
  deps: LevelingDeps = {},
): Promise<{ amount: number | null; logs: string[] }> {
  const xp = new FakeXpStore();
  const { ctx, logs } = listenerContext({
    enabled: true,
    xpPerMessageMin: 10,
    xpPerMessageMax: 10,
    ...config,
  });

  await createMessageXpListener({ xp, ...deps }).handler(event, ctx);
  return { amount: xp.awards[0]?.amount ?? null, logs };
}

describe('message XP multipliers', () => {
  test('with no multiplier the roll is awarded as it was', async () => {
    expect((await award({}, messageEvent())).amount).toBe(10);
  });

  test('a held role multiplies the roll', async () => {
    const { amount } = await award(
      { roleMultipliers: [{ roleId: ROLE, multiplier: 2 }] },
      messageEvent({ roles: [ROLE] }),
    );

    expect(amount).toBe(20);
  });

  test('a role the member does not hold does nothing', async () => {
    const { amount } = await award(
      { roleMultipliers: [{ roleId: ROLE, multiplier: 2 }] },
      messageEvent({ roles: [ROLE_B] }),
    );

    expect(amount).toBe(10);
  });

  test('a multiplier on @everyone applies to every member', async () => {
    const { amount } = await award(
      { roleMultipliers: [{ roleId: GUILD, multiplier: 1.5 }] },
      messageEvent({ roles: [] }),
    );

    expect(amount).toBe(15);
  });

  test('the message’s own channel multiplies the roll', async () => {
    const { amount } = await award(
      { channelMultipliers: [{ channelId: CHANNEL, multiplier: 1.5 }] },
      messageEvent(),
    );

    expect(amount).toBe(15);
  });

  test('a category entry covers a channel inside it', async () => {
    const { amount } = await award(
      { channelMultipliers: [{ channelId: CATEGORY, multiplier: 3 }] },
      messageEvent(),
      { guildState: guildStateOf(PARENTS) },
    );

    expect(amount).toBe(30);
  });

  test('a channel entry covers its threads, and the category covers them too', async () => {
    const parent = await award(
      { channelMultipliers: [{ channelId: CHANNEL, multiplier: 2 }] },
      messageEvent({ channelId: THREAD }),
      { guildState: guildStateOf(PARENTS) },
    );
    const category = await award(
      { channelMultipliers: [{ channelId: CATEGORY, multiplier: 4 }] },
      messageEvent({ channelId: THREAD }),
      { guildState: guildStateOf(PARENTS) },
    );

    expect(parent.amount).toBe(20);
    expect(category.amount).toBe(40);
  });

  test('without guild state only the exact channel counts', async () => {
    const { amount } = await award(
      { channelMultipliers: [{ channelId: CATEGORY, multiplier: 3 }] },
      messageEvent(),
    );

    expect(amount).toBe(10);
  });

  test('guild state that cannot be read falls back to the exact channel and says so', async () => {
    const { amount, logs } = await award(
      { channelMultipliers: [{ channelId: CATEGORY, multiplier: 3 }] },
      messageEvent(),
      {
        guildState: {
          get: async () => {
            throw new Error('redis is down');
          },
        },
      },
    );

    expect(amount).toBe(10);
    expect(logs.some((line) => line.startsWith('warn:') && line.includes('redis is down'))).toBe(
      true,
    );
  });

  test('an event running at the message time multiplies the roll', async () => {
    const events = new FakeXpEventStore().seed(
      xpEvent({ startsAt: AT - MINUTE, endsAt: AT + MINUTE, multiplier: 2 }),
    );

    expect((await award({}, messageEvent(), { xpEvents: events })).amount).toBe(20);
  });

  test('an event that has ended or not yet started does nothing', async () => {
    const events = new FakeXpEventStore().seed(
      xpEvent({ startsAt: AT - 10 * MINUTE, endsAt: AT, multiplier: 3 }),
      xpEvent({ startsAt: AT + 1, endsAt: AT + MINUTE, multiplier: 4 }),
    );

    expect((await award({}, messageEvent(), { xpEvents: events })).amount).toBe(10);
  });

  test('a 0× role blocks XP even during an event, as an exclusion does', async () => {
    const events = new FakeXpEventStore().seed(
      xpEvent({ startsAt: AT - MINUTE, endsAt: AT + MINUTE, multiplier: 5 }),
    );

    const { amount } = await award(
      { roleMultipliers: [{ roleId: ROLE, multiplier: 0 }] },
      messageEvent({ roles: [ROLE] }),
      { xpEvents: events },
    );

    expect(amount).toBeNull();
  });

  test('a 0× channel blocks XP however high a role multiplier is', async () => {
    const { amount } = await award(
      {
        roleMultipliers: [{ roleId: ROLE, multiplier: 5 }],
        channelMultipliers: [{ channelId: CHANNEL, multiplier: 0 }],
      },
      messageEvent({ roles: [ROLE] }),
    );

    expect(amount).toBeNull();
  });

  test('the highest multiplier wins instead of stacking', async () => {
    const events = new FakeXpEventStore().seed(
      xpEvent({ startsAt: AT - MINUTE, endsAt: AT + MINUTE, multiplier: 1.5 }),
    );

    const { amount } = await award(
      {
        roleMultipliers: [
          { roleId: ROLE, multiplier: 2 },
          { roleId: ROLE_B, multiplier: 0.5 },
        ],
        channelMultipliers: [{ channelId: CHANNEL, multiplier: 3 }],
      },
      messageEvent({ roles: [ROLE, ROLE_B] }),
      { xpEvents: events },
    );

    expect(amount).toBe(30);
  });

  test('the scaled roll is rounded to the nearest whole XP', async () => {
    const { amount } = await award(
      {
        xpPerMessageMin: 15,
        xpPerMessageMax: 15,
        roleMultipliers: [{ roleId: ROLE, multiplier: 1.5 }],
      },
      messageEvent({ roles: [ROLE] }),
    );

    expect(amount).toBe(23);
  });

  test('a multiplier small enough to round to nothing still pays 1', async () => {
    const { amount } = await award(
      {
        xpPerMessageMin: 3,
        xpPerMessageMax: 3,
        roleMultipliers: [{ roleId: ROLE, multiplier: 0.1 }],
      },
      messageEvent({ roles: [ROLE] }),
    );

    expect(amount).toBe(1);
  });

  test('a payload without a member has no roles, so no role multiplier applies', async () => {
    const { amount } = await award(
      { roleMultipliers: [{ roleId: ROLE, multiplier: 4 }] },
      messageEvent({ roles: null }),
    );

    expect(amount).toBe(10);
  });

  test('XP events that cannot be read cost the event, not the award', async () => {
    const broken = new FakeXpEventStore();
    broken.overlapping = async () => {
      throw new Error('postgres is down');
    };

    const { amount, logs } = await award({}, messageEvent(), { xpEvents: broken });

    expect(amount).toBe(10);
    expect(logs.some((line) => line.includes('postgres is down'))).toBe(true);
  });
});
