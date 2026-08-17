import { type ActionKind, targetsMember } from '../actions/kinds.ts';
import type { ActionExecutor, ActionRequest, ActionResult } from '../actions/types.ts';
import { tryParseDuration } from '../config/duration.ts';
import type { ProtonEvent } from '../events/types.ts';
import {
  type ConditionResult,
  evaluateFactCondition,
  type FactCondition,
  type RateOverWindowCondition,
  type RuleCondition,
  type RuleConditionKind,
} from './conditions.ts';
import type { RuleFacts } from './facts.ts';
import { RATE_WINDOW_GUILD_SCOPE, type RateWindowStore } from './rate-window.ts';
import { type GuildRule, guildRuleSchema, type RuleAction } from './types.ts';

export const RULE_ENGINE_ACTOR = 'proton:rule-engine';

export type RuleSkipCode =
  | 'disabled'
  | 'wrong-guild'
  | 'invalid-rule'
  | 'condition-failed'
  | 'no-guild';

export interface RuleSkip {
  code: RuleSkipCode;

  humanReason: string;

  conditionKind?: RuleConditionKind;
}

export interface RuleActionOutcome {
  index: number;
  kind: ActionKind;
  idempotencyKey: string;

  result?: ActionResult;

  error?: string;
}

export interface RuleOutcome {
  ruleId: string;
  moduleId: string;
  fired: boolean;
  skipped?: RuleSkip;
  actions: RuleActionOutcome[];
}

export interface RuleEvaluationReport {
  eventId: string;
  outcomes: RuleOutcome[];
}

export interface RuleFireInput {
  event: ProtonEvent;
  facts: RuleFacts;

  dryRun: boolean;
}

export interface RuleEvaluationInput extends RuleFireInput {
  rules: readonly GuildRule[];
}

export interface RuleEngineDeps {
  executor: ActionExecutor;
  rateWindow: RateWindowStore;
  now?: () => number;
}

function isRateCondition(condition: RuleCondition): condition is RateOverWindowCondition {
  return condition.kind === 'rate-over-window';
}

function payloadDefaults(kind: ActionKind, facts: RuleFacts): Record<string, unknown> {
  switch (kind) {
    case 'ban':
    case 'unban':
    case 'kick':
    case 'timeout':
    case 'untimeout':
    case 'add_role':
    case 'remove_role':
      return facts.actorId ? { userId: facts.actorId } : {};

    case 'warn':
      return facts.actorId ? { userId: facts.actorId } : {};

    case 'send':
    case 'purge':
    case 'slowmode':
    case 'lockdown':
    case 'unlock':
      return facts.channelId ? { channelId: facts.channelId } : {};

    case 'edit_message':
    case 'delete_message':
    case 'add_reaction':
      return facts.channelId ? { channelId: facts.channelId } : {};

    case 'interaction_reply':
    case 'interaction_followup':
      return {};

    // A restore names the channel or role it is recreating; no fact can supply one.
    case 'create_channel':
    case 'create_role':
      return {};
  }
}

type BuiltRequest = { request: ActionRequest } | { error: string };

export class RuleEngine {
  readonly #deps: RuleEngineDeps;
  readonly #now: () => number;

  constructor(deps: RuleEngineDeps) {
    this.#deps = deps;
    this.#now = deps.now ?? (() => Date.now());
  }

  async evaluate(input: RuleEvaluationInput): Promise<RuleEvaluationReport> {
    const now = this.#now();
    const guildId = input.event.guildId;
    const outcomes: RuleOutcome[] = [];

    const candidates: GuildRule[] = [];
    for (const rule of input.rules) {
      const parsed = guildRuleSchema.safeParse(rule);
      if (!parsed.success) {
        outcomes.push(
          this.#skip(rule, {
            code: 'invalid-rule',
            humanReason: `this rule is not valid and was not evaluated: ${parsed.error.issues
              .map((issue) => `${issue.path.map(String).join('.') || 'rule'} ${issue.message}`)
              .join('; ')}`,
          }),
        );
        continue;
      }

      const valid = parsed.data;
      if (valid.trigger.kind !== 'event' || valid.trigger.event !== input.event.type) continue;

      if (guildId === null) {
        outcomes.push(
          this.#skip(valid, {
            code: 'no-guild',
            humanReason:
              'this event did not happen in a guild (a DM or a global interaction), so no guild rule applies to it.',
          }),
        );
        continue;
      }

      if (valid.guildId !== guildId) {
        outcomes.push(
          this.#skip(valid, {
            code: 'wrong-guild',
            humanReason: `this rule belongs to guild ${valid.guildId} but the event came from ${guildId}, so it was not evaluated.`,
          }),
        );
        continue;
      }

      if (!valid.enabled) {
        outcomes.push(this.#skip(valid, { code: 'disabled', humanReason: 'this rule is off.' }));
        continue;
      }

      candidates.push(valid);
    }

    candidates.sort(
      (a, b) =>
        a.priority - b.priority || a.moduleId.localeCompare(b.moduleId) || a.id.localeCompare(b.id),
    );

    for (const rule of candidates) {
      outcomes.push(await this.fire(rule, input, now));
    }

    return { eventId: input.event.id, outcomes };
  }

  async fire(
    rule: GuildRule,
    input: RuleFireInput,
    now: number = this.#now(),
  ): Promise<RuleOutcome> {
    let conditions: ConditionOutcome;
    try {
      conditions = await this.#evaluateConditions(rule, input, now);
    } catch (error) {
      return this.#skip(rule, {
        code: 'condition-failed',
        humanReason: `a condition could not be evaluated: ${
          error instanceof Error ? error.message : String(error)
        }`,
      });
    }

    if (!conditions.passed) {
      return this.#skip(rule, {
        code: 'condition-failed',
        humanReason: `the ${conditions.kind} condition did not match: ${conditions.humanReason}`,
        conditionKind: conditions.kind,
      });
    }

    const actions: RuleActionOutcome[] = [];
    for (const [index, action] of rule.actions.entries()) {
      const built = this.#buildRequest(rule, action, index, input, now);
      if ('error' in built) {
        actions.push({
          index,
          kind: action.kind,
          idempotencyKey: idempotencyKey(input.event, rule, index),
          error: built.error,
        });
        continue;
      }

      try {
        const result = await this.#deps.executor.execute(built.request);
        actions.push({
          index,
          kind: action.kind,
          idempotencyKey: built.request.idempotencyKey,
          result,
        });
      } catch (error) {
        actions.push({
          index,
          kind: action.kind,
          idempotencyKey: built.request.idempotencyKey,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return { ruleId: rule.id, moduleId: rule.moduleId, fired: true, actions };
  }

  #skip(rule: { id: string; moduleId: string }, skip: RuleSkip): RuleOutcome {
    return { ruleId: rule.id, moduleId: rule.moduleId, fired: false, skipped: skip, actions: [] };
  }

  async #evaluateConditions(
    rule: GuildRule,
    input: RuleFireInput,
    now: number,
  ): Promise<ConditionOutcome> {
    const rateConditions: RateOverWindowCondition[] = [];
    const factConditions: FactCondition[] = [];
    for (const condition of rule.conditions) {
      if (isRateCondition(condition)) rateConditions.push(condition);
      else factConditions.push(condition);
    }

    for (const condition of factConditions) {
      const result = evaluateFactCondition(condition, input.facts, now);
      if (!result.passed) {
        return { passed: false, kind: condition.kind, humanReason: result.humanReason };
      }
    }

    for (const condition of rateConditions) {
      const result = await this.#evaluateRate(condition, rule, input, now);
      if (!result.passed) {
        return { passed: false, kind: condition.kind, humanReason: result.humanReason };
      }
    }

    return { passed: true };
  }

  async #evaluateRate(
    condition: RateOverWindowCondition,
    rule: GuildRule,
    input: RuleFireInput,
    now: number,
  ): Promise<ConditionResult> {
    const windowMs = tryParseDuration(condition.window);
    if (windowMs === null) {
      return { passed: false, humanReason: `'${condition.window}' is not a duration I can read.` };
    }

    const scope = condition.scope ?? 'actor';
    const actorId = scope === 'guild' ? RATE_WINDOW_GUILD_SCOPE : input.facts.actorId;
    if (!actorId) {
      return {
        passed: false,
        humanReason:
          'this event carried no user id, so there is nobody to count this rate window against.',
      };
    }

    const { count, tripped } = await this.#deps.rateWindow.hit({
      guildId: rule.guildId,

      ruleId: `${rule.moduleId}:${rule.id}`,
      actorId,
      windowMs,
      limit: condition.limit,
      member: input.event.id,
      now,
    });

    return tripped
      ? { passed: true }
      : {
          passed: false,
          humanReason: `${count} of ${condition.limit} within ${condition.window} — the window has not been crossed.`,
        };
  }

  #buildRequest(
    rule: GuildRule,
    action: RuleAction,
    index: number,
    input: RuleFireInput,
    now: number,
  ): BuiltRequest {
    const payload: Record<string, unknown> = {
      ...payloadDefaults(action.kind, input.facts),
      ...action.payload,
    };

    let expiresAt: Date | undefined;
    if (action.duration !== undefined) {
      const ms = tryParseDuration(action.duration);
      if (ms === null) return { error: `'${action.duration}' is not a duration I can read.` };

      if (action.kind === 'timeout') {
        payload.until = new Date(now + ms);
      } else {
        expiresAt = new Date(now + ms);
      }
    }

    const targetId = targetsMember(action.kind) ? input.facts.actorId : undefined;

    return {
      request: {
        guildId: rule.guildId,
        moduleId: rule.moduleId,
        kind: action.kind,
        actorId: RULE_ENGINE_ACTOR,
        ...(targetId ? { targetId } : {}),
        ...(action.reason ? { reason: action.reason } : {}),
        payload,
        ...(expiresAt ? { expiresAt } : {}),
        dryRun: input.dryRun,
        idempotencyKey: idempotencyKey(input.event, rule, index),
      },
    };
  }
}

type ConditionOutcome =
  | { passed: true }
  | { passed: false; kind: RuleConditionKind; humanReason: string };

function idempotencyKey(event: ProtonEvent, rule: GuildRule, index: number): string {
  return `rule:${event.id}:${rule.moduleId}:${rule.id}:${index}`;
}
