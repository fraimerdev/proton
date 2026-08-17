import type { RateWindowStore } from '@proton/core';
import { type AutomodHit, STATELESS_CHECKS } from './checks.ts';
import { type AutomodConfig, type AutomodSettings, outranks, severityOf } from './config.ts';
import { MODULE_ID } from './deps.ts';
import type { MessageFacts } from './message.ts';

export type AutomodVerdict =
  | { matched: false }
  | { matched: true; hit: AutomodHit; also: AutomodHit[] };

export interface ScreenInput {
  facts: MessageFacts;
  config: AutomodConfig;
  settings: AutomodSettings;
  guildId: string;
  rateWindow: RateWindowStore;
  eventId: string;
  now: number;
}

// A fingerprint of what was said, not of the message: two different messages with the same text
// are the repeat we are looking for, and the message id would make every one of them unique.
export function duplicateFingerprint(normalised: string): string {
  return Bun.hash(normalised).toString(36);
}

async function checkFlood(input: ScreenInput): Promise<AutomodHit | null> {
  const severity = severityOf(input.config, 'flood');
  if (severity === 'off') return null;

  const { tripped } = await input.rateWindow.hit({
    guildId: input.guildId,
    ruleId: `${MODULE_ID}:flood`,
    actorId: input.facts.authorId,
    windowMs: input.settings.floodWindowMs,
    limit: input.config.floodCount,
    member: input.eventId,
    now: input.now,
  });

  if (!tripped) return null;

  return {
    check: 'flood',
    severity,
    humanReason: `they sent ${input.config.floodCount} messages in ${input.config.floodWindow}`,
  };
}

async function checkDuplicate(input: ScreenInput): Promise<AutomodHit | null> {
  const severity = severityOf(input.config, 'duplicate');
  if (severity === 'off') return null;

  // Short messages repeat innocently — "lol", "yes", "+1" — so only substantial text is counted.
  if (input.facts.normalised.length < 8) return null;

  const { tripped } = await input.rateWindow.hit({
    guildId: input.guildId,
    ruleId: `${MODULE_ID}:dup:${duplicateFingerprint(input.facts.normalised)}`,
    actorId: input.facts.authorId,
    windowMs: input.settings.duplicateWindowMs,
    limit: input.config.duplicateCount,
    member: input.eventId,
    now: input.now,
  });

  if (!tripped) return null;

  return {
    check: 'duplicate',
    severity,
    humanReason: `they posted the same message ${input.config.duplicateCount} times`,
  };
}

/**
 * Every enabled check runs; the highest severity acts and the rest are reported.
 *
 * First-match-wins would make the punishment depend on the order of an array — an invite posted
 * alongside forty mentions would be treated as an invite. Summing severities would recreate
 * antiraid's join scoring, which is scoped to joins and makes "why was I timed out" unanswerable.
 */
export async function screen(input: ScreenInput): Promise<AutomodVerdict> {
  // Both stateful checks run first and unconditionally: they must observe every message to stay
  // accurate, so short-circuiting them behind an earlier match under-counts silently and the
  // flood check quietly stops working.
  const stateful = [await checkFlood(input), await checkDuplicate(input)];

  const hits = [
    ...stateful,
    ...STATELESS_CHECKS.map((check) => check(input.facts, input.config)),
  ].filter((entry): entry is AutomodHit => entry !== null);

  const [first, ...rest] = hits;
  if (!first) return { matched: false };

  let winner = first;
  const also: AutomodHit[] = [];

  for (const candidate of rest) {
    if (outranks(candidate.severity, winner.severity)) {
      also.push(winner);
      winner = candidate;
    } else {
      also.push(candidate);
    }
  }

  return { matched: true, hit: winner, also };
}
