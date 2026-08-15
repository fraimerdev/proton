import type { RuleDefinition } from '@proton/core';
import { type CasesConfig, casesDefaultConfig, type EscalationRung } from './config.ts';

export function escalationRuleId(rung: EscalationRung): string {
  return `escalate-at-${rung.atWarnings}`;
}

export function escalationRules(
  config: Pick<CasesConfig, 'escalationLadder' | 'escalationWindow'>,
): RuleDefinition[] {
  return config.escalationLadder.map((rung, index) => ({
    id: escalationRuleId(rung),
    trigger: { kind: 'event', event: 'moderation.warned' },
    conditions: [
      { kind: 'rate-over-window', limit: rung.atWarnings, window: config.escalationWindow },
    ],
    actions: [
      {
        kind: rung.action,

        reason: `Warning ${rung.atWarnings} within ${config.escalationWindow} — automatic escalation`,
        ...(rung.duration !== undefined ? { duration: rung.duration } : {}),
      },
    ],
    enabled: true,

    priority: index * 10,
  }));
}

export const casesPresetRules: RuleDefinition[] = escalationRules(casesDefaultConfig);
