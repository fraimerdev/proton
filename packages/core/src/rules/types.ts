import { z } from 'zod';
import { ACTION_KINDS } from '../actions/kinds.ts';
import { snowflakeSchema } from '../actions/payloads.ts';
import { durationStringSchema } from '../config/duration.ts';
import { EVENT_TYPES } from '../events/types.ts';
import { ruleConditionSchema } from './conditions.ts';

export const ruleTriggerSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('event'), event: z.enum(EVENT_TYPES) }),
  z.object({ kind: z.literal('cron'), cron: z.string().min(1), timezone: z.string().optional() }),
]);

export type RuleTrigger = z.infer<typeof ruleTriggerSchema>;

export const ruleActionSchema = z.object({
  kind: z.enum(ACTION_KINDS),
  reason: z.string().max(512).optional(),

  duration: durationStringSchema.optional(),

  payload: z.record(z.string(), z.unknown()).optional(),
});

export type RuleAction = z.infer<typeof ruleActionSchema>;

const ruleShape = {
  id: z.string().min(1),
  trigger: ruleTriggerSchema,
  conditions: z.array(ruleConditionSchema),
  actions: z.array(ruleActionSchema).min(1),

  enabled: z.boolean(),

  priority: z.number().int(),
};

function atMostOneRateCondition(rule: { conditions: { kind: string }[] }): boolean {
  return rule.conditions.filter((c) => c.kind === 'rate-over-window').length <= 1;
}

const RATE_CONDITION_MESSAGE =
  'a rule may hold at most one rate-over-window condition — its counter is keyed by ' +
  '(guild, rule, actor), so a second one would share the first window. Split it into two rules.';

export const ruleDefinitionSchema = z.object(ruleShape).refine(atMostOneRateCondition, {
  path: ['conditions'],
  message: RATE_CONDITION_MESSAGE,
});

export type RuleDefinition = z.infer<typeof ruleDefinitionSchema>;

export const guildRuleSchema = z
  .object({
    ...ruleShape,
    guildId: snowflakeSchema,
    moduleId: z.string().min(1),
  })
  .refine(atMostOneRateCondition, { path: ['conditions'], message: RATE_CONDITION_MESSAGE });

export type GuildRule = z.infer<typeof guildRuleSchema>;

export interface ScheduledJob {
  id: string;

  cron: string;
  timezone?: string;

  payload?: Record<string, unknown>;
}
