import { describe, expect, test } from 'bun:test';
import { starboardMessagePostedSchema } from '../../src/events/starboard.ts';
import { isEventType, SERVICE_EMITTED_EVENT_TYPES } from '../../src/events/types.ts';

const posted = {
  guildId: '900000000000000001',
  sourceMessageId: '700000000000000001',
  sourceChannelId: '500000000000000001',
  authorId: '100000000000000010',
  authorBot: false,
  boardMessageId: '700000000000000002',
  starCount: 5,
  activityAt: 1_800_000_000_000,
} as const;

describe('starboard.message_posted', () => {
  test('is a declared event type a module publishes, not a service', () => {
    expect(isEventType('starboard.message_posted')).toBe(true);
    expect(SERVICE_EMITTED_EVENT_TYPES as readonly string[]).not.toContain(
      'starboard.message_posted',
    );
  });

  test('accepts a post, including one of a bot’s message', () => {
    expect(starboardMessagePostedSchema.safeParse(posted).success).toBe(true);
    expect(starboardMessagePostedSchema.safeParse({ ...posted, authorBot: true }).success).toBe(
      true,
    );
  });

  test('refuses a missing author, a negative count and a non-snowflake board message', () => {
    const { authorId: _authorId, ...anonymous } = posted;
    expect(starboardMessagePostedSchema.safeParse(anonymous).success).toBe(false);
    expect(starboardMessagePostedSchema.safeParse({ ...posted, starCount: -1 }).success).toBe(
      false,
    );
    expect(
      starboardMessagePostedSchema.safeParse({ ...posted, boardMessageId: 'board' }).success,
    ).toBe(false);
  });

  test('refuses an activity time that is not a whole number', () => {
    expect(starboardMessagePostedSchema.safeParse({ ...posted, activityAt: '2026' }).success).toBe(
      false,
    );
  });
});
