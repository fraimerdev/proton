import { describe, expect, test } from 'bun:test';
import type { ProtonEvent } from '@proton/core';
import type { LevelingConfig } from '../src/config.ts';
import type { LevelingDeps } from '../src/deps.ts';
import { createXpGrantListener, LEVELING_OFF_REASON } from '../src/xp-grant.ts';
import {
  capturePublishes,
  FakeXpStore,
  GUILD,
  listenerContext,
  type Published,
  type Recorded,
  USER,
} from './fakes.ts';

const CHANNEL = '300000000000000002';
const ROLE_ONE = '400000000000000001';
const ROLE_TWO = '400000000000000002';
const GRANT_ID = `achievements:${GUILD}:${USER}:chatterbox:gold:0`;
const AT = Date.parse('2026-09-19T12:00:00.000Z');

const REQUEST_CAUSATION = {
  kind: 'achievement',
  rootId: `message.created:${GUILD}:500000000000000001`,
  depth: 1,
} as const;

const REWARD_CAUSATION = {
  kind: 'reward',
  rootId: REQUEST_CAUSATION.rootId,
  depth: 1,
  grantId: GRANT_ID,
  sourceModule: 'achievements',
};

function grantEvent(payload: Record<string, unknown> = {}): ProtonEvent {
  return {
    id: `xp.grant_requested:${GUILD}:${GRANT_ID}`,
    type: 'xp.grant_requested',
    guildId: GUILD,
    occurredAt: AT,
    payload: {
      guildId: GUILD,
      userId: USER,
      grantId: GRANT_ID,
      amount: 250,
      reason: 'Earned Chatterbox (Gold).',
      sourceModule: 'achievements',
      originChannelId: CHANNEL,
      causation: REQUEST_CAUSATION,
      ...payload,
    },
  };
}

function seeded(xp: number): FakeXpStore {
  return new FakeXpStore().seed(GUILD, {
    userId: USER,
    xp,
    level: 0,
    rank: 1,
    messageCount: 3,
    voiceSeconds: 0,
  });
}

async function run(
  config: Partial<LevelingConfig>,
  deps: LevelingDeps,
  events: ProtonEvent[],
): Promise<Recorded & { published: Published[] }> {
  const recorded = listenerContext({
    enabled: true,
    roleRewards: [
      { level: 1, roleId: ROLE_ONE },
      { level: 2, roleId: ROLE_TWO },
    ],
    ...config,
  });
  const published = capturePublishes(recorded.ctx);
  const listener = createXpGrantListener(deps);

  for (const event of events) await listener.handler(event, recorded.ctx);
  return { ...recorded, published };
}

function keysOf(recorded: Recorded, kind: string): string[] {
  return recorded.sent
    .filter((request) => request.kind === kind)
    .map((request) => request.idempotencyKey);
}

describe('xp.grant_requested', () => {
  test('a grant credits the member and levels them up as a reward', async () => {
    const xp = seeded(50);
    const { published, sent } = await run({}, { xp }, [grantEvent()]);

    expect(xp.grants).toHaveLength(1);
    expect(xp.grants[0]).toMatchObject({
      guildId: GUILD,
      userId: USER,
      amount: 250,
      grantId: GRANT_ID,
      sourceModule: 'achievements',
      causation: REQUEST_CAUSATION,
      now: AT,
    });

    expect(published).toEqual([
      {
        type: 'xp.level_gained',
        key: `${GUILD}:${USER}:2`,
        payload: {
          guildId: GUILD,
          userId: USER,
          level: 2,
          previousLevel: 0,
          xp: 300,
          source: 'reward',
          channelId: CHANNEL,
          causation: REWARD_CAUSATION,
        },
      },
      {
        type: 'xp.awarded',
        key: `grant:${GRANT_ID}`,
        payload: {
          guildId: GUILD,
          userId: USER,
          amount: 250,
          source: 'reward',
          channelId: CHANNEL,
          activityAt: AT,
          xp: 300,
          level: 2,
          causation: REWARD_CAUSATION,
        },
      },
      {
        type: 'xp.granted',
        key: GRANT_ID,
        payload: {
          guildId: GUILD,
          userId: USER,
          grantId: GRANT_ID,
          sourceModule: 'achievements',
          status: 'granted',
          amount: 250,
          xp: 300,
          level: 2,
          previousLevel: 0,
        },
      },
    ]);

    const send = sent.find((request) => request.kind === 'send');
    expect(send?.idempotencyKey).toBe(`leveling:grant:${GRANT_ID}:level-up`);
    expect(send?.payload).toMatchObject({ channelId: CHANNEL });
  });

  test('a replayed grant credits once, gives the level roles once and says the same things again', async () => {
    const xp = seeded(50);
    const recorded = await run({}, { xp }, [grantEvent(), grantEvent()]);

    expect(xp.ledger.size).toBe(1);
    expect((await xp.get(GUILD, USER))?.xp).toBe(300);

    const roleKeys = keysOf(recorded, 'add_role');
    expect(new Set(roleKeys)).toEqual(
      new Set([
        `leveling:grant:${GRANT_ID}:add_role:${ROLE_ONE}`,
        `leveling:grant:${GRANT_ID}:add_role:${ROLE_TWO}`,
      ]),
    );
    expect(roleKeys).toHaveLength(4);

    const [first, second] = [recorded.published.slice(0, 3), recorded.published.slice(3)];
    expect(second).toEqual(first);
    expect(first.map((entry) => entry.type)).toEqual([
      'xp.level_gained',
      'xp.awarded',
      'xp.granted',
    ]);
  });

  test('a grant that crosses no level still answers and reports the XP', async () => {
    const xp = seeded(300);
    const { published, sent } = await run({}, { xp }, [grantEvent({ amount: 10 })]);

    expect(published.map((entry) => entry.type)).toEqual(['xp.awarded', 'xp.granted']);
    expect(published[1]?.payload).toMatchObject({ status: 'granted', xp: 310, level: 2 });
    expect(sent).toEqual([]);
  });

  test('a reward level-up with nowhere to post announces nothing and publishes no channel', async () => {
    const xp = seeded(50);
    const event = grantEvent();
    const { originChannelId: _dropped, ...payload } = event.payload as Record<string, unknown>;

    const { published, sent } = await run({}, { xp }, [{ ...event, payload }]);

    expect(sent.some((request) => request.kind === 'send')).toBe(false);
    expect(published[0]?.payload).not.toHaveProperty('channelId');
    expect(published[1]?.payload).not.toHaveProperty('channelId');
  });

  test('with Leveling off the grant is refused, and nothing is credited or given', async () => {
    const xp = seeded(50);
    const { published, sent } = await run({ enabled: false }, { xp }, [grantEvent()]);

    expect(xp.grants).toEqual([]);
    expect(sent).toEqual([]);
    expect(published).toEqual([
      {
        type: 'xp.granted',
        key: `${GRANT_ID}:refused`,
        payload: {
          guildId: GUILD,
          userId: USER,
          grantId: GRANT_ID,
          sourceModule: 'achievements',
          status: 'refused',
          amount: 0,
          reason: LEVELING_OFF_REASON,
        },
      },
    ]);
  });

  test('a process built without the XP store refuses and names the port it needs', async () => {
    const { published, logs } = await run({}, {}, [grantEvent()]);

    expect(published).toHaveLength(1);
    expect(published[0]?.payload).toMatchObject({
      status: 'refused',
      amount: 0,
      reason: expect.stringContaining('xp: new DrizzleMemberXpStore'),
    });
    expect(logs.some((line) => line.startsWith('error:') && line.includes('xp:'))).toBe(true);
  });

  test('a request it cannot read gives nothing and answers nothing', async () => {
    const xp = seeded(50);
    const { published, logs } = await run({}, { xp }, [grantEvent({ amount: 0 })]);

    expect(xp.grants).toEqual([]);
    expect(published).toEqual([]);
    expect(logs.some((line) => line.startsWith('error:'))).toBe(true);
  });

  test('a request naming another server is ignored', async () => {
    const xp = seeded(50);
    const { published } = await run({}, { xp }, [grantEvent({ guildId: '100000000000000099' })]);

    expect(xp.grants).toEqual([]);
    expect(published).toEqual([]);
  });

  test('a store failure is thrown so the request is delivered again, with nothing said', async () => {
    const xp = seeded(50);
    xp.grant = async () => {
      throw new Error('postgres is down');
    };

    const recorded = listenerContext({ enabled: true });
    const published = capturePublishes(recorded.ctx);

    await expect(createXpGrantListener({ xp }).handler(grantEvent(), recorded.ctx)).rejects.toThrow(
      'postgres is down',
    );
    expect(published).toEqual([]);
    expect(recorded.logs.some((line) => line.includes('postgres is down'))).toBe(true);
  });
});
