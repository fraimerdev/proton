import type { ProviderCondition, RuleCondition } from './conditions.ts';

export const LEGACY_CONDITION_PROVIDERS = {
  'role-has': 'core.has_role',
  'role-lacks': 'core.lacks_role',
  'account-age': 'core.account_age',
  'is-premium': 'core.is_premium',
} as const;

function providerFor(condition: RuleCondition): ProviderCondition | null {
  switch (condition.kind) {
    case 'role-has':
      return {
        kind: 'provider',
        providerId: LEGACY_CONDITION_PROVIDERS['role-has'],
        config: { roleIds: condition.roleIds, mode: condition.match ?? 'any' },
      };

    case 'role-lacks':
      return {
        kind: 'provider',
        providerId: LEGACY_CONDITION_PROVIDERS['role-lacks'],
        config: { roleIds: condition.roleIds, mode: condition.match ?? 'any' },
      };

    case 'account-age':
      return {
        kind: 'provider',
        providerId: LEGACY_CONDITION_PROVIDERS['account-age'],
        config: { operator: condition.operator, duration: condition.duration },
      };

    case 'is-premium':
      return {
        kind: 'provider',
        providerId: LEGACY_CONDITION_PROVIDERS['is-premium'],
        config: { tier: condition.tier ?? 'plus' },
      };

    default:
      return null;
  }
}

// Read-side only, per PLAN.md I5: nothing rewrites rules.conditions in place, so a guild that
// saved a rule under the old spelling keeps working and a rule saved today is already migrated.
export function migrateCondition(condition: RuleCondition): RuleCondition {
  return providerFor(condition) ?? condition;
}

export function migrateRuleConditions(conditions: readonly RuleCondition[]): RuleCondition[] {
  return conditions.map(migrateCondition);
}

export function isLegacyMemberCondition(condition: RuleCondition): boolean {
  return providerFor(condition) !== null;
}
