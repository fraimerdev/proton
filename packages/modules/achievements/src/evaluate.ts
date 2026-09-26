import { TIER_LABELS } from '@proton/cards/design';
import { TIER_IDS, type TierId, XP_SOURCES, type XpSource } from '@proton/core';
import type { Achievement, Requirement, Reward, Tier } from './config.ts';
import { DEADLINE_GRACE_MS } from './constants.ts';
import {
  DEFAULT_XP_SOURCES,
  DEPENDENCY_LABELS,
  DEPENDENCY_MODULES,
  type DependencyModule,
  type TriggerId,
  triggerOf,
} from './triggers.ts';

export interface Interval {
  start: number;
  end: number | null;
}

export interface RequirementProgress {
  id: string;
  trigger: TriggerId;
  current: number;
  target: number;
  remaining: number;
  ratio: number;
}

export interface TierProgress {
  tier: TierId;
  requirements: RequirementProgress[];
  percent: number;
}

export const DISPLAY_STATUSES = [
  'draft',
  'scheduled',
  'active',
  'paused',
  'expired',
  'archived',
] as const;

export type DisplayStatus = (typeof DISPLAY_STATUSES)[number];

export interface StatusView {
  status: DisplayStatus;
  reason?: string;
  blockedBy?: DependencyModule[];
}

export type RoleIntent = 'add' | 'remove';

type Values = Readonly<Record<string, number>>;

function cyrb53(text: string, seed = 0): string {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;

  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }

  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);

  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, '0');
}

function distinctSorted(ids: readonly string[]): string[] {
  return [...new Set(ids)].sort();
}

export function tierRank(id: TierId): number {
  return TIER_IDS.indexOf(id);
}

function byRank(a: TierId, b: TierId): number {
  return tierRank(a) - tierRank(b);
}

function tiersByRank(achievement: Achievement): Tier[] {
  return [...achievement.tiers].sort((a, b) => byRank(a.id, b.id));
}

export function effectiveXpSources(requirement: Requirement): XpSource[] | null {
  if (!triggerOf(requirement.trigger).filters.xpSources) return null;

  const chosen: readonly XpSource[] = requirement.xpSources ?? DEFAULT_XP_SOURCES;
  return XP_SOURCES.filter((source) => chosen.includes(source));
}

export function revisionOf(requirement: Requirement): string {
  return cyrb53(
    JSON.stringify({
      trigger: requirement.trigger,
      channelIds: distinctSorted(requirement.channelIds),
      excludedChannelIds: distinctSorted(requirement.excludedChannelIds),
      xpSources: effectiveXpSources(requirement),
      achievementId: requirement.achievementId ?? null,
      tierId: requirement.tierId ?? null,
    }),
  );
}

export function rewardKeyOf(reward: Reward): string {
  return reward.kind === 'xp' ? 'xp' : `${reward.kind}:${reward.roleId}`;
}

function rewardSignature(reward: Reward): string {
  return reward.kind === 'xp' ? `xp:${reward.amount}` : rewardKeyOf(reward);
}

export function achievementRevision(achievement: Achievement): string {
  return cyrb53(
    JSON.stringify({
      kind: achievement.kind,
      requirements: achievement.requirements
        .map((requirement) => [requirement.id, revisionOf(requirement)])
        .sort(([a], [b]) => String(a).localeCompare(String(b))),
      tiers: tiersByRank(achievement).map((tier) => ({
        id: tier.id,
        targets: Object.entries(tier.targets).sort(([a], [b]) => a.localeCompare(b)),
        rewards: tier.rewards.map(rewardSignature).sort(),
      })),
    }),
  );
}

function meets(achievement: Achievement, tier: Tier, values: Values): boolean {
  return achievement.requirements.every((requirement) => {
    const target = tier.targets[requirement.id];
    return target !== undefined && (values[requirement.id] ?? 0) >= target;
  });
}

export function earnedTierIds(achievement: Achievement, values: Values): TierId[] {
  return tiersByRank(achievement)
    .filter((tier) => meets(achievement, tier, values))
    .map((tier) => tier.id);
}

export function currentTierIds(achievement: Achievement, unlocked: readonly TierId[]): TierId[] {
  const held = new Set(unlocked);
  return tiersByRank(achievement)
    .map((tier) => tier.id)
    .filter((id) => held.has(id));
}

function percentOf(current: number, target: number): number {
  if (target <= 0) return 0;
  return Math.floor((Math.min(Math.max(current, 0), target) * 100) / target);
}

function progressOf(requirement: Requirement, tier: Tier, values: Values): RequirementProgress {
  const current = values[requirement.id] ?? 0;
  const target = tier.targets[requirement.id] ?? 0;

  return {
    id: requirement.id,
    trigger: requirement.trigger,
    current,
    target,
    remaining: Math.max(0, target - current),
    ratio: target > 0 ? Math.min(1, Math.max(0, current) / target) : 0,
  };
}

export function nextTier(
  achievement: Achievement,
  values: Values,
  unlocked: readonly TierId[],
): TierProgress | null {
  const held = new Set(unlocked);
  const tier = tiersByRank(achievement).find((candidate) => !held.has(candidate.id));
  if (!tier) return null;

  const requirements = achievement.requirements.map((requirement) =>
    progressOf(requirement, tier, values),
  );

  const percent = Math.min(
    ...requirements.map((requirement) => percentOf(requirement.current, requirement.target)),
  );

  return { tier: tier.id, requirements, percent };
}

export function almostThereDue(
  achievement: Achievement,
  values: Values,
  unlocked: readonly TierId[],
  notified: readonly TierId[],
): TierId | null {
  if (!achievement.almostThere.enabled) return null;

  const next = nextTier(achievement, values, unlocked);
  if (!next || notified.includes(next.tier)) return null;
  if (next.percent >= 100 || next.percent < achievement.almostThere.percent) return null;

  return next.tier;
}

export function joinAnd(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

export function dependenciesOf(achievement: Achievement): DependencyModule[] {
  const needed = new Set(
    achievement.requirements.map((requirement) => triggerOf(requirement.trigger).dependsOn),
  );

  return DEPENDENCY_MODULES.filter((module) => needed.has(module));
}

function instant(iso: string | undefined): number | null {
  if (iso === undefined) return null;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

export function displayStatus(
  achievement: Achievement,
  context: {
    now: number;
    moduleEnabled: boolean;
    enabledModules: ReadonlySet<string> | readonly string[];
  },
): StatusView {
  if (achievement.status === 'draft') return { status: 'draft' };
  if (achievement.status === 'archived') return { status: 'archived' };
  if (achievement.status === 'paused') return { status: 'paused', reason: 'Paused by an admin' };

  const endsAt = instant(achievement.endsAt);
  if (endsAt !== null && context.now > endsAt) {
    return { status: 'expired', reason: 'The deadline has passed' };
  }

  if (!context.moduleEnabled) return { status: 'paused', reason: 'Achievements is off' };

  const enabled = new Set(context.enabledModules);
  const blockedBy = dependenciesOf(achievement).filter((module) => !enabled.has(module));

  if (blockedBy.length > 0) {
    const names = joinAnd(blockedBy.map((module) => DEPENDENCY_LABELS[module]));
    const verb = blockedBy.length === 1 ? 'is' : 'are';
    return { status: 'paused', reason: `${names} ${verb} off in this server`, blockedBy };
  }

  const startsAt = instant(achievement.startsAt);
  if (startsAt !== null && context.now < startsAt) {
    return { status: 'scheduled', reason: 'Waiting for its start date' };
  }

  return { status: 'active' };
}

export function acceptsAt(achievement: Achievement, occurredAt: number, now: number): boolean {
  const startsAt = instant(achievement.startsAt);
  if (startsAt !== null && occurredAt < startsAt) return false;

  const endsAt = instant(achievement.endsAt);
  if (endsAt === null) return true;

  return occurredAt <= endsAt && now <= endsAt + DEADLINE_GRACE_MS;
}

export function clipSpan(
  span: { start: number; end: number },
  windows: readonly Interval[],
): number {
  if (!(span.end > span.start)) return 0;

  const parts = windows
    .map((window) => ({
      start: Math.max(window.start, span.start),
      end: Math.min(window.end ?? Number.POSITIVE_INFINITY, span.end),
    }))
    .filter((part) => part.end > part.start)
    .sort((a, b) => a.start - b.start);

  let total = 0;
  let reached = Number.NEGATIVE_INFINITY;

  for (const part of parts) {
    const from = Math.max(part.start, reached);
    if (part.end > from) total += part.end - from;
    reached = Math.max(reached, part.end);
  }

  return total;
}

export function withinWindows(at: number, windows: readonly Interval[]): boolean {
  return windows.some((window) => at >= window.start && (window.end === null || at <= window.end));
}

export function countingWindows(
  achievement: Achievement,
  periods: { module: readonly Interval[]; achievement: readonly Interval[] },
): Interval[] {
  const startsAt = instant(achievement.startsAt);
  const endsAt = instant(achievement.endsAt);
  const source = achievement.includeRecorded ? periods.module : periods.achievement;

  return source
    .map((window) => {
      const start = startsAt === null ? window.start : Math.max(window.start, startsAt);
      const end =
        endsAt === null ? window.end : window.end === null ? endsAt : Math.min(window.end, endsAt);
      return { start, end };
    })
    .filter((window) => window.end === null || window.end > window.start);
}

export function channelMatches(
  filter: { channelIds: readonly string[]; excludedChannelIds: readonly string[] },
  location: { channelId: string | null; parentId: string | null; categoryId: string | null },
): boolean {
  const chain = [location.channelId, location.parentId, location.categoryId].filter(
    (id): id is string => id !== null,
  );

  if (chain.some((id) => filter.excludedChannelIds.includes(id))) return false;
  return filter.channelIds.length === 0 || chain.some((id) => filter.channelIds.includes(id));
}

function unitFor(trigger: TriggerId, target: number): string {
  const { unit } = triggerOf(trigger);
  return target === 1 ? unit.one : unit.many;
}

function plural(target: number, one: string, many: string): string {
  return target === 1 ? one : many;
}

export function describeRequirement(
  requirement: Requirement,
  target: number,
  locale = 'en-GB',
  nameOf?: (achievementId: string) => string | undefined,
): string {
  const n = new Intl.NumberFormat(locale).format(target);

  switch (requirement.trigger) {
    case 'messages.sent':
      return `Send ${n} ${unitFor(requirement.trigger, target)}`;
    case 'activity.active_days':
      return target === 1 ? 'Be active on 1 day' : `Be active on ${n} different days`;
    case 'voice.minutes':
      return `Spend ${n} ${plural(target, 'minute', 'minutes')} in voice`;
    case 'voice.longest_stay':
      return `Stay in voice for ${n} ${plural(target, 'minute', 'minutes')} in one go`;
    case 'tempvc.minutes':
      return `Spend ${n} ${plural(target, 'minute', 'minutes')} in temporary voice channels`;
    case 'reactions.given':
      return `React to ${n} ${plural(target, 'message', 'messages')}`;
    case 'reactions.received':
      return `Receive ${n} ${plural(target, 'reaction', 'reactions')}`;
    case 'starboard.messages':
      return `Get ${n} ${plural(target, 'message', 'messages')} onto the starboard`;
    case 'boosts.started':
      return target === 1 ? 'Boost the server' : `Boost the server ${n} times`;
    case 'membership.days':
      return `Stay a member for ${n} ${plural(target, 'day', 'days')}`;
    case 'leveling.level':
      return `Reach level ${n}`;
    case 'leveling.activity_xp':
      return `Earn ${n} XP from activity`;
    case 'giveaways.entered':
      return `Enter ${n} ${plural(target, 'giveaway', 'giveaways')}`;
    case 'giveaways.won':
      return `Win ${n} ${plural(target, 'giveaway', 'giveaways')}`;
    case 'applications.accepted':
      return `Get ${n} ${plural(target, 'application', 'applications')} accepted`;
    case 'achievements.earned':
      return `Earn ${n} other ${plural(target, 'achievement', 'achievements')}`;
    case 'achievements.unlocked': {
      const name =
        (requirement.achievementId !== undefined
          ? nameOf?.(requirement.achievementId)
          : undefined) ?? 'another achievement';
      const tier = requirement.tierId;
      return tier === undefined || tier === 'single'
        ? `Earn ${name}`
        : `Earn ${name} (${TIER_LABELS[tier]} or higher)`;
    }
  }
}

export function formatProgress(
  current: number,
  target: number,
  unit: { one: string; many: string },
  locale = 'en-GB',
): string {
  const format = new Intl.NumberFormat(locale);
  const noun = target === 1 ? unit.one : unit.many;
  return `${format.format(current)} / ${format.format(target)} ${noun} (${percentOf(current, target)}%)`;
}

export function progressBar(ratio: number, width = 10): string {
  const clamped = Number.isFinite(ratio) ? Math.min(1, Math.max(0, ratio)) : 0;
  const filled = Math.min(width, Math.floor(clamped * width + 1e-9));
  return '▰'.repeat(filled) + '▱'.repeat(width - filled);
}

export function netRoleIntent(
  achievement: Achievement,
  unlocked: readonly TierId[],
): Map<string, RoleIntent> {
  const held = new Set(unlocked);
  const intent = new Map<string, RoleIntent>();

  for (const tier of tiersByRank(achievement)) {
    if (!held.has(tier.id)) continue;

    for (const reward of tier.rewards) {
      if (reward.kind === 'add_role') intent.set(reward.roleId, 'add');
      else if (reward.kind === 'remove_role') intent.set(reward.roleId, 'remove');
    }
  }

  return intent;
}

const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

function randomId(random: () => number, length: number): string {
  let id = '';

  for (let index = 0; index < length; index++) {
    const pick = Math.floor(random() * ID_ALPHABET.length);
    id += ID_ALPHABET.charAt(Math.min(Math.max(pick, 0), ID_ALPHABET.length - 1));
  }

  return id;
}

export function newAchievementId(random: () => number): string {
  return randomId(random, 10);
}

export function newRequirementId(random: () => number): string {
  return randomId(random, 6);
}
