import { describe, expect, test } from 'bun:test';
import { DISCORD_EPOCH_MS } from '../../src/ids.ts';
import {
  evaluateFactCondition,
  type FactCondition,
  RULE_CONDITION_KINDS,
  type RuleCondition,
  type RuleConditionKind,
  ruleConditionSchema,
} from '../../src/rules/conditions.ts';
import type { RuleFacts } from '../../src/rules/facts.ts';

const CHANNEL = '500000000000000000';
const OTHER_CHANNEL = '500000000000000001';
const ROLE_A = '600000000000000000';
const ROLE_B = '600000000000000001';

const NOW = Date.parse('2026-08-14T12:00:00.000Z');

/** A user id whose snowflake encodes the given creation time. */
function snowflakeAt(createdAt: number): string {
  return String((BigInt(createdAt) - BigInt(DISCORD_EPOCH_MS)) << 22n);
}

function check(condition: FactCondition, facts: RuleFacts = {}) {
  return evaluateFactCondition(condition, facts, NOW);
}

function reasonOf(result: ReturnType<typeof check>): string {
  return result.passed ? '' : result.humanReason;
}

describe('channel-in', () => {
  const condition: FactCondition = { kind: 'channel-in', channelIds: [CHANNEL, OTHER_CHANNEL] };

  test('passes when the event is in one of the listed channels', () => {
    expect(check(condition, { channelId: CHANNEL }).passed).toBe(true);
  });

  test('fails when the event is somewhere else', () => {
    const result = check(condition, { channelId: '500000000000000009' });
    expect(result.passed).toBe(false);
    expect(reasonOf(result)).toContain('500000000000000009');
  });

  test('fails closed, and says why, when the event has no channel', () => {
    expect(check(condition).passed).toBe(false);
    expect(reasonOf(check(condition))).toContain('outside any channel');
  });
});

describe('role-has', () => {
  test('any (the default) passes on a single held role', () => {
    const condition: FactCondition = { kind: 'role-has', roleIds: [ROLE_A, ROLE_B] };
    expect(check(condition, { roleIds: [ROLE_B] }).passed).toBe(true);
  });

  test('any fails when the member holds none of them', () => {
    const condition: FactCondition = { kind: 'role-has', roleIds: [ROLE_A] };
    expect(check(condition, { roleIds: ['600000000000000009'] }).passed).toBe(false);
  });

  test('all requires every role', () => {
    const condition: FactCondition = { kind: 'role-has', roleIds: [ROLE_A, ROLE_B], match: 'all' };
    expect(check(condition, { roleIds: [ROLE_A, ROLE_B] }).passed).toBe(true);
    expect(check(condition, { roleIds: [ROLE_A] }).passed).toBe(false);
  });

  test('names the intent when roles were never resolved', () => {
    const condition: FactCondition = { kind: 'role-has', roleIds: [ROLE_A] };
    expect(reasonOf(check(condition))).toContain('Server Members intent');
  });
});

/**
 * role-lacks is defined as the exact negation of role-has under the same
 * `match`. If that ever drifts, a member could satisfy neither condition and an
 * autorole rule and its opposite would both decline to fire.
 */
describe('role-lacks', () => {
  test('any is the negation of role-has any', () => {
    const has: FactCondition = { kind: 'role-has', roleIds: [ROLE_A, ROLE_B] };
    const lacks: FactCondition = { kind: 'role-lacks', roleIds: [ROLE_A, ROLE_B] };

    for (const roleIds of [[], [ROLE_A], [ROLE_A, ROLE_B], ['600000000000000009']]) {
      expect(check(lacks, { roleIds }).passed).toBe(!check(has, { roleIds }).passed);
    }
  });

  test('all is the negation of role-has all', () => {
    const has: FactCondition = { kind: 'role-has', roleIds: [ROLE_A, ROLE_B], match: 'all' };
    const lacks: FactCondition = { kind: 'role-lacks', roleIds: [ROLE_A, ROLE_B], match: 'all' };

    for (const roleIds of [[], [ROLE_A], [ROLE_A, ROLE_B]]) {
      expect(check(lacks, { roleIds }).passed).toBe(!check(has, { roleIds }).passed);
    }
  });
});

describe('account-age', () => {
  const younger: FactCondition = {
    kind: 'account-age',
    operator: 'younger-than',
    duration: '7d',
  };

  test('younger-than passes for a fresh account', () => {
    expect(check(younger, { accountCreatedAt: NOW - 86_400_000 }).passed).toBe(true);
  });

  test('younger-than fails for an old account, and quotes its age', () => {
    const result = check(younger, { accountCreatedAt: NOW - 30 * 86_400_000 });
    expect(result.passed).toBe(false);
    expect(reasonOf(result)).toContain('30d');
  });

  test('older-than is the mirror image', () => {
    const older: FactCondition = { kind: 'account-age', operator: 'older-than', duration: '7d' };
    expect(check(older, { accountCreatedAt: NOW - 30 * 86_400_000 }).passed).toBe(true);
    expect(check(older, { accountCreatedAt: NOW - 86_400_000 }).passed).toBe(false);
  });

  /** No API call during a raid: the id already carries the creation time. */
  test('derives the age from the actor snowflake when no timestamp was supplied', () => {
    expect(check(younger, { actorId: snowflakeAt(NOW - 3_600_000) }).passed).toBe(true);
    expect(check(younger, { actorId: snowflakeAt(NOW - 400 * 86_400_000) }).passed).toBe(false);
  });

  test('fails, and says so, when there is nobody to measure', () => {
    expect(reasonOf(check(younger))).toContain('no user id');
  });
});

describe('content-pattern', () => {
  const invite: FactCondition = { kind: 'content-pattern', pattern: 'discord\\.gg/\\w+' };

  test('matches a regex against the content', () => {
    expect(check(invite, { content: 'join discord.gg/proton now' }).passed).toBe(true);
    expect(check(invite, { content: 'nothing to see' }).passed).toBe(false);
  });

  test('is case-insensitive unless asked otherwise', () => {
    expect(check(invite, { content: 'DISCORD.GG/PROTON' }).passed).toBe(true);

    const exact: FactCondition = { ...invite, caseSensitive: true };
    expect(check(exact, { content: 'DISCORD.GG/PROTON' }).passed).toBe(false);
  });

  test('contains mode does a plain substring test', () => {
    const contains: FactCondition = {
      kind: 'content-pattern',
      pattern: 'free nitro',
      mode: 'contains',
    };
    expect(check(contains, { content: 'FREE NITRO here' }).passed).toBe(true);
    // The literal, not a pattern — a regex reading would match anything.
    const dots: FactCondition = { kind: 'content-pattern', pattern: 'a.c', mode: 'contains' };
    expect(check(dots, { content: 'abc' }).passed).toBe(false);
    expect(check(dots, { content: 'a.c' }).passed).toBe(true);
  });

  /**
   * The most common "the bot did nothing" report in this category: the module is
   * enabled, the rule is right, and Message Content was never granted.
   */
  test('names the privileged intent when content is missing', () => {
    expect(reasonOf(check(invite, { actorId: '1' }))).toContain('Message Content');
  });

  test('an empty message is content, not missing content', () => {
    expect(reasonOf(check(invite, { content: '' }))).toContain('does not match');
  });
});

describe('is-premium', () => {
  test('a higher tier satisfies a lower requirement', () => {
    const condition: FactCondition = { kind: 'is-premium', tier: 'plus' };
    expect(check(condition, { entitlement: 'pro' }).passed).toBe(true);
    expect(check(condition, { entitlement: 'plus' }).passed).toBe(true);
    expect(check(condition, { entitlement: 'free' }).passed).toBe(false);
  });

  test('defaults to requiring plus, and treats an unknown tier as free', () => {
    const condition: FactCondition = { kind: 'is-premium' };
    const result = check(condition);
    expect(result.passed).toBe(false);
    expect(reasonOf(result)).toContain('free tier');
    expect(reasonOf(result)).toContain('plus');
  });
});

/**
 * One valid sample per kind, typed as a total record. Adding a predicate to the
 * union without a schema that accepts it fails to compile here — which is the
 * point of naming the vocabulary in the first place.
 */
const SAMPLES: Record<RuleConditionKind, RuleCondition> = {
  'channel-in': { kind: 'channel-in', channelIds: [CHANNEL] },
  'role-has': { kind: 'role-has', roleIds: [ROLE_A] },
  'role-lacks': { kind: 'role-lacks', roleIds: [ROLE_A], match: 'all' },
  'account-age': { kind: 'account-age', operator: 'younger-than', duration: '7d' },
  'content-pattern': { kind: 'content-pattern', pattern: 'spam', mode: 'contains' },
  'rate-over-window': { kind: 'rate-over-window', limit: 5, window: '10s', scope: 'guild' },
  'is-premium': { kind: 'is-premium', tier: 'pro' },
};

describe('ruleConditionSchema', () => {
  test('accepts every advertised kind', () => {
    for (const kind of RULE_CONDITION_KINDS) {
      expect(ruleConditionSchema.safeParse(SAMPLES[kind]).success).toBe(true);
    }
  });

  test('refuses a predicate nobody implemented', () => {
    expect(ruleConditionSchema.safeParse({ kind: 'moon-phase', full: true }).success).toBe(false);
  });

  /**
   * Caught on write rather than at evaluation time: a rule saved with a broken
   * pattern would otherwise sit in the table looking healthy and never fire.
   */
  test('refuses a pattern that is not a valid regex', () => {
    const result = ruleConditionSchema.safeParse({ kind: 'content-pattern', pattern: '([a-z' });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain('not a valid regular expression');
  });

  test('accepts the same broken pattern as a literal substring', () => {
    expect(
      ruleConditionSchema.safeParse({ kind: 'content-pattern', pattern: '([a-z', mode: 'contains' })
        .success,
    ).toBe(true);
  });

  test('refuses a duration it could not act on', () => {
    expect(
      ruleConditionSchema.safeParse({ kind: 'rate-over-window', limit: 5, window: 'soon' }).success,
    ).toBe(false);
  });

  test('refuses a rate limit of one, which is not a rate', () => {
    expect(
      ruleConditionSchema.safeParse({ kind: 'rate-over-window', limit: 1, window: '10s' }).success,
    ).toBe(false);
  });

  test('refuses an id that is not a snowflake', () => {
    expect(ruleConditionSchema.safeParse({ kind: 'role-has', roleIds: ['admin'] }).success).toBe(
      false,
    );
  });
});
