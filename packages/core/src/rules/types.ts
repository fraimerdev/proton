import { z } from 'zod';
import { ACTION_KINDS } from '../actions/kinds.ts';
import { snowflakeSchema } from '../actions/payloads.ts';
import { durationStringSchema } from '../config/duration.ts';
import { EVENT_TYPES } from '../events/types.ts';
import { ruleConditionSchema } from './conditions.ts';

/**
 * The rule data model (PLAN.md §4-P2, §6 `rules`).
 *
 * Data only — no engine, no closures. Everything here has to survive a round
 * trip through JSONB and back, because a manifest-declared preset rule and a
 * rule a guild admin builds in the dashboard later must be the same shape; a
 * preset carrying a function could never be stored, edited or diffed.
 *
 * Zod first and types derived, because rules are read back out of a JSONB
 * column that an older build may have written. "It came from our own table"
 * is not a guarantee of shape, so every rule is validated on load (the I5
 * argument, applied to rules rather than config).
 */

/** Triggers are event types plus cron (§4-P2). Cron rules belong to the scheduler. */
export const ruleTriggerSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('event'), event: z.enum(EVENT_TYPES) }),
  z.object({ kind: z.literal('cron'), cron: z.string().min(1), timezone: z.string().optional() }),
]);

export type RuleTrigger = z.infer<typeof ruleTriggerSchema>;

/** Actions are `ActionExecutor` kinds (§4-P2); the engine builds the ActionRequest. */
export const ruleActionSchema = z.object({
  kind: z.enum(ACTION_KINDS),
  reason: z.string().max(512).optional(),
  /**
   * How long the action lasts, e.g. `'30m'`.
   *
   * For a `timeout` this becomes Discord's own expiry; for other reversible
   * kinds it becomes `expiresAt` and the reversal scheduler lifts it (P1.C).
   */
  duration: durationStringSchema.optional(),
  /**
   * Fields the engine cannot infer — the role to add, the message to send. The
   * engine fills the target from the event's facts, so a preset never has to
   * (and cannot) hardcode a user or channel id.
   */
  payload: z.record(z.string(), z.unknown()).optional(),
});

export type RuleAction = z.infer<typeof ruleActionSchema>;

const ruleShape = {
  /** Unique within the declaring module; `(module_id, id)` keys the stored row. */
  id: z.string().min(1),
  trigger: ruleTriggerSchema,
  conditions: z.array(ruleConditionSchema),
  actions: z.array(ruleActionSchema).min(1),
  /** A preset may ship switched off, e.g. an escalation ladder a guild opts into. */
  enabled: z.boolean(),
  /** Lower runs first. Matters when two rules act on the same event. */
  priority: z.number().int(),
};

/**
 * A rate window is keyed by `(guildId, ruleId, actorId)` — PLAN.md §4-P2 is
 * specific about that — so two rate conditions inside one rule would share one
 * counter and silently corrupt each other's arithmetic. Refused at the schema
 * rather than papered over with a key nobody else knows how to compute.
 */
function atMostOneRateCondition(rule: { conditions: { kind: string }[] }): boolean {
  return rule.conditions.filter((c) => c.kind === 'rate-over-window').length <= 1;
}

const RATE_CONDITION_MESSAGE =
  'a rule may hold at most one rate-over-window condition — its counter is keyed by ' +
  '(guild, rule, actor), so a second one would share the first window. Split it into two rules.';

/** One row of §6's `rules` table, minus the columns the engine assigns per guild. */
export const ruleDefinitionSchema = z.object(ruleShape).refine(atMostOneRateCondition, {
  path: ['conditions'],
  message: RATE_CONDITION_MESSAGE,
});

export type RuleDefinition = z.infer<typeof ruleDefinitionSchema>;

/**
 * A rule as it exists for a guild: §6's `rules` row in full.
 *
 * `moduleId` is what the engine puts on the `ActionRequest`, so the case ledger
 * attributes every automatic action to the module whose rule caused it.
 */
export const guildRuleSchema = z
  .object({
    ...ruleShape,
    guildId: snowflakeSchema,
    moduleId: z.string().min(1),
  })
  .refine(atMostOneRateCondition, { path: ['conditions'], message: RATE_CONDITION_MESSAGE });

export type GuildRule = z.infer<typeof guildRuleSchema>;

/** A recurring job a module declares; the scheduler (P1.C) owns execution. */
export interface ScheduledJob {
  /** Unique within the declaring module; `(module_id, id)` keys the schedule. */
  id: string;
  /** Cron expression, evaluated in `timezone` (UTC when unset). */
  cron: string;
  timezone?: string;
  /** Opaque data handed back when the job fires; stored as JSONB. */
  payload?: Record<string, unknown>;
}
