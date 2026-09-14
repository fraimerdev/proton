import { describe, expect, test } from 'bun:test';
import { protonFields } from '@proton/core';
import {
  AFK_RETENTION_MS,
  afkConfigSchema,
  afkDefaultConfig,
  NOTICE_COOLDOWN_MS,
  REASON_MAX,
  RECAP_MAX,
  tidyDelayMs,
} from '../src/config.ts';

const CHANNEL = '500000000000000001';

describe('afkConfigSchema', () => {
  test('an empty config is the hand-written default: off, tagging, tidying after 15s, recapping', () => {
    expect(afkConfigSchema.parse({})).toEqual(afkDefaultConfig);
    expect(afkDefaultConfig).toEqual({
      enabled: false,
      nicknameTag: true,
      tidyReplies: true,
      tidyAfter: '15s',
      recap: true,
      ignoredChannelIds: [],
    });
  });

  test('refuses a tidy delay under 10 seconds, on the field itself', () => {
    const parsed = afkConfigSchema.safeParse({ tidyAfter: '5s' });

    expect(parsed.success).toBe(false);
    expect(parsed.success === false && parsed.error.issues[0]?.path).toEqual(['tidyAfter']);
  });

  test('refuses a tidy delay over 5 minutes', () => {
    const parsed = afkConfigSchema.safeParse({ tidyAfter: '6m' });

    expect(parsed.success).toBe(false);
    expect(parsed.success === false && parsed.error.issues[0]?.message).toContain('10s and 5m');
  });

  test('accepts both ends of the range', () => {
    expect(afkConfigSchema.safeParse({ tidyAfter: '10s' }).success).toBe(true);
    expect(afkConfigSchema.safeParse({ tidyAfter: '5m' }).success).toBe(true);
  });

  test('refuses a tidy delay that is not a duration', () => {
    expect(afkConfigSchema.safeParse({ tidyAfter: 'soon' }).success).toBe(false);
  });

  test('ignored channels must be channel ids, at most 50 of them', () => {
    expect(afkConfigSchema.safeParse({ ignoredChannelIds: [CHANNEL] }).success).toBe(true);
    expect(afkConfigSchema.safeParse({ ignoredChannelIds: ['general'] }).success).toBe(false);
    expect(
      afkConfigSchema.safeParse({ ignoredChannelIds: Array.from({ length: 51 }, () => CHANNEL) })
        .success,
    ).toBe(false);
  });

  test('channels without AFK replies can be threads, forums and media as well as channels', () => {
    expect(protonFields.get(afkConfigSchema.shape.ignoredChannelIds)?.channelTypes).toEqual([
      0, 2, 5, 10, 11, 12, 13, 15, 16,
    ]);
  });
});

describe('tidyDelayMs', () => {
  test('reads the configured delay', () => {
    expect(tidyDelayMs({ tidyAfter: '15s' })).toBe(15_000);
    expect(tidyDelayMs({ tidyAfter: '2m' })).toBe(120_000);
  });

  test('keeps an out-of-range or unreadable stored value inside 10s to 5m', () => {
    expect(tidyDelayMs({ tidyAfter: '1s' })).toBe(10_000);
    expect(tidyDelayMs({ tidyAfter: '1h' })).toBe(300_000);
    expect(tidyDelayMs({ tidyAfter: 'soon' })).toBe(15_000);
  });
});

describe('the limits other agents code against', () => {
  test('hold the values the owner chose', () => {
    expect(REASON_MAX).toBe(100);
    expect(RECAP_MAX).toBe(25);
    expect(NOTICE_COOLDOWN_MS).toBe(60_000);
    expect(AFK_RETENTION_MS).toBe(30 * 24 * 60 * 60 * 1000);
  });
});
