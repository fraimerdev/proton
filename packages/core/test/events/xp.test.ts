import { describe, expect, test } from 'bun:test';
import { isEventType, SERVICE_EMITTED_EVENT_TYPES } from '../../src/events/types.ts';
import {
  causationSchema,
  XP_GRANT_MAX,
  xpAwardedSchema,
  xpGrantedSchema,
  xpGrantRequestedSchema,
  xpLevelGainedSchema,
} from '../../src/events/xp.ts';

const GUILD = '900000000000000001';
const USER = '100000000000000010';
const CHANNEL = '500000000000000001';

const organic = { kind: 'organic', rootId: 'message.created:1', depth: 0 } as const;

const awarded = {
  guildId: GUILD,
  userId: USER,
  amount: 23,
  source: 'message',
  channelId: CHANNEL,
  activityAt: 1_800_000_000_000,
  xp: 1234,
  level: 5,
  causation: organic,
} as const;

const grantRequested = {
  guildId: GUILD,
  userId: USER,
  grantId: `achievements:${GUILD}:${USER}:chatterbox:gold:0`,
  amount: 250,
  reason: 'Earned Chatterbox (Gold).',
  sourceModule: 'achievements',
  originChannelId: CHANNEL,
  causation: {
    kind: 'achievement',
    rootId: 'message.created:1',
    depth: 1,
    sourceModule: 'achievements',
  },
} as const;

describe('the xp event types', () => {
  test('are declared, and none of them is published by a service', () => {
    for (const type of ['xp.awarded', 'xp.grant_requested', 'xp.granted', 'xp.level_gained']) {
      expect(isEventType(type)).toBe(true);
      expect(SERVICE_EMITTED_EVENT_TYPES as readonly string[]).not.toContain(type);
    }
  });
});

describe('causation', () => {
  test('accepts a root with no grant, and a reward chain that names its grant', () => {
    expect(causationSchema.safeParse(organic).success).toBe(true);
    expect(
      causationSchema.safeParse({
        kind: 'reward',
        rootId: 'x',
        depth: 3,
        grantId: 'g',
        sourceModule: 'achievements',
      }).success,
    ).toBe(true);
  });

  test('refuses an unknown kind, a negative or runaway depth and an empty root', () => {
    expect(causationSchema.safeParse({ ...organic, kind: 'magic' }).success).toBe(false);
    expect(causationSchema.safeParse({ ...organic, depth: -1 }).success).toBe(false);
    expect(causationSchema.safeParse({ ...organic, depth: 33 }).success).toBe(false);
    expect(causationSchema.safeParse({ ...organic, depth: 1.5 }).success).toBe(false);
    expect(causationSchema.safeParse({ ...organic, rootId: '' }).success).toBe(false);
  });
});

describe('xp.awarded', () => {
  test('accepts every source, with or without a channel', () => {
    for (const source of ['message', 'voice', 'admin', 'reward'] as const) {
      expect(xpAwardedSchema.safeParse({ ...awarded, source }).success).toBe(true);
    }
    const { channelId: _channelId, ...withoutChannel } = awarded;
    expect(xpAwardedSchema.safeParse(withoutChannel).success).toBe(true);
  });

  test('refuses a zero award, an unknown source and a missing causation', () => {
    expect(xpAwardedSchema.safeParse({ ...awarded, amount: 0 }).success).toBe(false);
    expect(xpAwardedSchema.safeParse({ ...awarded, source: 'bonus' }).success).toBe(false);
    const { causation: _causation, ...uncaused } = awarded;
    expect(xpAwardedSchema.safeParse(uncaused).success).toBe(false);
  });

  test('refuses a channel that is not a snowflake', () => {
    expect(xpAwardedSchema.safeParse({ ...awarded, channelId: 'general' }).success).toBe(false);
  });
});

describe('xp.level_gained', () => {
  const gained = {
    guildId: GUILD,
    userId: USER,
    level: 5,
    previousLevel: 3,
    xp: 1234,
    source: 'voice',
  } as const;

  test('still accepts the payload leveling publishes today, with no channel or causation', () => {
    expect(xpLevelGainedSchema.safeParse(gained).success).toBe(true);
  });

  test('accepts a reward level-up that carries its channel and causation', () => {
    expect(
      xpLevelGainedSchema.safeParse({
        ...gained,
        source: 'reward',
        channelId: CHANNEL,
        causation: grantRequested.causation,
      }).success,
    ).toBe(true);
  });

  test('refuses a negative level', () => {
    expect(xpLevelGainedSchema.safeParse({ ...gained, level: -1 }).success).toBe(false);
  });
});

describe('xp.grant_requested', () => {
  test('accepts a grant up to the ceiling', () => {
    expect(xpGrantRequestedSchema.safeParse(grantRequested).success).toBe(true);
    expect(
      xpGrantRequestedSchema.safeParse({ ...grantRequested, amount: XP_GRANT_MAX }).success,
    ).toBe(true);
  });

  test('refuses nothing, too much, and a fraction', () => {
    expect(xpGrantRequestedSchema.safeParse({ ...grantRequested, amount: 0 }).success).toBe(false);
    expect(
      xpGrantRequestedSchema.safeParse({ ...grantRequested, amount: XP_GRANT_MAX + 1 }).success,
    ).toBe(false);
    expect(xpGrantRequestedSchema.safeParse({ ...grantRequested, amount: 2.5 }).success).toBe(
      false,
    );
  });

  test('refuses an empty grant id or module, and an overlong reason', () => {
    expect(xpGrantRequestedSchema.safeParse({ ...grantRequested, grantId: '' }).success).toBe(
      false,
    );
    expect(xpGrantRequestedSchema.safeParse({ ...grantRequested, sourceModule: '' }).success).toBe(
      false,
    );
    expect(
      xpGrantRequestedSchema.safeParse({ ...grantRequested, reason: 'x'.repeat(201) }).success,
    ).toBe(false);
  });
});

describe('xp.granted', () => {
  const granted = {
    guildId: GUILD,
    userId: USER,
    grantId: grantRequested.grantId,
    sourceModule: 'achievements',
    status: 'granted',
    amount: 250,
    xp: 1484,
    level: 6,
    previousLevel: 5,
  } as const;

  test('accepts a grant and a refusal with its reason', () => {
    expect(xpGrantedSchema.safeParse(granted).success).toBe(true);
    expect(
      xpGrantedSchema.safeParse({
        guildId: GUILD,
        userId: USER,
        grantId: granted.grantId,
        sourceModule: 'achievements',
        status: 'refused',
        amount: 0,
        reason: 'Leveling is off in this server.',
      }).success,
    ).toBe(true);
  });

  test('refuses an unknown status and a negative amount', () => {
    expect(xpGrantedSchema.safeParse({ ...granted, status: 'pending' }).success).toBe(false);
    expect(xpGrantedSchema.safeParse({ ...granted, amount: -1 }).success).toBe(false);
  });

  test('survives a JSON round trip', () => {
    expect(xpGrantedSchema.parse(JSON.parse(JSON.stringify(granted)))).toEqual({ ...granted });
  });
});
