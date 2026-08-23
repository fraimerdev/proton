import { describe, expect, test } from 'bun:test';
import {
  LEGACY_MEMBER_CONDITION_KINDS,
  type RuleCondition,
  ruleConditionSchema,
} from '../../src/rules/conditions.ts';
import {
  isLegacyMemberCondition,
  LEGACY_CONDITION_PROVIDERS,
  migrateCondition,
  migrateRuleConditions,
} from '../../src/rules/migrate.ts';

const ROLE_A = '600000000000000000';
const ROLE_B = '600000000000000001';

function migrated(condition: RuleCondition) {
  const result = migrateCondition(condition);
  if (result.kind !== 'provider') throw new Error(`${condition.kind} was not migrated`);
  return result;
}

describe('migrateCondition', () => {
  test('every legacy member-scoped kind maps to a core provider', () => {
    const samples: Record<(typeof LEGACY_MEMBER_CONDITION_KINDS)[number], RuleCondition> = {
      'role-has': { kind: 'role-has', roleIds: [ROLE_A] },
      'role-lacks': { kind: 'role-lacks', roleIds: [ROLE_A] },
      'account-age': { kind: 'account-age', operator: 'older-than', duration: '7d' },
      'is-premium': { kind: 'is-premium', tier: 'plus' },
    };

    for (const kind of LEGACY_MEMBER_CONDITION_KINDS) {
      expect(migrated(samples[kind]).providerId).toBe(LEGACY_CONDITION_PROVIDERS[kind]);
    }
  });

  test('role-has carries its roles and match mode across', () => {
    const result = migrated({ kind: 'role-has', roleIds: [ROLE_A, ROLE_B], match: 'all' });

    expect(result.config).toEqual({ roleIds: [ROLE_A, ROLE_B], mode: 'all' });
  });

  test('an omitted match becomes the any it always defaulted to', () => {
    expect(migrated({ kind: 'role-has', roleIds: [ROLE_A] }).config).toEqual({
      roleIds: [ROLE_A],
      mode: 'any',
    });
  });

  test('account-age carries both the operator and the duration', () => {
    const result = migrated({ kind: 'account-age', operator: 'younger-than', duration: '30d' });

    expect(result.config).toEqual({ operator: 'younger-than', duration: '30d' });
  });

  test('an omitted premium tier becomes the plus it always defaulted to', () => {
    expect(migrated({ kind: 'is-premium' }).config).toEqual({ tier: 'plus' });
  });

  test('event-scoped and rule-scoped conditions are left exactly as they are', () => {
    const untouched: RuleCondition[] = [
      { kind: 'channel-in', channelIds: ['500000000000000000'] },
      { kind: 'content-pattern', pattern: 'spam', mode: 'contains' },
      { kind: 'rate-over-window', limit: 5, window: '10s' },
    ];

    for (const condition of untouched) {
      expect(migrateCondition(condition)).toBe(condition);
      expect(isLegacyMemberCondition(condition)).toBe(false);
    }
  });

  test('a provider condition is already migrated and passes through', () => {
    const condition: RuleCondition = {
      kind: 'provider',
      providerId: 'leveling.level',
      config: { min: 5 },
    };

    expect(migrateCondition(condition)).toBe(condition);
  });

  test('what it produces is still a valid stored condition', () => {
    const result = migrateCondition({ kind: 'role-has', roleIds: [ROLE_A], match: 'all' });

    expect(ruleConditionSchema.safeParse(result).success).toBe(true);
  });

  test('migrating a list leaves length and order alone', () => {
    const conditions: RuleCondition[] = [
      { kind: 'channel-in', channelIds: ['500000000000000000'] },
      { kind: 'role-has', roleIds: [ROLE_A] },
      { kind: 'rate-over-window', limit: 2, window: '1m' },
    ];

    const result = migrateRuleConditions(conditions);

    expect(result.map((condition) => condition.kind)).toEqual([
      'channel-in',
      'provider',
      'rate-over-window',
    ]);
  });
});
