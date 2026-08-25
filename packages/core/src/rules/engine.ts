import { type ActionKind, targetsMember } from '../actions/kinds.ts';
import type { ActionExecutor, ActionRequest, ActionResult } from '../actions/types.ts';
import { tryParseDuration } from '../config/duration.ts';
import type { ProtonEvent } from '../events/types.ts';
import type { MemberContextLoader } from '../providers/member-context.ts';
import { memberContextFromRuleFacts } from '../providers/member-context.ts';
import type { ProviderRegistry } from '../providers/registry.ts';
import type { MemberContext } from '../providers/types.ts';
import {
  evaluateFactCondition,
  type FactCondition,
  type FactConditionResult,
  type ProviderCondition,
  type RateOverWindowCondition,
  type RuleCondition,
  type RuleConditionKind,
} from './conditions.ts';
import type { RuleFacts } from './facts.ts';
import { migrateCondition } from './migrate.ts';
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

  providers?: ProviderRegistry;

  // Optional: a rule whose conditions are all event-scoped never needs a member loaded, and the
  // facts a dispatch already carries answer most of the rest without a round trip.
  memberContext?: MemberContextLoader;
}

function isRateCondition(condition: RuleCondition): condition is RateOverWindowCondition {
  return condition.kind === 'rate-over-window';
}

function isProviderCondition(condition: RuleCondition): condition is ProviderCondition {
  return condition.kind === 'provider';
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
    case 'delete_channel':
    case 'edit_channel':
    case 'set_channel_overwrite':
    case 'delete_channel_overwrite':
    case 'create_thread':
    case 'end_poll':
    case 'pin_message':
      return facts.channelId ? { channelId: facts.channelId } : {};

    // Not facts.channelId — that is where the member spoke, not where the rule wants them moved.
    case 'move_member':
      return facts.actorId ? { userId: facts.actorId } : {};

    case 'interaction_reply':
    case 'interaction_followup':
      return {};

    // A restore names the channel or role it is recreating, and an automod rule names itself; no
    // fact can supply either.
    case 'create_channel':
    case 'create_role':
    case 'automod_rule_create':
    case 'automod_rule_update':
    case 'automod_rule_delete':
    case 'giveaway_draw':
      return {};

    case 'create_dm':
      return facts.actorId ? { userId: facts.actorId } : {};
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
    const providerConditions: ProviderCondition[] = [];
    const factConditions: FactCondition[] = [];

    for (const raw of rule.conditions) {
      const condition = migrateCondition(raw);

      if (isRateCondition(condition)) rateConditions.push(condition);
      else if (isProviderCondition(condition)) providerConditions.push(condition);
      else factConditions.push(condition);
    }

    // Cheapest first: pure facts, then providers (which may query), then the rate window (which
    // writes to Redis and must not be counted against a rule the facts already ruled out).
    for (const condition of factConditions) {
      const result = evaluateFactCondition(condition, input.facts, now);
      if (!result.passed) {
        return { passed: false, kind: condition.kind, humanReason: result.humanReason };
      }
    }

    for (const condition of providerConditions) {
      const result = await this.#evaluateProvider(condition, rule, input, now);
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

  async #loadMember(rule: GuildRule, actorId: string): Promise<MemberContext | null> {
    const loader = this.#deps.memberContext;
    if (!loader) return null;

    const loaded = await loader.load(rule.guildId, [actorId]);
    return loaded.get(actorId) ?? null;
  }

  async #evaluateProvider(
    condition: ProviderCondition,
    rule: GuildRule,
    input: RuleFireInput,
    now: number,
  ): Promise<FactConditionResult> {
    const registry = this.#deps.providers;
    if (!registry) {
      return {
        passed: false,
        humanReason:
          `this rule uses the '${condition.providerId}' condition, but no provider registry is ` +
          'wired into this process. The process running rules must construct the RuleEngine ' +
          'with { providers: new ProviderRegistry() }.',
      };
    }

    const provider = registry.condition(condition.providerId);
    if (!provider) {
      return {
        passed: false,
        humanReason:
          `no '${condition.providerId}' condition is loaded — the module that owns it is not ` +
          'running in this deployment, so this rule cannot be judged.',
      };
    }

    const parsed = registry.parseConfig(condition.providerId, condition.config);
    if (!parsed.ok) return { passed: false, humanReason: parsed.humanReason };

    const fromFacts = memberContextFromRuleFacts(rule.guildId, input.facts, new Date(now));
    if (fromFacts === null) {
      return {
        passed: false,
        humanReason:
          'this event named no member, so a member condition could not be judged against it.',
      };
    }

    let result = await provider.evaluate(fromFacts, parsed.config);

    // Only on indeterminate, and only then: the dispatch already carries roles for most events, so
    // loading the member up front would be a REST call on every message automod ever sees.
    if (result.indeterminate && input.facts.actorId) {
      const loaded = await this.#loadMember(rule, input.facts.actorId);
      if (loaded) result = await provider.evaluate(loaded, parsed.config);
    }

    if (result.passed) return { passed: true };

    return { passed: false, humanReason: provider.describeFailure(parsed.config, result, 'en') };
  }

  async #evaluateRate(
    condition: RateOverWindowCondition,
    rule: GuildRule,
    input: RuleFireInput,
    now: number,
  ): Promise<FactConditionResult> {
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
