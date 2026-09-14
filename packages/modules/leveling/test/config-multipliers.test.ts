import { describe, expect, test } from 'bun:test';
import { protonFields, snowflakeSchema } from '@proton/core';
import fc from 'fast-check';
import {
  channelMultiplierSchema,
  LEVELING_SCHEMA_VERSION,
  levelingConfigSchema,
  levelingDefaultConfig,
  levelingFormSchema,
  XP_EVENT_MAX_DURATION_MS,
  XP_EVENT_MAX_LEAD_MS,
  XP_EVENT_MAX_PENDING,
  XP_EVENT_MIN_DURATION_MS,
  XP_EVENT_START_GRACE_MS,
  XP_MULTIPLIER_LIST_MAX,
  XP_MULTIPLIER_MAX,
  XP_MULTIPLIER_MIN,
  XP_MULTIPLIER_STEP,
  xpEventBoundsIssue,
  xpEventCreateSchema,
  xpEventCreateSchemaAt,
  xpEventViewSchema,
  xpMultiplierSchema,
} from '../src/config.ts';
import { toXpEventView } from '../src/xp-events.ts';
import { xpEvent } from './fakes.ts';

const ROLE = '400000000000000001';
const CHANNEL = '300000000000000002';
const NOW = Date.parse('2026-09-13T12:00:00.000Z');
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

function roleIds(count: number): string[] {
  return Array.from(
    { length: count },
    (_, index) => `4000000000000${String(index).padStart(5, '0')}`,
  );
}

describe('multiplier config', () => {
  test('the constants describe 0× to 5× in steps of 0.1, 50 entries a list', () => {
    expect([
      XP_MULTIPLIER_MIN,
      XP_MULTIPLIER_MAX,
      XP_MULTIPLIER_STEP,
      XP_MULTIPLIER_LIST_MAX,
    ]).toEqual([0, 5, 0.1, 50]);
  });

  test('both lists default to empty', () => {
    const parsed = levelingConfigSchema.parse({});

    expect(parsed.roleMultipliers).toEqual([]);
    expect(parsed.channelMultipliers).toEqual([]);
    expect(levelingDefaultConfig.roleMultipliers).toEqual([]);
    expect(levelingDefaultConfig.channelMultipliers).toEqual([]);
  });

  test('a config stored before multipliers existed still parses, unchanged otherwise', () => {
    const { roleMultipliers: _r, channelMultipliers: _c, ...stored } = levelingDefaultConfig;
    const withRewards = { ...stored, enabled: true, roleRewards: [{ level: 5, roleId: ROLE }] };

    const parsed = levelingConfigSchema.parse(withRewards);

    expect(parsed.roleMultipliers).toEqual([]);
    expect(parsed.channelMultipliers).toEqual([]);
    expect(parsed.roleRewards).toEqual([{ level: 5, roleId: ROLE }]);
    expect(LEVELING_SCHEMA_VERSION).toBe(4);
  });

  test('0 and 5 are allowed, anything outside them is not', () => {
    expect(xpMultiplierSchema.safeParse(0).success).toBe(true);
    expect(xpMultiplierSchema.safeParse(5).success).toBe(true);
    expect(xpMultiplierSchema.safeParse(-0.1).success).toBe(false);
    expect(xpMultiplierSchema.safeParse(5.1).success).toBe(false);
  });

  test('every tenth from 0 to 5 is accepted, floating point notwithstanding', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 50 }), (tenths) => {
        expect(xpMultiplierSchema.safeParse(tenths * 0.1).success).toBe(true);
      }),
    );
  });

  test('a value between tenths is refused', () => {
    expect(xpMultiplierSchema.safeParse(0.15).success).toBe(false);
    expect(xpMultiplierSchema.safeParse(1.25).success).toBe(false);
    expect(xpMultiplierSchema.safeParse(0.3).success).toBe(true);
  });

  test('a role listed twice is refused at the second entry', () => {
    const result = levelingConfigSchema.safeParse({
      roleMultipliers: [
        { roleId: ROLE, multiplier: 2 },
        { roleId: ROLE, multiplier: 3 },
      ],
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(['roleMultipliers', 1, 'roleId']);
  });

  test('a channel listed twice is refused at the second entry', () => {
    const result = levelingConfigSchema.safeParse({
      channelMultipliers: [
        { channelId: CHANNEL, multiplier: 0 },
        { channelId: CHANNEL, multiplier: 1 },
      ],
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(['channelMultipliers', 1, 'channelId']);
  });

  test('the same id may appear once in each list', () => {
    const result = levelingConfigSchema.safeParse({
      roleMultipliers: [{ roleId: ROLE, multiplier: 2 }],
      channelMultipliers: [{ channelId: ROLE, multiplier: 2 }],
    });

    expect(result.success).toBe(true);
  });

  test('a list longer than 50 is refused', () => {
    const entries = (count: number) => roleIds(count).map((roleId) => ({ roleId, multiplier: 2 }));

    expect(levelingConfigSchema.safeParse({ roleMultipliers: entries(50) }).success).toBe(true);
    expect(levelingConfigSchema.safeParse({ roleMultipliers: entries(51) }).success).toBe(false);
  });

  test('the form schema leaves both lists to the hand-written page', () => {
    expect(Object.keys(levelingFormSchema.shape)).not.toContain('roleMultipliers');
    expect(Object.keys(levelingFormSchema.shape)).not.toContain('channelMultipliers');
  });

  test('a channel entry can name a category, forum, media, voice or stage channel', () => {
    expect(protonFields.get(channelMultiplierSchema.shape.channelId)).toMatchObject({
      field: 'channel-id',
      channelTypes: expect.arrayContaining([0, 2, 4, 5, 13, 15, 16]),
    });
  });

  test('registering the entry fields leaves the shared snowflake schema alone', () => {
    expect(protonFields.get(snowflakeSchema)).toBeUndefined();
  });
});

describe('XP event contract', () => {
  test('the limits are the ones the owner set', () => {
    expect(XP_EVENT_MAX_PENDING).toBe(5);
    expect(XP_EVENT_MIN_DURATION_MS).toBe(10 * MINUTE);
    expect(XP_EVENT_MAX_DURATION_MS).toBe(14 * DAY);
    expect(XP_EVENT_MAX_LEAD_MS).toBe(30 * DAY);
  });

  test('an event starting now for two hours is in bounds', () => {
    expect(xpEventBoundsIssue({ startsAt: NOW, endsAt: NOW + 120 * MINUTE }, NOW)).toBeNull();
  });

  test('shorter than 10 minutes or longer than 14 days is refused on endsAt', () => {
    expect(xpEventBoundsIssue({ startsAt: NOW, endsAt: NOW + 9 * MINUTE }, NOW)?.path).toBe(
      'endsAt',
    );
    expect(xpEventBoundsIssue({ startsAt: NOW, endsAt: NOW + 14 * DAY + 1 }, NOW)?.path).toBe(
      'endsAt',
    );
    expect(xpEventBoundsIssue({ startsAt: NOW, endsAt: NOW + 14 * DAY }, NOW)).toBeNull();
  });

  test('more than 30 days ahead is refused on startsAt', () => {
    const startsAt = NOW + 30 * DAY + 1;
    expect(xpEventBoundsIssue({ startsAt, endsAt: startsAt + DAY }, NOW)?.path).toBe('startsAt');
  });

  test('a start slightly behind the clock is a clock, one well behind it is the past', () => {
    const behind = NOW - XP_EVENT_START_GRACE_MS;
    expect(xpEventBoundsIssue({ startsAt: behind, endsAt: behind + DAY }, NOW)).toBeNull();

    const past = NOW - XP_EVENT_START_GRACE_MS - 1;
    expect(xpEventBoundsIssue({ startsAt: past, endsAt: past + DAY }, NOW)?.path).toBe('startsAt');
  });

  test('the create schema checks shape; the dated schema adds the bounds', () => {
    const input = {
      multiplier: 1.5,
      startsAt: new Date(NOW).toISOString(),
      endsAt: new Date(NOW + 5 * MINUTE).toISOString(),
    };

    expect(xpEventCreateSchema.safeParse(input).success).toBe(true);

    const dated = xpEventCreateSchemaAt(NOW).safeParse(input);
    expect(dated.success).toBe(false);
    expect(dated.error?.issues[0]?.path).toEqual(['endsAt']);
  });

  test('an event multiplier is 0.1 to 5 in tenths — 0 is not an event', () => {
    const at = (multiplier: number) =>
      xpEventCreateSchema.safeParse({
        multiplier,
        startsAt: new Date(NOW).toISOString(),
        endsAt: new Date(NOW + DAY).toISOString(),
      }).success;

    expect(at(0.1)).toBe(true);
    expect(at(5)).toBe(true);
    expect(at(0)).toBe(false);
    expect(at(0.25)).toBe(false);
  });

  test('a stored event renders as a view the schema accepts, with its status', () => {
    const active = toXpEventView(xpEvent({ startsAt: NOW - MINUTE, endsAt: NOW + MINUTE }), NOW);
    const scheduled = toXpEventView(xpEvent({ startsAt: NOW + MINUTE, endsAt: NOW + DAY }), NOW);
    const ended = toXpEventView(xpEvent({ startsAt: NOW - DAY, endsAt: NOW }), NOW);

    expect(xpEventViewSchema.parse(active).status).toBe('active');
    expect(xpEventViewSchema.parse(scheduled).status).toBe('scheduled');
    expect(ended).toBeNull();
  });
});
