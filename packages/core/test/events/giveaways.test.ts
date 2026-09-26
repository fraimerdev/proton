import { describe, expect, test } from 'bun:test';
import {
  giveawayDropClaimedEventSchema,
  giveawayEnteredEventSchema,
} from '../../src/events/giveaways.ts';
import { isEventType, SERVICE_EMITTED_EVENT_TYPES } from '../../src/events/types.ts';

const base = {
  guildId: '900000000000000001',
  giveawayId: '01J8Z0000000000000000000GA',
  shortCode: '7X29',
  title: 'Nitro Classic',
  channelId: '500000000000000001',
  hostId: '100000000000000002',
} as const;

const entered = {
  ...base,
  userId: '100000000000000010',
  totalEntries: 3,
  activityAt: 1_800_000_000_000,
} as const;

const claimed = { ...base, userId: '100000000000000010', activityAt: 1_800_000_000_000 } as const;

describe('giveaways.entered and giveaways.drop_claimed', () => {
  test('are declared event types a module publishes', () => {
    for (const type of ['giveaways.entered', 'giveaways.drop_claimed']) {
      expect(isEventType(type)).toBe(true);
      expect(SERVICE_EMITTED_EVENT_TYPES as readonly string[]).not.toContain(type);
    }
  });
});

describe('giveaways.entered', () => {
  test('accepts an entry, including one on a giveaway created before short codes', () => {
    expect(giveawayEnteredEventSchema.safeParse(entered).success).toBe(true);
    expect(giveawayEnteredEventSchema.safeParse({ ...entered, shortCode: null }).success).toBe(
      true,
    );
  });

  test('refuses an entry with no entries, no member or a non-snowflake member', () => {
    expect(giveawayEnteredEventSchema.safeParse({ ...entered, totalEntries: 0 }).success).toBe(
      false,
    );
    const { userId: _userId, ...nobody } = entered;
    expect(giveawayEnteredEventSchema.safeParse(nobody).success).toBe(false);
    expect(giveawayEnteredEventSchema.safeParse({ ...entered, userId: 'fraimer' }).success).toBe(
      false,
    );
  });

  test('survives a JSON round trip', () => {
    expect(giveawayEnteredEventSchema.parse(JSON.parse(JSON.stringify(entered)))).toEqual({
      ...entered,
    });
  });
});

describe('giveaways.drop_claimed', () => {
  test('accepts a claim', () => {
    expect(giveawayDropClaimedEventSchema.safeParse(claimed).success).toBe(true);
  });

  test('refuses a claim with no activity time or no giveaway', () => {
    const { activityAt: _activityAt, ...timeless } = claimed;
    expect(giveawayDropClaimedEventSchema.safeParse(timeless).success).toBe(false);
    expect(giveawayDropClaimedEventSchema.safeParse({ ...claimed, giveawayId: '' }).success).toBe(
      false,
    );
  });
});
