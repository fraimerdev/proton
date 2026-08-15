import { describe, expect, test } from 'bun:test';
import { ruleDefinitionSchema } from '@proton/core';
import { autoroleDefaultConfig } from '../src/config.ts';
import { autorolePresetRules, autoroleRuleId, autoroleRules } from '../src/rules.ts';

const ROLE_A = '700000000000000001';
const ROLE_B = '700000000000000002';

describe('autorole rule compilation', () => {
  test('compiles one rule per configured role', () => {
    const rules = autoroleRules({ autoroleIds: [ROLE_A, ROLE_B] });

    expect(rules).toHaveLength(2);
    expect(rules.map((r) => r.id)).toEqual([autoroleRuleId(ROLE_A), autoroleRuleId(ROLE_B)]);
  });

  test('each rule carries exactly one add_role naming its own role', () => {
    const [first, second] = autoroleRules({ autoroleIds: [ROLE_A, ROLE_B] });

    expect(first?.actions).toHaveLength(1);
    expect(first?.actions[0]?.kind).toBe('add_role');
    expect(first?.actions[0]?.payload).toEqual({ roleId: ROLE_A });
    expect(second?.actions[0]?.payload).toEqual({ roleId: ROLE_B });
  });

  test('no rule hardcodes a member', () => {
    for (const rule of autoroleRules({ autoroleIds: [ROLE_A, ROLE_B] })) {
      for (const action of rule.actions) {
        expect(action.payload).not.toHaveProperty('userId');
      }
    }
  });

  test('triggers on member.joined with no conditions', () => {
    const [rule] = autoroleRules({ autoroleIds: [ROLE_A] });

    expect(rule?.trigger).toEqual({ kind: 'event', event: 'member.joined' });
    expect(rule?.conditions).toEqual([]);
  });

  test('priorities are deterministic and ascending', () => {
    const rules = autoroleRules({ autoroleIds: [ROLE_A, ROLE_B] });

    expect(rules.map((r) => r.priority)).toEqual([0, 10]);
  });

  test('every compiled rule satisfies the engine’s own schema', () => {
    for (const rule of autoroleRules({ autoroleIds: [ROLE_A, ROLE_B] })) {
      expect(ruleDefinitionSchema.safeParse(rule).success).toBe(true);
    }
  });

  test('ships no rules by default, because there is no sensible default role', () => {
    expect(autorolePresetRules).toEqual([]);
    expect(autoroleDefaultConfig.autoroleIds).toEqual([]);
  });
});
