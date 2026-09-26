import type { RuleCondition, RuleDefinition } from '@proton/core';
import {
  type EscalationAction,
  type EscalationRung,
  type ModerationConfig,
  moderationDefaultConfig,
} from './config.ts';
import type { PunishConfig } from './punish/config.ts';

export function escalationRuleId(rung: EscalationRung): string {
  return `escalate-at-${rung.atWarnings}`;
}

export function escalationImmuneRoles(
  punish: Pick<PunishConfig, 'immunity'> | undefined,
  action: EscalationAction,
): string[] {
  if (!punish) return [];
  return [...new Set([...punish.immunity.global, ...punish.immunity[action]])];
}

export function escalationRules(
  config: Pick<ModerationConfig, 'escalationLadder' | 'escalationWindow'> & {
    punish?: Pick<PunishConfig, 'immunity'>;
  },
): RuleDefinition[] {
  return config.escalationLadder.map((rung, index) => {
    const immune = escalationImmuneRoles(config.punish, rung.action);
    const conditions: RuleCondition[] = [
      { kind: 'rate-over-window', limit: rung.atWarnings, window: config.escalationWindow },
      ...(immune.length > 0 ? [{ kind: 'role-lacks' as const, roleIds: immune }] : []),
    ];

    return {
      id: escalationRuleId(rung),
      trigger: { kind: 'event', event: 'moderation.warned' },
      conditions,
      actions: [
        {
          kind: rung.action,

          reason: `Warning ${rung.atWarnings} within ${config.escalationWindow} (automatic escalation)`,
          ...(rung.duration !== undefined ? { duration: rung.duration } : {}),
        },
      ],
      enabled: true,

      priority: index * 10,
    };
  });
}

export const moderationPresetRules: RuleDefinition[] = escalationRules(moderationDefaultConfig);
