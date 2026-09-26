import type { TierId } from '@proton/core';
import type { Achievement, AchievementsConfig } from './config.ts';
import { ACTIVITY_RETENTION_DAYS } from './constants.ts';
import { countingWindows, effectiveXpSources, type Interval } from './evaluate.ts';
import {
  type GuildRuntime,
  NO_NEWLY_EARNED,
  type RebuildPlan,
  type RebuildRequirement,
} from './store.ts';
import { aggregateOf, LEDGER_METRICS, type LedgerMetric, triggerOf } from './triggers.ts';

export const HOUR_MS = 60 * 60 * 1000;

const LEDGER = new Set<string>(LEDGER_METRICS);

export function hourFloor(at: number): number {
  return Math.floor(at / HOUR_MS) * HOUR_MS;
}

export function hourCeil(at: number): number {
  return Math.ceil(at / HOUR_MS) * HOUR_MS;
}

export function rebuildSignature(achievement: Achievement): string {
  return JSON.stringify([
    achievement.includeRecorded,
    achievement.startsAt ?? null,
    achievement.endsAt ?? null,
    achievement.requirements
      .map((requirement) => [requirement.id, requirement.version] as const)
      .sort(([a], [b]) => a.localeCompare(b)),
  ]);
}

export function rebuildWindows(
  achievement: Achievement,
  runtime: Pick<GuildRuntime, 'modulePeriods' | 'periods'>,
  now: number,
): Interval[] {
  const horizon = now - ACTIVITY_RETENTION_DAYS * 24 * HOUR_MS;

  return countingWindows(achievement, {
    module: runtime.modulePeriods,
    achievement: runtime.periods.get(achievement.id) ?? [],
  })
    .map((window) => ({
      start: hourCeil(Math.max(window.start, horizon)),
      end: window.end === null ? null : hourFloor(window.end),
    }))
    .filter((window) => window.end === null || window.end > window.start)
    .sort((a, b) => a.start - b.start);
}

export function planRebuild(
  config: AchievementsConfig,
  achievement: Achievement,
  runtime: GuildRuntime,
  now: number,
): RebuildPlan {
  const requirements: RebuildRequirement[] = [];
  const stateRequirements: RebuildPlan['stateRequirements'] = [];

  for (const requirement of achievement.requirements) {
    const trigger = triggerOf(requirement.trigger);

    if (!LEDGER.has(trigger.metric)) {
      stateRequirements.push({ requirementId: requirement.id, version: requirement.version });
      continue;
    }

    requirements.push({
      requirementId: requirement.id,
      version: requirement.version,
      metric: trigger.metric as LedgerMetric,
      aggregate: aggregateOf(trigger),
      temporaryOnly: trigger.temporaryOnly === true,
      xpSources: effectiveXpSources(requirement),
      channelIds: [...new Set(requirement.channelIds)],
      excludedChannelIds: [
        ...new Set([...requirement.excludedChannelIds, ...config.excludedChannelIds]),
      ],
    });
  }

  const signature = rebuildSignature(achievement);
  const rebuiltWith = runtime.state.get(achievement.id)?.rebuiltWith ?? null;

  return {
    achievementId: achievement.id,
    requirements,
    stateRequirements,
    tiers: achievement.tiers.map((tier) => ({ tierId: tier.id, targets: { ...tier.targets } })),
    windows: rebuildWindows(achievement, runtime, now),
    keepHigher: rebuiltWith === null || rebuiltWith === signature,
    signature,
  };
}

export interface ActivityBucket {
  metric: string;
  hour: number;
  channelId: string | null;
  parentId: string | null;
  categoryId: string | null;
  temporary: boolean;
  xpSource: string;
  spanStart: number | null;
}

// A stay's amount is its length since spanStart, so a stay that began before the window has to
// give back the minutes it spent outside it — the bucket landing inside is not enough.
export function maxInWindow(
  bucket: ActivityBucket,
  amountMax: number,
  windows: readonly Interval[],
): number {
  if (bucket.spanStart === null) return amountMax;

  const window = windows.find(
    (candidate) =>
      bucket.hour >= candidate.start && (candidate.end === null || bucket.hour < candidate.end),
  );
  if (window === undefined || window.start <= bucket.spanStart) return amountMax;

  return Math.max(0, amountMax - Math.floor((window.start - bucket.spanStart) / 60_000));
}

export function bucketCounts(
  requirement: RebuildRequirement,
  bucket: ActivityBucket,
  windows: readonly Interval[],
  countedFrom: number | null,
): boolean {
  if (bucket.metric !== requirement.metric) return false;
  if (requirement.temporaryOnly && !bucket.temporary) return false;
  if (requirement.xpSources !== null && !requirement.xpSources.some((s) => s === bucket.xpSource)) {
    return false;
  }

  if (countedFrom !== null && bucket.hour < hourCeil(countedFrom)) return false;

  const inWindow = windows.some(
    (window) => bucket.hour >= window.start && (window.end === null || bucket.hour < window.end),
  );
  if (!inWindow) return false;

  const chain = [bucket.channelId, bucket.parentId, bucket.categoryId].filter(
    (id): id is string => id !== null,
  );
  if (chain.some((id) => requirement.excludedChannelIds.includes(id))) return false;

  return (
    requirement.channelIds.length === 0 || chain.some((id) => requirement.channelIds.includes(id))
  );
}

export function earnedTiers(
  tiers: RebuildPlan['tiers'],
  values: Readonly<Record<string, number>>,
): TierId[] {
  return tiers
    .filter((tier) =>
      Object.entries(tier.targets).every(([requirementId, target]) => {
        return (values[requirementId] ?? 0) >= target;
      }),
    )
    .map((tier) => tier.tierId);
}

export interface RebuildMemberInput {
  userId: string;
  generation: number;
  rebuilt: Readonly<Record<string, number>>;
  current: Readonly<Record<string, { value: number; version: number; generation: number }>>;
  unlocked: readonly TierId[];
}

export interface RebuildWrite {
  userId: string;
  requirementId: string;
  value: number;
  version: number;
  generation: number;
}

export interface RebuildOutcome {
  changed: number;
  lost: number;
  newlyEarned: Record<TierId, number>;
  writes: RebuildWrite[];
}

export function rebuildOutcome(
  plan: RebuildPlan,
  members: readonly RebuildMemberInput[],
): RebuildOutcome {
  const newlyEarned = { ...NO_NEWLY_EARNED };
  const writes: RebuildWrite[] = [];
  let changed = 0;
  let lost = 0;

  for (const entry of members) {
    const values: Record<string, number> = {};
    let memberChanged = false;
    let memberLost = false;

    for (const requirement of plan.requirements) {
      const stored = entry.current[requirement.requirementId];
      const isCurrent =
        stored !== undefined &&
        stored.version === requirement.version &&
        stored.generation === entry.generation;
      const before = isCurrent ? stored.value : 0;
      const rebuilt = entry.rebuilt[requirement.requirementId] ?? 0;
      const after = plan.keepHigher && isCurrent ? Math.max(before, rebuilt) : rebuilt;

      values[requirement.requirementId] = after;
      if (after !== before) memberChanged = true;
      if (after < before) memberLost = true;

      if (!isCurrent || after !== before) {
        writes.push({
          userId: entry.userId,
          requirementId: requirement.requirementId,
          value: after,
          version: requirement.version,
          generation: entry.generation,
        });
      }
    }

    for (const requirement of plan.stateRequirements) {
      const stored = entry.current[requirement.requirementId];
      values[requirement.requirementId] =
        stored && stored.version === requirement.version && stored.generation === entry.generation
          ? stored.value
          : 0;
    }

    if (memberChanged) changed += 1;
    if (memberLost) lost += 1;

    const held = new Set(entry.unlocked);
    for (const tier of earnedTiers(plan.tiers, values)) {
      if (!held.has(tier)) newlyEarned[tier] += 1;
    }
  }

  return { changed, lost, newlyEarned, writes };
}

export function rebuildRequirementsJson(plan: RebuildPlan): string {
  return JSON.stringify(
    plan.requirements.map((requirement) => ({
      requirement_id: requirement.requirementId,
      version: requirement.version,
      metric: requirement.metric,
      aggregate: requirement.aggregate,
      temporary_only: requirement.temporaryOnly,
      xp_sources: requirement.xpSources,
      channel_ids: requirement.channelIds,
      excluded_channel_ids: requirement.excludedChannelIds,
    })),
  );
}

export function rebuildWindowsJson(windows: readonly Interval[]): string {
  return JSON.stringify(windows.map((window) => ({ start_ms: window.start, end_ms: window.end })));
}
