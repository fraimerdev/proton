import type { GuildState } from '@proton/core';
import type { AutomodConfig } from './config.ts';
import { isHumanMessage, type MessageFacts } from './message.ts';

export const EXEMPT_REASONS = [
  'self',
  'bot',
  'channel',
  'role',
  'not_a_human_message',
] as const;

export type ExemptReason = (typeof EXEMPT_REASONS)[number];

export interface ExemptInput {
  facts: MessageFacts;
  config: AutomodConfig;
  botUserId: string;
  state: GuildState | null;
}

// Runs before every check including the stateful ones, so an exempt member never feeds the flood
// or duplicate counters. Counting them would let a staff conversation trip a limit for whoever
// spoke next.
export function isExempt(input: ExemptInput): ExemptReason | null {
  const { facts, config, botUserId, state } = input;

  // Not configurable. Proton screening its own alerts is a loop, not a policy choice.
  if (facts.authorId === botUserId) return 'self';

  if (!isHumanMessage(facts.type)) return 'not_a_human_message';
  if (facts.isBot && config.exemptBots) return 'bot';

  if (config.exemptChannelIds.includes(facts.channelId)) return 'channel';

  // A message in a thread carries the thread's id, so without resolving the parent a thread
  // silently escapes the exemption its channel was given.
  const parentId = state?.channels.get(facts.channelId)?.parentId;
  if (parentId && config.exemptChannelIds.includes(parentId)) return 'channel';

  if (facts.roleIds && facts.roleIds.some((id) => config.exemptRoleIds.includes(id))) {
    return 'role';
  }

  return null;
}
