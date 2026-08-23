import { describe, expect, test } from 'bun:test';
import {
  CHANNEL_NAME_MAX,
  hubFor,
  renderChannelName,
  type TempVcConfig,
  tempVcConfigSchema,
} from '../src/config.ts';
import { planReconcile, planTransition, type TransitionFacts } from '../src/decide.ts';

const HUB = '500000000000000001';
const OTHER_HUB = '500000000000000004';
const TEMP = '500000000000000002';
const ELSEWHERE = '500000000000000005';

const config: TempVcConfig = {
  enabled: true,
  ownerCommands: true,
  hubs: [
    { channelId: HUB, nameTemplate: '{user}’s room', userLimit: 0 },
    { channelId: OTHER_HUB, nameTemplate: '{user} II', userLimit: 4 },
  ],
};

function facts(overrides: Partial<TransitionFacts> = {}): TransitionFacts {
  return {
    transition: { userId: 'u', from: null, to: null },
    fromIsTemp: false,
    fromOccupantsAfter: 0,
    ownedChannelId: null,
    ...overrides,
  };
}

describe('planTransition', () => {
  test('does nothing when the member did not change channel', () => {
    const plan = planTransition(config, facts({ transition: { userId: 'u', from: HUB, to: HUB } }));

    expect(plan.steps).toEqual([]);
  });

  test('joining a hub creates a channel', () => {
    const plan = planTransition(
      config,
      facts({ transition: { userId: 'u', from: null, to: HUB } }),
    );

    expect(plan.steps).toEqual([{ kind: 'create', hub: config.hubs[0] as never }]);
  });

  test('joining the second hub creates from that hub, not the first', () => {
    const plan = planTransition(
      config,
      facts({ transition: { userId: 'u', from: null, to: OTHER_HUB } }),
    );

    expect(plan.steps).toEqual([{ kind: 'create', hub: config.hubs[1] as never }]);
  });

  test('a member who already owns a channel is sent to it instead of getting a second', () => {
    const plan = planTransition(
      config,
      facts({ transition: { userId: 'u', from: null, to: HUB }, ownedChannelId: TEMP }),
    );

    expect(plan.steps).toEqual([{ kind: 'move', channelId: TEMP }]);
  });

  test('leaving a temporary channel that is now empty deletes it', () => {
    const plan = planTransition(
      config,
      facts({
        transition: { userId: 'u', from: TEMP, to: null },
        fromIsTemp: true,
        fromOccupantsAfter: 0,
      }),
    );

    expect(plan.steps).toEqual([{ kind: 'delete', channelId: TEMP }]);
  });

  test('leaving a temporary channel that still has people in it deletes nothing', () => {
    const plan = planTransition(
      config,
      facts({
        transition: { userId: 'u', from: TEMP, to: null },
        fromIsTemp: true,
        fromOccupantsAfter: 2,
      }),
    );

    expect(plan.steps).toEqual([]);
  });

  test('leaving an ordinary channel deletes nothing, however empty it is', () => {
    const plan = planTransition(
      config,
      facts({
        transition: { userId: 'u', from: ELSEWHERE, to: null },
        fromIsTemp: false,
        fromOccupantsAfter: 0,
      }),
    );

    expect(plan.steps).toEqual([]);
  });

  test('leaving your own empty channel for a hub deletes it and then makes a new one', () => {
    const plan = planTransition(
      config,
      facts({
        transition: { userId: 'u', from: TEMP, to: HUB },
        fromIsTemp: true,
        fromOccupantsAfter: 0,
        ownedChannelId: TEMP,
      }),
    );

    expect(plan.steps).toEqual([
      { kind: 'delete', channelId: TEMP },
      { kind: 'create', hub: config.hubs[0] as never },
    ]);
  });

  test('a channel that is being deleted is never also the one you are moved into', () => {
    const plan = planTransition(
      config,
      facts({
        transition: { userId: 'u', from: TEMP, to: HUB },
        fromIsTemp: true,
        fromOccupantsAfter: 0,
        ownedChannelId: TEMP,
      }),
    );

    expect(plan.steps.some((step) => step.kind === 'move')).toBe(false);
  });

  test('an owned channel someone else is still sitting in is reused, not rebuilt', () => {
    const plan = planTransition(
      config,
      facts({
        transition: { userId: 'u', from: TEMP, to: HUB },
        fromIsTemp: true,
        fromOccupantsAfter: 1,
        ownedChannelId: TEMP,
      }),
    );

    expect(plan.steps).toEqual([{ kind: 'move', channelId: TEMP }]);
  });
});

describe('planReconcile', () => {
  test('deletes a temporary channel nobody is in after a reconnect', () => {
    const plan = planReconcile({
      known: [TEMP],
      occupantsByChannel: new Map(),
      liveChannelIds: new Set([TEMP]),
    });

    expect(plan.delete).toEqual([TEMP]);
    expect(plan.forget).toEqual([]);
  });

  test('keeps one that is still occupied and rebuilds its occupancy', () => {
    const plan = planReconcile({
      known: [TEMP],
      occupantsByChannel: new Map([[TEMP, ['a', 'b']]]),
      liveChannelIds: new Set([TEMP]),
    });

    expect(plan.delete).toEqual([]);
    expect(plan.reset).toEqual([{ channelId: TEMP, userIds: ['a', 'b'] }]);
  });

  test('forgets a channel Discord no longer lists rather than deleting it again', () => {
    const plan = planReconcile({
      known: [TEMP],
      occupantsByChannel: new Map(),
      liveChannelIds: new Set([HUB]),
    });

    expect(plan.forget).toEqual([TEMP]);
    expect(plan.delete).toEqual([]);
  });

  test('without a channel list it trusts occupancy alone', () => {
    const plan = planReconcile({
      known: [TEMP],
      occupantsByChannel: new Map(),
      liveChannelIds: null,
    });

    expect(plan.delete).toEqual([TEMP]);
  });
});

describe('renderChannelName', () => {
  test('substitutes the owner', () => {
    expect(renderChannelName('{user}’s room', 'Ada')).toBe('Ada’s room');
  });

  test('substitutes every occurrence', () => {
    expect(renderChannelName('{user} and {user}', 'Ada')).toBe('Ada and Ada');
  });

  test('never exceeds the channel name cap', () => {
    expect(renderChannelName('{user}', 'x'.repeat(500))).toHaveLength(CHANNEL_NAME_MAX);
  });
});

describe('hubFor', () => {
  test('finds nothing for a null channel', () => {
    expect(hubFor(config, null)).toBeUndefined();
  });

  test('finds nothing for a channel that is not a hub', () => {
    expect(hubFor(config, ELSEWHERE)).toBeUndefined();
  });
});

describe('tempVcConfigSchema', () => {
  test('refuses a name template with no placeholder, because every channel would share a name', () => {
    const parsed = tempVcConfigSchema.safeParse({
      hubs: [{ channelId: HUB, nameTemplate: 'Voice' }],
    });

    expect(parsed.success).toBe(false);
  });

  test('refuses two hubs on the same channel', () => {
    const parsed = tempVcConfigSchema.safeParse({
      hubs: [{ channelId: HUB }, { channelId: HUB }],
    });

    expect(parsed.success).toBe(false);
  });

  test('defaults leave the module off with no hubs', () => {
    expect(tempVcConfigSchema.parse({})).toEqual({
      enabled: false,
      ownerCommands: true,
      hubs: [],
    });
  });
});
