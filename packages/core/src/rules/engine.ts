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

/**
 * `ActionRequest.actorId` for anything a rule did.
 *
 * Not a snowflake, on the same reasoning as `AUTO_REVERSAL_ACTOR`: nobody
 * pressed a button. Attributing an automod ban to the member who happened to
 * trigger it — or to the admin who once enabled the rule — would misread in the
 * case ledger and in the dashboard as a person having done it by hand.
 */
export const RULE_ENGINE_ACTOR = 'proton:rule-engine';

export type RuleSkipCode =
  | 'disabled'
  | 'wrong-guild'
  | 'invalid-rule'
  | 'condition-failed'
  | 'no-guild';

export interface RuleSkip {
  code: RuleSkipCode;
  /** Names what stopped the rule — the dashboard's "why didn't this fire" answer. */
  humanReason: string;
  /** Which predicate refused, when one did. */
  conditionKind?: RuleConditionKind;
}

export interface RuleActionOutcome {
  index: number;
  kind: ActionKind;
  idempotencyKey: string;
  /** Absent when the request could not even be built, or the executor threw. */
  result?: ActionResult;
  /** Why this action never reached the executor, or how it blew up. */
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
  /** I12: the caller decides, so development runs presets dry without a fork. */
  dryRun: boolean;
}

export interface RuleEvaluationInput extends RuleFireInput {
  /** The guild's rules. Cron-triggered ones are ignored here — see `evaluate`. */
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

/**
 * Payload fields the engine knows how to fill from the event.
 *
 * A preset cannot hardcode the offender or the channel — it is written once and
 * runs in every guild — so the engine supplies the target and the rule supplies
 * only what is genuinely its own (which role, what message). Anything the rule
 * *does* state wins, so `send` can name a mod-log channel instead of the one the
 * message arrived in.
 *
 * Deliberately not a template language: `{{user.id}}` interpolation is the rule
 * builder's problem, and inventing the syntax now would fix it before there is a
 * UI to argue with.
 */
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

    /**
     * These name a specific message, and `RuleFacts` deliberately does not carry
     * one — it describes who and where, not which message, because most events a
     * rule triggers on have no message at all. A rule that edits, deletes or
     * reacts to something must say which something in its own `payload`, the
     * same way `add_role` must name the role.
     */
    case 'edit_message':
    case 'delete_message':
    case 'add_reaction':
      return facts.channelId ? { channelId: facts.channelId } : {};

    // An interaction reply or follow-up needs a token nothing in an event can supply.
    case 'interaction_reply':
    case 'interaction_followup':
      return {};
  }
}

type BuiltRequest = { request: ActionRequest } | { error: string };

/**
 * The rule engine (PLAN.md §4-P2).
 *
 * One engine for automod, anti-nuke, autorole, level rewards, welcome, raid
 * detection and custom responders: an event arrives, the rules whose trigger
 * matches are evaluated in priority order, and those whose conditions all hold
 * dispatch their actions through the `ActionExecutor` (I1). The engine issues no
 * REST call and holds no Discord client of its own.
 */
export class RuleEngine {
  readonly #deps: RuleEngineDeps;
  readonly #now: () => number;

  constructor(deps: RuleEngineDeps) {
    this.#deps = deps;
    this.#now = deps.now ?? (() => Date.now());
  }

  /**
   * Decide which rules fire for this event and run their actions.
   *
   * Only `event` triggers are considered; a cron rule belongs to the scheduler,
   * which calls `fire` with the rule it woke up for. Nothing throws: one broken
   * rule must not silence every other rule for the guild, so failures land in
   * the report and evaluation continues.
   */
  async evaluate(input: RuleEvaluationInput): Promise<RuleEvaluationReport> {
    const now = this.#now();
    const guildId = input.event.guildId;
    const outcomes: RuleOutcome[] = [];

    const candidates: GuildRule[] = [];
    for (const rule of input.rules) {
      const parsed = guildRuleSchema.safeParse(rule);
      if (!parsed.success) {
        // Reported even when the trigger does not match: a rule nobody can parse
        // is broken for every event, and one that vanishes quietly is the failure
        // mode this whole engine is meant to make impossible.
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
        // Loading someone else's rules is a bug in the caller, not a config
        // mistake — never silently acted on (I6's argument, applied here).
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

    // Lower priority first (§4-P2). Ties break on module and id so two rules at
    // the same priority always run in the same order — an escalation ladder that
    // reordered itself between deploys would be untestable.
    candidates.sort(
      (a, b) =>
        a.priority - b.priority || a.moduleId.localeCompare(b.moduleId) || a.id.localeCompare(b.id),
    );

    for (const rule of candidates) {
      outcomes.push(await this.fire(rule, input, now));
    }

    return { eventId: input.event.id, outcomes };
  }

  /**
   * Evaluate one already-selected rule's conditions and run its actions.
   *
   * Separate from `evaluate` because the scheduler will call it directly for a
   * cron rule, where there is no event to match a trigger against. The rule is
   * assumed to have been validated already — `evaluate` parses before it gets
   * here, and a caller arriving directly should parse with `guildRuleSchema`
   * rather than have every message pay for a second parse.
   */
  async fire(
    rule: GuildRule,
    input: RuleFireInput,
    now: number = this.#now(),
  ): Promise<RuleOutcome> {
    let conditions: ConditionOutcome;
    try {
      conditions = await this.#evaluateConditions(rule, input, now);
    } catch (error) {
      // Redis being down must not stop the other rules; it also must not look
      // like the rule simply did not match.
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
        // One action failing does not cancel the rest of the ladder: a ban that
        // 500s must not also suppress the mod-log message explaining it.
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

  /**
   * All conditions must hold (they are ANDed; alternation is the rule builder's
   * job later). Evaluation short-circuits on the first refusal.
   *
   * Fact conditions run before the rate condition regardless of the order they
   * were written in, because hitting the window has a side effect: a counter
   * that also counted the messages the rule's own filters would have rejected is
   * measuring the wrong population, and an author cannot be expected to know
   * that ordering carries that much weight.
   */
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
      // Rule ids are unique per module, not globally, so two modules could each
      // ship a rule called 'spam' and share a counter.
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
        // Discord lifts a timeout itself at `until`, so scheduling a reversal
        // would queue an untimeout for a member who is already free.
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

/**
 * Derived from the event id, so a redelivered event produces the same key and
 * the executor discards the second attempt (I4). The rule and action index are
 * in there because one event legitimately causes several distinct actions.
 */
function idempotencyKey(event: ProtonEvent, rule: GuildRule, index: number): string {
  return `rule:${event.id}:${rule.moduleId}:${rule.id}:${index}`;
}
