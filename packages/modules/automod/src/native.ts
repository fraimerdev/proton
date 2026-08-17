import {
  AUTOMOD_ACTION_BLOCK_MESSAGE,
  AUTOMOD_ACTION_SEND_ALERT,
  AUTOMOD_EVENT_MESSAGE_SEND,
  AUTOMOD_MAX_KEYWORDS,
  AUTOMOD_MAX_REGEX_PATTERNS,
  AUTOMOD_PRESET_PROFANITY,
  AUTOMOD_PRESET_SEXUAL_CONTENT,
  AUTOMOD_PRESET_SLURS,
  AUTOMOD_TRIGGER_KEYWORD,
  AUTOMOD_TRIGGER_KEYWORD_PRESET,
  AUTOMOD_TRIGGER_MENTION_SPAM,
  AUTOMOD_TRIGGER_SPAM,
  type AutomodRuleAction,
  type AutomodTriggerMetadata,
} from '@proton/core';
import { z } from 'zod';
import type { AutomodConfig, KeywordPreset } from './config.ts';
import { splitPatterns } from './regex-compat.ts';

export const PROTON_RULE_PREFIX = 'Proton: ';

export const RULE_NAMES = {
  keywords: `${PROTON_RULE_PREFIX}blocked words`,
  presets: `${PROTON_RULE_PREFIX}word presets`,
  mentions: `${PROTON_RULE_PREFIX}mention spam`,
  spam: `${PROTON_RULE_PREFIX}spam`,
} as const;

const PRESET_IDS: Record<KeywordPreset, 1 | 2 | 3> = {
  profanity: AUTOMOD_PRESET_PROFANITY,
  sexualContent: AUTOMOD_PRESET_SEXUAL_CONTENT,
  slurs: AUTOMOD_PRESET_SLURS,
};

export interface DesiredRule {
  name: string;
  triggerType: number;
  eventType: number;
  triggerMetadata: AutomodTriggerMetadata;
  actions: AutomodRuleAction[];
  enabled: boolean;
  exemptRoles: string[];
  exemptChannels: string[];
}

export interface PatternNote {
  pattern: string;
  reason: string;
}

export interface NativePlan {
  desired: DesiredRule[];
  // Patterns Discord's engine will not run. Proton runs every pattern itself regardless, so these
  // are still enforced — the list exists so the dashboard can say which half is doing it.
  inHousePatterns: PatternNote[];
}

/**
 * Native rules block and alert; they never time out, kick or ban.
 *
 * Discord's TIMEOUT action would put a second, invisible punishment ladder next to the severity
 * responses on the same page, and only KEYWORD and MENTION_SPAM can carry it — so the same word
 * list would punish differently depending on which rule it landed in. Punishment stays in one
 * place: the execution event Discord sends back is handled like any other automod hit.
 */
function actionsFor(config: AutomodConfig): AutomodRuleAction[] {
  const actions: AutomodRuleAction[] = [
    { type: AUTOMOD_ACTION_BLOCK_MESSAGE, customMessage: 'Blocked by this server’s automod.' },
  ];

  if (config.alertChannelId) {
    actions.push({ type: AUTOMOD_ACTION_SEND_ALERT, channelId: config.alertChannelId });
  }

  return actions;
}

export function planNativeRules(config: AutomodConfig): NativePlan {
  const plan: NativePlan = { desired: [], inHousePatterns: [] };
  if (!config.enabled) return plan;

  const actions = actionsFor(config);
  const shared = {
    eventType: AUTOMOD_EVENT_MESSAGE_SEND,
    actions,
    enabled: true,
    exemptRoles: config.exemptRoleIds,
    exemptChannels: config.exemptChannelIds,
  };

  const patterns = splitPatterns(config.regexPatterns, AUTOMOD_MAX_REGEX_PATTERNS);
  plan.inHousePatterns = patterns.inHouse;

  const keywords = config.blockedWords.slice(0, AUTOMOD_MAX_KEYWORDS);
  if (keywords.length > 0 || patterns.native.length > 0) {
    plan.desired.push({
      ...shared,
      name: RULE_NAMES.keywords,
      triggerType: AUTOMOD_TRIGGER_KEYWORD,
      triggerMetadata: {
        keywordFilter: keywords,
        regexPatterns: patterns.native,
        allowList: config.allowedWords,
      },
    });
  }

  if (config.presets.length > 0) {
    plan.desired.push({
      ...shared,
      name: RULE_NAMES.presets,
      triggerType: AUTOMOD_TRIGGER_KEYWORD_PRESET,
      triggerMetadata: {
        presets: config.presets.map((preset) => PRESET_IDS[preset]),
        allowList: config.allowedWords,
      },
    });
  }

  if (config.mentionLimit > 0) {
    plan.desired.push({
      ...shared,
      name: RULE_NAMES.mentions,
      triggerType: AUTOMOD_TRIGGER_MENTION_SPAM,
      triggerMetadata: { mentionTotalLimit: config.mentionLimit },
    });
  }

  if (config.nativeSpam) {
    plan.desired.push({
      ...shared,
      name: RULE_NAMES.spam,
      triggerType: AUTOMOD_TRIGGER_SPAM,
      triggerMetadata: {},
    });
  }

  return plan;
}

const rawActionSchema = z.object({
  type: z.number().int(),
  metadata: z
    .object({
      custom_message: z.string().optional(),
      channel_id: z.string().optional(),
      duration_seconds: z.number().optional(),
    })
    .optional(),
});

const rawRuleSchema = z.object({
  id: z.string(),
  name: z.string(),
  creator_id: z.string().nullish(),
  event_type: z.number().int(),
  trigger_type: z.number().int(),
  trigger_metadata: z
    .object({
      keyword_filter: z.array(z.string()).optional(),
      regex_patterns: z.array(z.string()).optional(),
      presets: z.array(z.number()).optional(),
      allow_list: z.array(z.string()).optional(),
      mention_total_limit: z.number().optional(),
      mention_raid_protection_enabled: z.boolean().optional(),
    })
    .default({}),
  actions: z.array(rawActionSchema).default([]),
  enabled: z.boolean().default(true),
  exempt_roles: z.array(z.string()).default([]),
  exempt_channels: z.array(z.string()).default([]),
});

export interface ExistingRule extends DesiredRule {
  id: string;
  creatorId: string | null;
}

// Filtered rather than parsed as a union: a preset Discord adds later must not make the whole rule
// unreadable, which would leave the diff proposing the same update on every sync forever.
function isKnownPreset(value: number): value is 1 | 2 | 3 {
  return value === 1 || value === 2 || value === 3;
}

export function parseNativeRules(raw: unknown): ExistingRule[] {
  if (!Array.isArray(raw)) return [];

  return raw.flatMap((entry) => {
    const parsed = rawRuleSchema.safeParse(entry);
    if (!parsed.success) return [];

    const rule = parsed.data;
    return [
      {
        id: rule.id,
        creatorId: rule.creator_id ?? null,
        name: rule.name,
        eventType: rule.event_type,
        triggerType: rule.trigger_type,
        triggerMetadata: {
          keywordFilter: rule.trigger_metadata.keyword_filter,
          regexPatterns: rule.trigger_metadata.regex_patterns,
          presets: rule.trigger_metadata.presets?.filter(isKnownPreset),
          allowList: rule.trigger_metadata.allow_list,
          mentionTotalLimit: rule.trigger_metadata.mention_total_limit,
          mentionRaidProtectionEnabled: rule.trigger_metadata.mention_raid_protection_enabled,
        },
        actions: rule.actions.flatMap<AutomodRuleAction>((action) => {
          if (action.type === AUTOMOD_ACTION_SEND_ALERT) {
            return action.metadata?.channel_id
              ? [{ type: AUTOMOD_ACTION_SEND_ALERT, channelId: action.metadata.channel_id }]
              : [];
          }
          if (action.type === AUTOMOD_ACTION_BLOCK_MESSAGE) {
            return [
              {
                type: AUTOMOD_ACTION_BLOCK_MESSAGE,
                ...(action.metadata?.custom_message
                  ? { customMessage: action.metadata.custom_message }
                  : {}),
              },
            ];
          }
          return [];
        }),
        enabled: rule.enabled,
        exemptRoles: rule.exempt_roles,
        exemptChannels: rule.exempt_channels,
      },
    ];
  });
}

/**
 * Ownership, and why a hand-made rule is safe.
 *
 * `creator_id` is the application that made the rule, so it is the one claim an admin cannot
 * accidentally make — naming their own rule "Proton: blocked words" does not hand it over. The
 * name prefix is only a fallback for rules Discord returns without a creator.
 */
export function isOwned(rule: ExistingRule, botUserId: string): boolean {
  if (rule.creatorId !== null) return rule.creatorId === botUserId;
  return rule.name.startsWith(PROTON_RULE_PREFIX);
}

export type NativeOp =
  | { op: 'create'; rule: DesiredRule }
  | { op: 'update'; ruleId: string; rule: DesiredRule }
  | { op: 'delete'; ruleId: string; name: string };

export interface NativeDiff {
  ops: NativeOp[];
  unchanged: string[];
  foreign: string[];
}

function canonical(rule: DesiredRule): string {
  const metadata = rule.triggerMetadata;
  return JSON.stringify([
    rule.name,
    rule.eventType,
    rule.triggerType,
    metadata.keywordFilter ?? [],
    metadata.regexPatterns ?? [],
    metadata.presets ?? [],
    metadata.allowList ?? [],
    metadata.mentionTotalLimit ?? null,
    metadata.mentionRaidProtectionEnabled ?? null,
    [...rule.actions].sort((a, b) => a.type - b.type),
    rule.enabled,
    [...rule.exemptRoles].sort(),
    [...rule.exemptChannels].sort(),
  ]);
}

export function diffNativeRules(
  desired: readonly DesiredRule[],
  existing: readonly ExistingRule[],
  botUserId: string,
): NativeDiff {
  const diff: NativeDiff = { ops: [], unchanged: [], foreign: [] };

  const owned = new Map<string, ExistingRule>();
  for (const rule of existing) {
    if (!isOwned(rule, botUserId)) {
      diff.foreign.push(rule.name);
      continue;
    }
    owned.set(rule.name, rule);
  }

  for (const rule of desired) {
    const match = owned.get(rule.name);

    if (!match) {
      diff.ops.push({ op: 'create', rule });
      continue;
    }

    owned.delete(rule.name);

    // A trigger type cannot be PATCHed, so a rule whose trigger changed is replaced rather than
    // updated. Delete first: the guild's KEYWORD allowance may already be full.
    if (match.triggerType !== rule.triggerType) {
      diff.ops.push({ op: 'delete', ruleId: match.id, name: match.name });
      diff.ops.push({ op: 'create', rule });
      continue;
    }

    if (canonical(match) === canonical(rule)) {
      diff.unchanged.push(rule.name);
      continue;
    }

    diff.ops.push({ op: 'update', ruleId: match.id, rule });
  }

  for (const stale of owned.values()) {
    diff.ops.push({ op: 'delete', ruleId: stale.id, name: stale.name });
  }

  return diff;
}
