import type { RuleDefinition } from '@proton/core';
import { type AutoroleConfig, autoroleDefaultConfig } from './config.ts';

export function autoroleRuleId(roleId: string): string {
  return `grant-${roleId}`;
}

export function autoroleRules(config: Pick<AutoroleConfig, 'autoroleIds'>): RuleDefinition[] {
  return config.autoroleIds.map((roleId, index) => ({
    id: autoroleRuleId(roleId),
    trigger: { kind: 'event', event: 'member.joined' },

    conditions: [],
    actions: [
      {
        kind: 'add_role',

        payload: { roleId },

        reason: 'Autorole on join',
      },
    ],
    enabled: true,
    priority: index * 10,
  }));
}

export const autorolePresetRules: RuleDefinition[] = autoroleRules(autoroleDefaultConfig);
