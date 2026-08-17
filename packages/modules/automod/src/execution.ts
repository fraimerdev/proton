import {
  AUTOMOD_TRIGGER_KEYWORD,
  AUTOMOD_TRIGGER_KEYWORD_PRESET,
  AUTOMOD_TRIGGER_MEMBER_PROFILE,
  AUTOMOD_TRIGGER_MENTION_SPAM,
  AUTOMOD_TRIGGER_SPAM,
  type EventListener,
  type EventType,
} from '@proton/core';
import { z } from 'zod';
import type { AutomodConfig } from './config.ts';
import { type AutomodDeps, MODULE_ID } from './deps.ts';
import { isOwned, parseNativeRules } from './native.ts';

export const AUTOMOD_EXECUTION_EVENT_TYPES: EventType[] = ['automod.executed'];

export const OWNED_RULES_TTL_MS = 5 * 60 * 1000;

const executionSchema = z.object({
  rule_id: z.string(),
  rule_trigger_type: z.number().int(),
  user_id: z.string(),
  channel_id: z.string().optional(),
  message_id: z.string().optional(),
  action: z.object({ type: z.number().int() }),
  matched_keyword: z.string().nullish(),
  matched_content: z.string().nullish(),
});

export interface ExecutionFacts {
  ruleId: string;
  triggerType: number;
  userId: string;
  channelId: string | null;
  messageId: string | null;
  actionType: number;
  matched: string | null;
}

export function readExecution(payload: unknown): ExecutionFacts | null {
  const parsed = executionSchema.safeParse(payload);
  if (!parsed.success) return null;

  const d = parsed.data;
  return {
    ruleId: d.rule_id,
    triggerType: d.rule_trigger_type,
    userId: d.user_id,
    channelId: d.channel_id ?? null,
    messageId: d.message_id ?? null,
    actionType: d.action.type,
    matched: d.matched_keyword ?? d.matched_content ?? null,
  };
}

const TRIGGER_REASONS: Record<number, string> = {
  [AUTOMOD_TRIGGER_KEYWORD]: 'it matched this server’s blocked words',
  [AUTOMOD_TRIGGER_SPAM]: 'Discord’s spam filter caught it',
  [AUTOMOD_TRIGGER_KEYWORD_PRESET]: 'it matched one of Discord’s maintained word lists',
  [AUTOMOD_TRIGGER_MENTION_SPAM]: 'it mentioned too many people at once',
  [AUTOMOD_TRIGGER_MEMBER_PROFILE]: 'their profile matched this server’s blocked words',
};

export function describeExecution(facts: ExecutionFacts): string {
  const reason = TRIGGER_REASONS[facts.triggerType] ?? 'a Discord AutoMod rule matched it';
  return facts.matched ? `${reason} (\`${facts.matched}\`)` : reason;
}

interface OwnedRules {
  ids: Set<string>;
  readAt: number;
}

export interface ExecutionListenerOptions {
  ttlMs?: number;
  now?(): number;
}

/**
 * Escalation for the half Proton never sees.
 *
 * A natively blocked message produces no MESSAGE_CREATE, so the screening pipeline cannot count it
 * and a member could live on the blocked-word list all day without reaching a single ladder rung.
 * Recording a case and publishing `moderation.warned` here is what makes both halves feed one
 * history.
 *
 * Only for rules Proton owns. A rule an admin built themselves is theirs to decide consequences
 * for, and silently attaching Proton's ladder to it would be a punishment they never configured.
 */
export function createAutomodExecutionListener(
  deps: AutomodDeps,
  options: ExecutionListenerOptions = {},
): EventListener<AutomodConfig> {
  const ttlMs = options.ttlMs ?? OWNED_RULES_TTL_MS;
  const now = options.now ?? (() => Date.now());

  // Cached per guild because an execution carries no rule name and no creator, so ownership can
  // only come from a list call — and a busy blocked-word rule would otherwise spend one REST
  // request per blocked message.
  const cache = new Map<string, OwnedRules>();

  async function ownedRuleIds(guildId: string): Promise<Set<string> | null> {
    const cached = cache.get(guildId);
    if (cached && now() - cached.readAt < ttlMs) return cached.ids;

    if (!deps.readNativeRules || !deps.botUserId) return null;

    try {
      const rules = parseNativeRules(await deps.readNativeRules(guildId));
      const ids = new Set(
        rules.filter((rule) => isOwned(rule, deps.botUserId as string)).map((rule) => rule.id),
      );
      cache.set(guildId, { ids, readAt: now() });
      return ids;
    } catch {
      return null;
    }
  }

  return {
    types: AUTOMOD_EXECUTION_EVENT_TYPES,

    async handler(event, ctx) {
      if (!ctx.config.enabled) return;
      if (event.guildId === null) return;

      const facts = readExecution(event.payload);
      if (!facts) return;
      if (facts.userId === deps.botUserId) return;

      const owned = await ownedRuleIds(ctx.guildId);
      if (!owned?.has(facts.ruleId)) return;

      const reason = `Discord AutoMod: ${describeExecution(facts)}`;

      ctx.logger.info(`Discord AutoMod acted on ${facts.userId}: ${reason}`, {
        guildId: ctx.guildId,
        moduleId: MODULE_ID,
        userId: facts.userId,
        ruleId: facts.ruleId,
      });

      // `warn` issues no REST call — Discord already blocked the message. All this does is put a
      // row in the ledger so the moderator reading a member's history sees both halves.
      const result = await ctx.executor.execute({
        guildId: ctx.guildId,
        moduleId: MODULE_ID,
        kind: 'warn',
        actorId: MODULE_ID,
        targetId: facts.userId,
        reason,
        idempotencyKey: `${MODULE_ID}:native:${event.id}`,
        dryRun: false,
        payload: { userId: facts.userId, note: reason },
      });

      if (result.status === 'skipped_duplicate') return;

      await ctx.publish?.('moderation.warned', `automod-native:${event.id}`, {
        userId: facts.userId,
        ...(facts.channelId ? { channelId: facts.channelId } : {}),
      });
    },
  };
}
