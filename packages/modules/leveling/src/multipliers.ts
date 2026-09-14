import type { LevelingConfig } from './config.ts';
import type { XpEvent } from './xp-events.ts';

const MINUTE_MS = 60_000;

const TENTHS = 10;

export type MultiplierRules = Pick<LevelingConfig, 'roleMultipliers' | 'channelMultipliers'>;

export type XpEventWindow = Pick<XpEvent, 'multiplier' | 'startsAt' | 'endsAt'>;

export function resolveXpMultiplier(candidates: readonly number[]): number {
  if (candidates.length === 0) return 1;

  let highest = Number.NEGATIVE_INFINITY;
  for (const candidate of candidates) {
    if (candidate === 0) return 0;
    if (candidate > highest) highest = candidate;
  }

  return highest;
}

export function channelChain(
  channelId: string,
  channels?: ReadonlyMap<string, { parentId: string | null }> | null,
): string[] {
  const chain = [channelId];
  let current = channels?.get(channelId);

  for (let hop = 0; hop < 2 && current?.parentId; hop++) {
    const parentId = current.parentId;
    if (chain.includes(parentId)) break;

    chain.push(parentId);
    current = channels?.get(parentId);
  }

  return chain;
}

export interface StaticCandidateInput {
  guildId: string;
  roleIds: readonly string[];
  channelChain: readonly string[];
}

export function staticXpCandidates(rules: MultiplierRules, input: StaticCandidateInput): number[] {
  // The guild id is the @everyone role, which member.roles never lists.
  const held = new Set([...input.roleIds, input.guildId]);
  const chain = new Set(input.channelChain);

  return [
    ...rules.roleMultipliers.filter((entry) => held.has(entry.roleId)),
    ...rules.channelMultipliers.filter((entry) => chain.has(entry.channelId)),
  ].map((entry) => entry.multiplier);
}

export function activeXpEvents<E extends XpEventWindow>(events: readonly E[], at: number): E[] {
  return events.filter((event) => event.startsAt <= at && at < event.endsAt);
}

export interface MessageCandidateInput extends StaticCandidateInput {
  events: readonly XpEventWindow[];
  at: number;
}

export function messageXpCandidates(
  rules: MultiplierRules,
  input: MessageCandidateInput,
): number[] {
  return [
    ...staticXpCandidates(rules, input),
    ...activeXpEvents(input.events, input.at).map((event) => event.multiplier),
  ];
}

function tenthsOf(multiplier: number): number {
  return Math.round(multiplier * TENTHS);
}

export function scaleMessageXp(rolled: number, multiplier: number): number {
  if (multiplier === 0) return 0;
  if (rolled <= 0) return rolled;

  return Math.max(1, Math.round((rolled * tenthsOf(multiplier)) / TENTHS));
}

export interface VoicePayoutInput {
  joinedAt: number;
  minutes: number;
  voiceXpPerMinute: number;
  staticCandidates: readonly number[];
  events: readonly XpEventWindow[];
}

function highestActive(events: readonly XpEventWindow[], at: number): number | null {
  let highest: number | null = null;
  for (const event of activeXpEvents(events, at)) {
    if (highest === null || event.multiplier > highest) highest = event.multiplier;
  }
  return highest;
}

export function voiceXpPayout(input: VoicePayoutInput): number {
  if (input.minutes <= 0 || input.voiceXpPerMinute <= 0) return 0;

  const start = input.joinedAt;
  const end = start + input.minutes * MINUTE_MS;

  const cuts = new Set([start, end]);
  for (const event of input.events) {
    if (event.startsAt > start && event.startsAt < end) cuts.add(event.startsAt);
    if (event.endsAt > start && event.endsAt < end) cuts.add(event.endsAt);
  }

  const points = [...cuts].sort((a, b) => a - b);

  let weighted = 0;
  let earning = false;
  for (let index = 1; index < points.length; index++) {
    const from = points[index - 1] ?? start;
    const to = points[index] ?? end;

    const event = highestActive(input.events, from);
    const tenths = tenthsOf(
      resolveXpMultiplier(
        event === null ? input.staticCandidates : [...input.staticCandidates, event],
      ),
    );

    if (tenths > 0) earning = true;
    weighted += (to - from) * input.voiceXpPerMinute * tenths;
  }

  return earning ? Math.max(1, Math.round(weighted / (MINUTE_MS * TENTHS))) : 0;
}
