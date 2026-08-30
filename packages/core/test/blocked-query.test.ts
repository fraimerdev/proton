import { describe, expect, test } from 'bun:test';
import {
  BLOCK_REASON_MAX,
  BLOCKED_PAGE_SIZE_DEFAULT,
  BLOCKED_PAGE_SIZE_MAX,
  blockedEvidenceSchema,
  blockedMemberQuerySchema,
  blockMemberInputSchema,
} from '../src/blocked/query.ts';

const GUILD = '1234567890123456789';
const USER = '9876543210987654321';

function block(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    guildId: GUILD,
    userId: USER,
    moduleId: 'honeypot',
    blockedBy: 'proton:honeypot',
    reason: 'Posted in a honeypot channel.',
    idempotencyKey: 'honeypot:1:2:block',
    ...overrides,
  };
}

describe('blockedMemberQuerySchema', () => {
  test('defaults to the live list, newest first, one page of fifty', () => {
    expect(blockedMemberQuerySchema.parse({})).toEqual({
      state: 'live',
      page: 1,
      pageSize: BLOCKED_PAGE_SIZE_DEFAULT,
      order: 'desc',
    });
  });

  test('refuses a page size above the ceiling rather than clamping it silently', () => {
    expect(blockedMemberQuerySchema.safeParse({ pageSize: BLOCKED_PAGE_SIZE_MAX }).success).toBe(
      true,
    );
    expect(
      blockedMemberQuerySchema.safeParse({ pageSize: BLOCKED_PAGE_SIZE_MAX + 1 }).success,
    ).toBe(false);
  });

  test('reads a query string, where every number arrives as text', () => {
    expect(blockedMemberQuerySchema.parse({ page: '3', pageSize: '10' })).toMatchObject({
      page: 3,
      pageSize: 10,
    });
  });
});

describe('blockMemberInputSchema', () => {
  test('accepts the shape a module writes', () => {
    expect(blockMemberInputSchema.safeParse(block()).success).toBe(true);
  });

  test('refuses a blank reason — a list nobody can read a reason off is not a record', () => {
    expect(blockMemberInputSchema.safeParse(block({ reason: '   ' })).success).toBe(false);
  });

  test('refuses a reason longer than the audit-log field it has to fit', () => {
    expect(
      blockMemberInputSchema.safeParse(block({ reason: 'x'.repeat(BLOCK_REASON_MAX) })).success,
    ).toBe(true);
    expect(
      blockMemberInputSchema.safeParse(block({ reason: 'x'.repeat(BLOCK_REASON_MAX + 1) })).success,
    ).toBe(false);
  });

  test('refuses a write with no idempotency key, because redelivery would re-block', () => {
    const { idempotencyKey: _dropped, ...without } = block();

    expect(blockMemberInputSchema.safeParse(without).success).toBe(false);
  });
});

describe('blockedEvidenceSchema', () => {
  test('carries the two ids that point at what happened, and nothing else', () => {
    expect(Object.keys(blockedEvidenceSchema.shape).sort()).toEqual(['channelId', 'messageId']);
  });

  test('strips anything else offered, so a message body cannot be stored here by accident', () => {
    expect(
      blockedEvidenceSchema.parse({ channelId: GUILD, messageId: USER, content: 'hello' }),
    ).toEqual({ channelId: GUILD, messageId: USER });
  });

  test('refuses an id that is not a snowflake', () => {
    expect(blockedEvidenceSchema.safeParse({ channelId: 'nope', messageId: USER }).success).toBe(
      false,
    );
  });
});
