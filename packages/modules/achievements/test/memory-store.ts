import { TIER_IDS, type TierId } from '@proton/core';
import type { NewAuditTrailEntry } from '@proton/db';
import { z } from 'zod';
import type { ActivityRecord } from '../src/activity.ts';
import { achievementsConfigSchema } from '../src/config.ts';
import {
  ACTIVE_DAY_TARGET_METRIC,
  ACTIVITY_RETENTION_DAYS,
  GROUP_RELEASE_METRIC,
  JOB_SLICE,
  MAX_REWARD_ATTEMPTS,
  RESERVED_SEEN_RETENTION_MS,
  type ReservedSeenMetric,
  SEEN_RETENTION_MS,
  XP_CONFIRM_TIMEOUT_MS,
} from '../src/constants.ts';
import { type Interval, rewardKeyOf } from '../src/evaluate.ts';
import {
  bucketCounts,
  hourFloor,
  maxInWindow,
  type RebuildMemberInput,
  rebuildOutcome,
  rebuildSignature,
} from '../src/rebuild.ts';
import {
  type AchievementMembersCount,
  type AchievementRuntimeState,
  type AchievementStore,
  ALREADY_GIVEN,
  type AnniversaryWindow,
  type AnnounceGroup,
  type AnnouncementClaim,
  type AnnouncementOutcome,
  type BadgeAsset,
  CANCELLED_BY_RESET,
  type DueWork,
  type FactsPatch,
  type GuildRuntime,
  type JobPatch,
  type JobState,
  type MemberAchievementState,
  type MemberDetailRows,
  type MemberFacts,
  NO_NEWLY_EARNED,
  type Page,
  type PendingOrigin,
  type ProgressTarget,
  type PurgeResult,
  parseXpGrantId,
  RESET_BEFORE_ANNOUNCED,
  type RebuildMode,
  type RebuildPlan,
  type RebuildSliceResult,
  type RecordResult,
  type ResetAchievementInput,
  type ResetMemberInput,
  type RewardClaim,
  type RewardOutcome,
  type RewardRef,
  type RewardRow,
  type RewardStatusCount,
  type StateValue,
  type TierHolders,
  type UnlockInput,
  type UnlockResult,
  type UnlockRow,
  XP_REFUSED,
  type XpGrantOutcome,
} from '../src/store.ts';
import { jobResultSchema, type RewardListQuery, type UnlockListQuery } from '../src/view.ts';

const DAY_MS = 24 * 60 * 60 * 1000;
const MODULE_ROW = '';

const moduleBagSchema = z.object({
  anniversaryRunAt: z.number().optional(),
  rebuilt: z.record(z.string(), z.string()).optional(),
});

type ModuleBag = z.infer<typeof moduleBagSchema>;

type SeenState = 'counted' | 'pending' | 'void';

interface SeenRow {
  guildId: string;
  metric: ActivityRecord['metric'] | ReservedSeenMetric;
  sourceKey: string;
  userId: string;
  occurredAt: number;
  state: SeenState;
  groupKey: string | null;
  channelId: string | null;
  parentId: string | null;
  categoryId: string | null;
  seenAt: number;
}

interface ActivityRow {
  guildId: string;
  userId: string;
  metric: string;
  hour: number;
  channelKey: string;
  channelId: string | null;
  parentId: string | null;
  categoryId: string | null;
  temporary: boolean;
  xpSource: string;
  amountSum: number;
  amountMax: number;
  spanStart: number | null;
  events: number;
}

interface ProgressRow {
  guildId: string;
  achievementId: string;
  requirementId: string;
  userId: string;
  value: number;
  version: number;
  generation: number;
  updatedAt: number;
}

interface MemberRow {
  guildId: string;
  achievementId: string;
  userId: string;
  generation: number;
  rewardEpoch: number;
  countedFrom: number | null;
  resetAt: number | null;
  resetBy: string | null;
  almostNotified: string[];
  almostNotifiedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

interface StateRow {
  guildId: string;
  achievementId: string;
  generation: number;
  rewardEpoch: number;
  countedFrom: number | null;
  resetAt: number | null;
  resetBy: string | null;
  firstActiveAt: number | null;
  job: JobState['job'];
  jobStatus: JobState['status'];
  jobCursor: string | null;
  jobRequestedAt: number | null;
  jobRequestedBy: string | null;
  jobFinishedAt: number | null;
  jobResult: unknown;
  jobAnnounce: boolean;
  jobAcceptLoss: boolean;
  updatedAt: number;
}

interface PeriodRow {
  guildId: string;
  achievementId: string;
  startedAt: number;
  endedAt: number | null;
}

interface FactsRow extends MemberFacts {
  guildId: string;
}

interface BadgeRow extends BadgeAsset {
  guildId: string;
}

export interface ModuleRow {
  enabled: boolean;
  config: unknown;
}

function key(...parts: ReadonlyArray<string | number>): string {
  return JSON.stringify(parts);
}

function rank(tier: string): number {
  return TIER_IDS.indexOf(tier as TierId);
}

function ledgerMetric(metric: SeenRow['metric']): ActivityRecord['metric'] {
  if (metric === GROUP_RELEASE_METRIC || metric === ACTIVE_DAY_TARGET_METRIC) {
    throw new Error(`Metric ${metric} is reserved and never released`);
  }
  return metric;
}

function byText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function tierList(values: readonly string[]): TierId[] {
  return TIER_IDS.filter((tier) => values.includes(tier));
}

function compareVersion(
  incoming: { generation: number; version: number },
  stored: { generation: number; version: number },
): number {
  return incoming.generation - stored.generation || incoming.version - stored.version;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function rewardRefKey(ref: {
  guildId: string;
  userId: string;
  achievementId: string;
  tierId: string;
  generation: number;
  rewardKey: string;
}): string {
  return key(ref.guildId, ref.userId, ref.achievementId, ref.tierId, ref.generation, ref.rewardKey);
}

function unlockKey(row: {
  guildId: string;
  userId: string;
  achievementId: string;
  tierId: string;
  generation: number;
}): string {
  return key(row.guildId, row.userId, row.achievementId, row.tierId, row.generation);
}

const REWARD_ORDER = (a: RewardRow, b: RewardRow) =>
  a.createdAt - b.createdAt ||
  byText(a.userId, b.userId) ||
  byText(a.achievementId, b.achievementId) ||
  a.generation - b.generation ||
  rank(a.tierId) - rank(b.tierId) ||
  byText(a.rewardKey, b.rewardKey);

const UNLOCK_ORDER = (a: UnlockRow, b: UnlockRow) =>
  a.unlockedAt - b.unlockedAt ||
  byText(a.achievementId, b.achievementId) ||
  a.tierIndex - b.tierIndex;

export class MemoryAchievementStore implements AchievementStore {
  readonly seen = new Map<string, SeenRow>();
  readonly activity = new Map<string, ActivityRow>();
  readonly progress = new Map<string, ProgressRow>();
  readonly members = new Map<string, MemberRow>();
  readonly states = new Map<string, StateRow>();
  readonly periods: PeriodRow[] = [];
  readonly unlocks = new Map<string, UnlockRow>();
  readonly rewards = new Map<string, RewardRow>();
  readonly factRows = new Map<string, FactsRow>();
  readonly badges = new Map<string, BadgeRow>();
  readonly modules = new Map<string, ModuleRow>();
  readonly audits: NewAuditTrailEntry[] = [];
  readonly #now: () => number;

  constructor(options: { now?: () => number } = {}) {
    this.#now = options.now ?? Date.now;
  }

  setModule(guildId: string, row: ModuleRow | null): void {
    if (row === null) this.modules.delete(guildId);
    else this.modules.set(guildId, row);
  }

  #state(guildId: string, achievementId: string): StateRow | undefined {
    return this.states.get(key(guildId, achievementId));
  }

  #member(guildId: string, achievementId: string, userId: string): MemberRow | undefined {
    return this.members.get(key(guildId, achievementId, userId));
  }

  #ensureState(guildId: string, achievementId: string): StateRow {
    const existing = this.#state(guildId, achievementId);
    if (existing) return existing;

    const row: StateRow = {
      guildId,
      achievementId,
      generation: 0,
      rewardEpoch: 0,
      countedFrom: null,
      resetAt: null,
      resetBy: null,
      firstActiveAt: null,
      job: null,
      jobStatus: null,
      jobCursor: null,
      jobRequestedAt: null,
      jobRequestedBy: null,
      jobFinishedAt: null,
      jobResult: null,
      jobAnnounce: false,
      jobAcceptLoss: false,
      updatedAt: this.#now(),
    };
    this.states.set(key(guildId, achievementId), row);
    return row;
  }

  #ensureMember(guildId: string, achievementId: string, userId: string): MemberRow {
    const existing = this.#member(guildId, achievementId, userId);
    if (existing) return existing;

    const now = this.#now();
    const row: MemberRow = {
      guildId,
      achievementId,
      userId,
      generation: 0,
      rewardEpoch: 0,
      countedFrom: null,
      resetAt: null,
      resetBy: null,
      almostNotified: [],
      almostNotifiedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    this.members.set(key(guildId, achievementId, userId), row);
    return row;
  }

  #effective(guildId: string, achievementId: string, userId: string) {
    const state = this.#state(guildId, achievementId);
    const member = this.#member(guildId, achievementId, userId);
    const bounds = [state?.countedFrom ?? null, member?.countedFrom ?? null].filter(
      (at): at is number => at !== null,
    );

    return {
      generation: (state?.generation ?? 0) + (member?.generation ?? 0),
      rewardEpoch: (state?.rewardEpoch ?? 0) + (member?.rewardEpoch ?? 0),
      countedFrom: bounds.length > 0 ? Math.max(...bounds) : null,
    };
  }

  #currentUnlocks(guildId: string, userId: string): UnlockRow[] {
    return [...this.unlocks.values()].filter(
      (row) =>
        row.guildId === guildId &&
        row.userId === userId &&
        row.voidedAt === null &&
        row.generation === this.#effective(guildId, row.achievementId, userId).generation,
    );
  }

  #states(guildId: string, userId: string, ids: readonly string[]): MemberAchievementState[] {
    return ids.map((achievementId) => {
      const effective = this.#effective(guildId, achievementId, userId);
      const member = this.#member(guildId, achievementId, userId);
      const values: MemberAchievementState['values'] = {};

      for (const row of this.progress.values()) {
        if (
          row.guildId === guildId &&
          row.achievementId === achievementId &&
          row.userId === userId
        ) {
          values[row.requirementId] = {
            value: row.value,
            version: row.version,
            generation: row.generation,
          };
        }
      }

      const unlocked = [...this.unlocks.values()]
        .filter(
          (row) =>
            row.guildId === guildId &&
            row.userId === userId &&
            row.achievementId === achievementId &&
            row.voidedAt === null &&
            row.generation === effective.generation,
        )
        .map((row) => row.tierId);

      return {
        achievementId,
        userId,
        generation: effective.generation,
        rewardEpoch: effective.rewardEpoch,
        countedFrom: effective.countedFrom,
        values,
        unlocked: tierList(unlocked),
        almostNotified: tierList(member?.almostNotified ?? []),
        almostNotifiedAt: member?.almostNotifiedAt ?? null,
      };
    });
  }

  #upsertProgress(
    guildId: string,
    userId: string,
    target: {
      achievementId: string;
      requirementId: string;
      version: number;
      generation: number;
      amount: number;
    },
    combine: (stored: number, incoming: number) => number,
  ): void {
    const rowKey = key(guildId, target.achievementId, target.requirementId, userId);
    const stored = this.progress.get(rowKey);
    const now = this.#now();

    if (!stored) {
      this.progress.set(rowKey, {
        guildId,
        achievementId: target.achievementId,
        requirementId: target.requirementId,
        userId,
        value: target.amount,
        version: target.version,
        generation: target.generation,
        updatedAt: now,
      });
      return;
    }

    const order = compareVersion(target, stored);
    if (order < 0) return;

    stored.value = order > 0 ? target.amount : combine(stored.value, target.amount);
    stored.version = target.version;
    stored.generation = target.generation;
    stored.updatedAt = now;
  }

  async record(
    record: ActivityRecord,
    targets: readonly ProgressTarget[],
    achievementIds: readonly string[],
  ): Promise<RecordResult> {
    const { guildId, userId } = record;
    const ids = [...new Set(achievementIds)];
    const seenKey = key(guildId, record.metric, record.sourceKey);
    const existing = this.seen.get(seenKey);
    let fresh = false;
    let counted = false;

    const incoming: SeenState = !record.pending
      ? 'counted'
      : record.groupKey === null
        ? 'pending'
        : (this.seen.get(key(guildId, GROUP_RELEASE_METRIC, record.groupKey))?.state ?? 'pending');

    if (!existing) {
      this.seen.set(seenKey, {
        guildId,
        metric: record.metric,
        sourceKey: record.sourceKey,
        userId,
        occurredAt: record.occurredAt,
        state: incoming,
        groupKey: record.groupKey,
        channelId: record.channelId,
        parentId: record.parentId,
        categoryId: record.categoryId,
        seenAt: this.#now(),
      });
      fresh = true;
      counted = incoming === 'counted';
    } else if (existing.state === 'pending' && incoming === 'counted') {
      existing.state = 'counted';
      fresh = true;
      counted = true;
    }

    if (counted) {
      const hour = hourFloor(record.occurredAt);
      const channelKey = record.channelId ?? '';
      const xpSource = record.xpSource ?? '';
      const bucketKey = key(
        guildId,
        userId,
        record.metric,
        hour,
        channelKey,
        String(record.temporary),
        xpSource,
      );
      const bucket = this.activity.get(bucketKey);

      if (bucket) {
        bucket.amountSum += record.amount;
        if (record.amount >= bucket.amountMax) {
          bucket.amountMax = record.amount;
          bucket.spanStart = record.spanStart;
        }
        bucket.events += 1;
        bucket.parentId = record.parentId;
        bucket.categoryId = record.categoryId;
      } else {
        this.activity.set(bucketKey, {
          guildId,
          userId,
          metric: record.metric,
          hour,
          channelKey,
          channelId: record.channelId,
          parentId: record.parentId,
          categoryId: record.categoryId,
          temporary: record.temporary,
          xpSource,
          amountSum: record.amount,
          amountMax: record.amount,
          spanStart: record.spanStart,
          events: 1,
        });
      }
    }

    const distinct = new Map<string, ProgressTarget>();
    for (const target of targets) {
      if (!(target.amount > 0)) continue;
      const targetKey = key(target.achievementId, target.requirementId);
      if (!distinct.has(targetKey)) distinct.set(targetKey, target);
    }

    const perTarget = record.metric === 'active_days';
    const applying = perTarget || counted ? [...distinct.values()] : [];

    for (const target of applying) {
      const effective = this.#effective(guildId, target.achievementId, userId);
      if (effective.countedFrom !== null && record.occurredAt < effective.countedFrom) continue;
      if (perTarget && !this.#markTarget(record, target, effective.generation)) continue;

      this.#upsertProgress(
        guildId,
        userId,
        { ...target, amount: Math.floor(target.amount), generation: effective.generation },
        target.aggregate === 'max' ? Math.max : (a, b) => a + b,
      );
    }

    return { fresh, states: this.#states(guildId, userId, ids) };
  }

  // A day is deduplicated per target as well as globally, so one consumed while no achievement
  // accepted it still counts for one that starts, resumes or is created later that day.
  #markTarget(record: ActivityRecord, target: ProgressTarget, generation: number): boolean {
    const sourceKey = [
      target.achievementId,
      target.requirementId,
      generation,
      record.sourceKey,
    ].join(':');
    const rowKey = key(record.guildId, ACTIVE_DAY_TARGET_METRIC, sourceKey);
    if (this.seen.has(rowKey)) return false;

    this.seen.set(rowKey, {
      guildId: record.guildId,
      metric: ACTIVE_DAY_TARGET_METRIC,
      sourceKey,
      userId: record.userId,
      occurredAt: record.occurredAt,
      state: 'counted',
      groupKey: null,
      channelId: null,
      parentId: null,
      categoryId: null,
      seenAt: this.#now(),
    });
    return true;
  }

  async releasePending(
    guildId: string,
    groupKey: string,
    outcome: 'count' | 'void',
    origin: PendingOrigin,
  ): Promise<ActivityRecord[]> {
    const rows = [...this.seen.values()].filter(
      (row) => row.guildId === guildId && row.groupKey === groupKey,
    );

    // The marker carries no group_key, so it is never one of the rows released below.
    const markerKey = key(guildId, GROUP_RELEASE_METRIC, groupKey);
    if (!this.seen.has(markerKey)) {
      this.seen.set(markerKey, {
        guildId,
        metric: GROUP_RELEASE_METRIC,
        sourceKey: groupKey,
        userId: MODULE_ROW,
        occurredAt: this.#now(),
        state: outcome === 'count' ? 'counted' : 'void',
        groupKey: null,
        channelId: null,
        parentId: null,
        categoryId: null,
        seenAt: this.#now(),
      });
    }

    if (outcome === 'void') {
      for (const row of rows) if (row.state === 'pending') row.state = 'void';
      return [];
    }

    return rows
      .filter((row) => row.state === 'pending' || row.state === 'counted')
      .sort(
        (a, b) =>
          a.occurredAt - b.occurredAt ||
          byText(a.userId, b.userId) ||
          byText(a.sourceKey, b.sourceKey),
      )
      .map((row) => ({
        guildId,
        userId: row.userId,
        metric: ledgerMetric(row.metric),
        sourceKey: row.sourceKey,
        occurredAt: row.occurredAt,
        spanStart: null,
        amount: 1,
        channelId: row.channelId,
        parentId: row.parentId,
        categoryId: row.categoryId,
        temporary: false,
        xpSource: null,
        groupKey,
        pending: false,
        sourceModule: origin.sourceModule,
        causation: clone(origin.causation),
      }));
  }

  async setValues(guildId: string, userId: string, values: readonly StateValue[]): Promise<void> {
    const distinct = new Map<string, StateValue>();
    for (const value of values) distinct.set(key(value.achievementId, value.requirementId), value);

    for (const value of distinct.values()) {
      const effective = this.#effective(guildId, value.achievementId, userId);
      this.#upsertProgress(
        guildId,
        userId,
        {
          achievementId: value.achievementId,
          requirementId: value.requirementId,
          version: value.version,
          generation: effective.generation,
          amount: Math.max(0, Math.floor(value.value)),
        },
        (_stored, incoming) => incoming,
      );
    }
  }

  async memberStates(
    guildId: string,
    userId: string,
    achievementIds: readonly string[],
  ): Promise<MemberAchievementState[]> {
    return this.#states(guildId, userId, [...new Set(achievementIds)]);
  }

  async unlock(input: UnlockInput): Promise<UnlockResult> {
    const { guildId, userId, achievementId } = input;
    this.#ensureState(guildId, achievementId);
    this.#ensureMember(guildId, achievementId, userId);

    const effective = this.#effective(guildId, achievementId, userId);
    if (effective.generation !== input.generation || effective.rewardEpoch !== input.rewardEpoch) {
      return { stale: true, unlocks: [], rewards: [] };
    }

    const tiers = [...new Map(input.tiers.map((tier) => [tier.tierId, tier])).values()];
    const unlocks: UnlockRow[] = [];
    const rewards: RewardRow[] = [];

    for (const tier of tiers) {
      const row: UnlockRow = {
        guildId,
        userId,
        achievementId,
        tierId: tier.tierId,
        generation: input.generation,
        tierIndex: tier.tierIndex,
        unlockedAt: input.unlockedAt,
        revision: tier.revision,
        definition: clone(tier.definition),
        progress: clone(tier.progress),
        cause: clone(input.cause),
        originChannelId: input.originChannelId,
        announceGroup: input.announceGroup,
        announceStatus: input.announce,
        announceAttempts: 0,
        announceLeaseUntil: null,
        announceError: null,
        announcedAt: null,
        announceMessageId: null,
        publishedAt: null,
        voidedAt: null,
        voidedBy: null,
      };
      const rowKey = unlockKey(row);
      if (this.unlocks.has(rowKey)) continue;

      this.unlocks.set(rowKey, row);
      unlocks.push(clone(row));

      const byKey = new Map(tier.definition.rewards.map((reward) => [rewardKeyOf(reward), reward]));

      for (const [rewardKey, reward] of byKey) {
        const given = [...this.rewards.values()].some(
          (other) =>
            other.guildId === guildId &&
            other.userId === userId &&
            other.achievementId === achievementId &&
            other.tierId === tier.tierId &&
            other.rewardKey === rewardKey &&
            other.rewardEpoch === input.rewardEpoch &&
            other.generation < input.generation &&
            (other.status === 'delivered' ||
              other.status === 'delivering' ||
              other.status === 'requested'),
        );

        const created: RewardRow = {
          guildId,
          userId,
          achievementId,
          tierId: tier.tierId,
          generation: input.generation,
          rewardKey,
          rewardEpoch: input.rewardEpoch,
          kind: reward.kind,
          roleId: reward.kind === 'xp' ? null : reward.roleId,
          amount: reward.kind === 'xp' ? reward.amount : null,
          status: given ? 'skipped' : 'pending',
          attempts: 0,
          leaseUntil: null,
          nextAttemptAt: null,
          transient: false,
          errorCode: null,
          error: given ? ALREADY_GIVEN : null,
          requestedAt: null,
          deliveredAt: null,
          createdAt: input.unlockedAt,
          updatedAt: input.unlockedAt,
        };

        const createdKey = rewardRefKey(created);
        if (this.rewards.has(createdKey)) continue;
        this.rewards.set(createdKey, created);
        rewards.push(clone(created));
      }
    }

    return { stale: false, unlocks, rewards };
  }

  async publishable(guildId: string, limit: number): Promise<UnlockRow[]> {
    return [...this.unlocks.values()]
      .filter((row) => row.guildId === guildId && row.publishedAt === null && row.voidedAt === null)
      .sort(
        (a, b) =>
          a.unlockedAt - b.unlockedAt ||
          byText(a.userId, b.userId) ||
          byText(a.achievementId, b.achievementId) ||
          a.tierIndex - b.tierIndex,
      )
      .slice(0, Math.max(0, Math.floor(limit)))
      .map(clone);
  }

  async markPublished(rows: readonly UnlockRow[], now: number): Promise<void> {
    for (const row of rows) {
      const stored = this.unlocks.get(unlockKey(row));
      if (stored && stored.publishedAt === null) stored.publishedAt = now;
    }
  }

  async claimReward(
    ref: RewardRef,
    now: number,
    leaseMs: number,
    opts: { manual?: boolean } = {},
  ): Promise<RewardClaim | null> {
    const row = this.rewards.get(rewardRefKey(ref));
    if (!row) return null;

    const manual = opts.manual === true;
    const claimable =
      row.status === 'pending' ||
      (row.status === 'failed' &&
        row.transient &&
        (row.nextAttemptAt === null || row.nextAttemptAt <= now)) ||
      ((row.status === 'delivering' || row.status === 'requested') &&
        (row.leaseUntil === null || row.leaseUntil <= now)) ||
      (manual && row.status === 'failed');

    if (!claimable || (!manual && row.attempts >= MAX_REWARD_ATTEMPTS)) return null;

    const xp = row.kind === 'xp';
    row.status = xp ? 'requested' : 'delivering';
    row.attempts += 1;
    row.leaseUntil = now + (xp ? XP_CONFIRM_TIMEOUT_MS : leaseMs);
    if (xp) row.requestedAt = now;
    row.nextAttemptAt = null;
    row.transient = false;
    row.errorCode = null;
    row.error = null;
    row.updatedAt = now;

    return { row: clone(row), token: row.attempts };
  }

  async finishReward(ref: RewardRef, token: number, outcome: RewardOutcome): Promise<boolean> {
    const row = this.rewards.get(rewardRefKey(ref));
    if (!row || row.attempts !== token) return false;
    if (row.status !== 'delivering' && row.status !== 'requested') return false;

    const transient =
      outcome.status === 'failed' &&
      outcome.transient === true &&
      row.attempts < MAX_REWARD_ATTEMPTS;

    row.status = outcome.status;
    row.transient = transient;
    row.nextAttemptAt = transient ? (outcome.nextAttemptAt ?? outcome.now) : null;
    row.errorCode = outcome.errorCode ?? null;
    row.error = outcome.error ?? null;
    row.leaseUntil = null;
    if (outcome.status === 'delivered') row.deliveredAt = outcome.now;
    row.updatedAt = outcome.now;

    return true;
  }

  async confirmXpGrant(
    guildId: string,
    grantId: string,
    outcome: XpGrantOutcome,
  ): Promise<RewardRow | null> {
    const grant = parseXpGrantId(grantId);
    if (!grant || grant.guildId !== guildId) return null;

    const row = [...this.rewards.values()]
      .filter(
        (candidate) =>
          candidate.guildId === guildId &&
          candidate.userId === grant.userId &&
          candidate.achievementId === grant.achievementId &&
          candidate.tierId === grant.tierId &&
          candidate.rewardKey === 'xp' &&
          candidate.rewardEpoch === grant.rewardEpoch &&
          ['requested', 'delivering', 'failed', 'cancelled', 'delivered'].includes(
            candidate.status,
          ),
      )
      .sort((a, b) => b.generation - a.generation)[0];

    if (!row) return null;

    const settle = outcome.granted
      ? row.status !== 'delivered'
      : row.status === 'requested' || row.status === 'delivering' || row.status === 'failed';
    if (!settle) return clone(row);

    row.status = outcome.granted ? 'delivered' : 'failed';
    row.transient = false;
    row.nextAttemptAt = null;
    row.leaseUntil = null;
    row.errorCode = null;
    row.error = outcome.granted ? null : (outcome.error ?? XP_REFUSED);
    row.deliveredAt = outcome.granted ? outcome.now : null;
    row.updatedAt = outcome.now;

    return clone(row);
  }

  async rewardsFor(
    guildId: string,
    userId: string,
    achievementId: string,
    generation: number,
  ): Promise<RewardRow[]> {
    return [...this.rewards.values()]
      .filter(
        (row) =>
          row.guildId === guildId &&
          row.userId === userId &&
          row.achievementId === achievementId &&
          row.generation === generation,
      )
      .sort((a, b) => rank(a.tierId) - rank(b.tierId) || byText(a.rewardKey, b.rewardKey))
      .map(clone);
  }

  #rewardOpen(row: RewardRow): boolean {
    return (
      row.status === 'pending' ||
      row.status === 'delivering' ||
      row.status === 'requested' ||
      (row.status === 'failed' && row.transient && row.attempts < MAX_REWARD_ATTEMPTS)
    );
  }

  #rewardDue(row: RewardRow): number {
    if (row.status === 'pending') return row.createdAt;
    if (row.status === 'failed') return row.nextAttemptAt ?? row.updatedAt;
    return row.leaseUntil ?? row.updatedAt;
  }

  async dueWork(guildId: string, now: number, limit: number): Promise<DueWork> {
    const take = Math.max(0, Math.floor(limit));
    const open = [...this.rewards.values()].filter(
      (row) => row.guildId === guildId && this.#rewardOpen(row),
    );

    const rewards = open
      .filter((row) => {
        if (row.status === 'pending') return true;
        if (row.status === 'failed') return row.nextAttemptAt === null || row.nextAttemptAt <= now;
        return row.leaseUntil === null || row.leaseUntil <= now;
      })
      .sort(REWARD_ORDER)
      .slice(0, take)
      .map(clone);

    const pending = [...this.unlocks.values()].filter(
      (row) => row.guildId === guildId && row.announceStatus === 'pending' && row.voidedAt === null,
    );

    const grouped = new Map<string, UnlockRow[]>();
    for (const row of pending) {
      const list = grouped.get(row.announceGroup) ?? [];
      list.push(row);
      grouped.set(row.announceGroup, list);
    }

    const groups = [...grouped].map(([group, rows]) => {
      const settled = rows.every(
        (row) =>
          ![...this.rewards.values()].some(
            (reward) =>
              reward.guildId === row.guildId &&
              reward.userId === row.userId &&
              reward.achievementId === row.achievementId &&
              reward.tierId === row.tierId &&
              reward.generation === row.generation &&
              (reward.status === 'pending' ||
                reward.status === 'delivering' ||
                reward.status === 'requested' ||
                (reward.status === 'failed' && reward.transient)),
          ),
      );
      const oldest = Math.min(...rows.map((row) => row.unlockedAt));
      const leases = rows
        .map((row) => row.announceLeaseUntil)
        .filter((at): at is number => at !== null);
      const lease = leases.length > 0 ? Math.max(...leases) : null;
      const due = Math.max(lease ?? oldest, settled ? oldest : oldest + XP_CONFIRM_TIMEOUT_MS);

      const entry: AnnounceGroup = {
        group,
        userId: rows.map((row) => row.userId).sort(byText)[0] ?? '',
        achievementId: rows.map((row) => row.achievementId).sort(byText)[0] ?? '',
        generation: Math.min(...rows.map((row) => row.generation)),
        oldestUnlockedAt: oldest,
        attempts: Math.max(...rows.map((row) => row.announceAttempts)),
        rewardsSettled: settled,
      };

      return { due, group: entry };
    });
    groups.sort((a, b) => a.due - b.due || byText(a.group.group, b.group.group));

    const unpublishedAll = [...this.unlocks.values()].filter(
      (row) => row.guildId === guildId && row.publishedAt === null && row.voidedAt === null,
    );

    const candidates = [
      open.length > 0 ? Math.min(...open.map((row) => this.#rewardDue(row))) : null,
      unpublishedAll.length > 0 ? Math.min(...unpublishedAll.map((row) => row.unlockedAt)) : null,
      groups[0]?.due ?? null,
    ].filter((due): due is number => due !== null);

    return {
      rewards,
      groups: groups
        .filter((entry) => entry.due <= now)
        .slice(0, take)
        .map((entry) => entry.group),
      unpublished: await this.publishable(guildId, take),
      nextDueAt: candidates.length > 0 ? Math.min(...candidates) : null,
    };
  }

  async claimAnnouncement(
    guildId: string,
    group: string,
    now: number,
    leaseMs: number,
  ): Promise<AnnouncementClaim | null> {
    const rows = [...this.unlocks.values()].filter(
      (row) =>
        row.guildId === guildId &&
        row.announceGroup === group &&
        row.announceStatus === 'pending' &&
        row.voidedAt === null,
    );

    if (rows.length === 0) return null;
    if (rows.some((row) => row.announceLeaseUntil !== null && row.announceLeaseUntil > now)) {
      return null;
    }

    const attempt = Math.max(...rows.map((row) => row.announceAttempts)) + 1;
    for (const row of rows) {
      row.announceAttempts = attempt;
      row.announceLeaseUntil = now + leaseMs;
    }

    return {
      rows: rows.map(clone).sort((a, b) => a.tierIndex - b.tierIndex || byText(a.tierId, b.tierId)),
      attempt,
    };
  }

  async finishAnnouncement(
    guildId: string,
    group: string,
    attempt: number,
    outcome: AnnouncementOutcome,
  ): Promise<void> {
    for (const row of this.unlocks.values()) {
      if (
        row.guildId !== guildId ||
        row.announceGroup !== group ||
        row.announceAttempts !== attempt ||
        (row.announceStatus !== 'pending' && row.announceStatus !== 'skipped')
      ) {
        continue;
      }

      row.announceStatus =
        row.voidedAt !== null && outcome.status === 'pending' ? 'skipped' : outcome.status;
      row.announceError = outcome.error ?? null;
      if (outcome.status === 'sent') row.announcedAt = outcome.now;
      row.announceMessageId = outcome.messageId ?? row.announceMessageId;
      row.announceLeaseUntil = null;
    }
  }

  async claimAlmostThere(
    guildId: string,
    userId: string,
    achievementId: string,
    tierId: TierId,
    generation: number,
    now: number,
    cooldownMs: number,
  ): Promise<boolean> {
    const member = this.#ensureMember(guildId, achievementId, userId);
    const effective = this.#effective(guildId, achievementId, userId);

    const cooling = member.almostNotifiedAt !== null && member.almostNotifiedAt > now - cooldownMs;
    if (member.almostNotified.includes(tierId) || cooling) return false;
    if (effective.generation !== generation) return false;

    const unlocked = [...this.unlocks.values()].some(
      (row) =>
        row.guildId === guildId &&
        row.userId === userId &&
        row.achievementId === achievementId &&
        row.tierId === tierId &&
        row.generation === generation &&
        row.voidedAt === null,
    );
    if (unlocked) return false;

    member.almostNotified = [...member.almostNotified, tierId];
    member.almostNotifiedAt = now;
    member.updatedAt = now;
    return true;
  }

  #bag(guildId: string): ModuleBag {
    const parsed = moduleBagSchema.safeParse(this.#state(guildId, MODULE_ROW)?.jobResult ?? {});
    return parsed.success ? parsed.data : {};
  }

  #mergeBag(guildId: string, patch: ModuleBag): void {
    const row = this.#ensureState(guildId, MODULE_ROW);
    const current = this.#bag(guildId);
    row.jobResult = {
      ...current,
      ...(patch.anniversaryRunAt !== undefined ? { anniversaryRunAt: patch.anniversaryRunAt } : {}),
      ...(patch.rebuilt ? { rebuilt: { ...(current.rebuilt ?? {}), ...patch.rebuilt } } : {}),
    };
    row.updatedAt = this.#now();
  }

  async syncPeriods(
    guildId: string,
    at: number,
    opts: { openOnly?: boolean } = {},
  ): Promise<{ firstActivation: string[]; reopened: string[] }> {
    const row = this.modules.get(guildId);
    const parsed = row ? achievementsConfigSchema.safeParse(row.config) : null;
    const config = parsed?.success ? parsed.data : null;
    const moduleOn = row?.enabled === true && config?.enabled === true;
    const active =
      moduleOn && config
        ? config.achievements.filter((achievement) => achievement.status === 'active')
        : [];
    const wanted = new Set(moduleOn ? [MODULE_ROW, ...active.map((a) => a.id)] : []);

    const mine = this.periods.filter((period) => period.guildId === guildId);
    const open = new Set(mine.filter((p) => p.endedAt === null).map((p) => p.achievementId));
    const opening = [...wanted].filter((id) => !open.has(id));

    for (const id of opening) {
      const ends = mine
        .filter((period) => period.achievementId === id && period.endedAt !== null)
        .map((period) => period.endedAt as number);
      const start = Math.max(at, ...ends);
      const existing = mine.find(
        (period) => period.achievementId === id && period.startedAt === start,
      );

      if (existing) existing.endedAt = null;
      else this.periods.push({ guildId, achievementId: id, startedAt: start, endedAt: null });
    }

    if (!opts.openOnly) {
      for (const period of this.periods) {
        if (
          period.guildId === guildId &&
          period.endedAt === null &&
          open.has(period.achievementId) &&
          !wanted.has(period.achievementId)
        ) {
          period.endedAt = Math.max(period.startedAt, at);
        }
      }
    }

    const firstActivation: string[] = [];
    const reopened: string[] = [];
    for (const id of opening) {
      const state = this.#ensureState(guildId, id);
      if (state.firstActiveAt !== null) {
        if (id !== MODULE_ROW) reopened.push(id);
        continue;
      }
      state.firstActiveAt = at;
      state.updatedAt = this.#now();
      if (id !== MODULE_ROW) firstActivation.push(id);
    }
    firstActivation.sort(byText);
    reopened.sort(byText);

    const signatures: Record<string, string> = {};
    for (const achievement of active) {
      if (firstActivation.includes(achievement.id)) {
        signatures[achievement.id] = rebuildSignature(achievement);
      }
    }
    if (Object.keys(signatures).length > 0) this.#mergeBag(guildId, { rebuilt: signatures });

    return { firstActivation, reopened };
  }

  async runtime(guildId: string): Promise<GuildRuntime> {
    const periods = this.periods
      .filter((period) => period.guildId === guildId)
      .sort((a, b) => byText(a.achievementId, b.achievementId) || a.startedAt - b.startedAt);

    const modulePeriods: Interval[] = [];
    const byAchievement = new Map<string, Interval[]>();

    for (const period of periods) {
      const interval = { start: period.startedAt, end: period.endedAt };
      if (period.achievementId === MODULE_ROW) modulePeriods.push(interval);
      else {
        const list = byAchievement.get(period.achievementId) ?? [];
        list.push(interval);
        byAchievement.set(period.achievementId, list);
      }
    }

    const rebuilt = this.#bag(guildId).rebuilt ?? {};
    const state = new Map<string, AchievementRuntimeState>();

    for (const row of this.states.values()) {
      if (row.guildId !== guildId || row.achievementId === MODULE_ROW) continue;
      state.set(row.achievementId, {
        generation: row.generation,
        rewardEpoch: row.rewardEpoch,
        countedFrom: row.countedFrom,
        firstActiveAt: row.firstActiveAt,
        rebuiltWith: rebuilt[row.achievementId] ?? null,
      });
    }

    return { modulePeriods, periods: byAchievement, state };
  }

  async upsertFacts(guildId: string, userId: string, facts: FactsPatch): Promise<void> {
    const rowKey = key(guildId, userId);
    const existing = this.factRows.get(rowKey);
    const row: FactsRow = existing ?? {
      guildId,
      userId,
      joinedAt: null,
      premiumSince: null,
      leftAt: null,
      updatedAt: this.#now(),
    };

    if (facts.joinedAt !== undefined) row.joinedAt = facts.joinedAt;
    if (facts.premiumSince !== undefined) row.premiumSince = facts.premiumSince;
    if (facts.leftAt !== undefined) row.leftAt = facts.leftAt;
    row.updatedAt = this.#now();

    this.factRows.set(rowKey, row);
  }

  async facts(guildId: string, userId: string): Promise<MemberFacts | null> {
    const row = this.factRows.get(key(guildId, userId));
    if (!row) return null;
    const { guildId: _guild, ...facts } = row;
    return { ...facts };
  }

  async anniversaryCandidates(
    guildId: string,
    windows: readonly AnniversaryWindow[],
    afterUserId: string | null,
    limit: number,
  ): Promise<MemberFacts[]> {
    return [...this.factRows.values()]
      .filter(
        (row) =>
          row.guildId === guildId &&
          row.leftAt === null &&
          row.joinedAt !== null &&
          (afterUserId === null || row.userId > afterUserId) &&
          windows.some(
            (window) =>
              row.joinedAt !== null && row.joinedAt > window.from && row.joinedAt <= window.to,
          ),
      )
      .sort((a, b) => byText(a.userId, b.userId))
      .slice(0, Math.max(0, Math.floor(limit)))
      .map(({ guildId: _guild, ...facts }) => ({ ...facts }));
  }

  async anniversaryRunAt(guildId: string): Promise<number | null> {
    return this.#bag(guildId).anniversaryRunAt ?? null;
  }

  async setAnniversaryRunAt(guildId: string, at: number): Promise<void> {
    this.#mergeBag(guildId, { anniversaryRunAt: at });
  }

  async putBadge(guildId: string, asset: BadgeAsset): Promise<void> {
    const rowKey = key(guildId, asset.assetId);
    const existing = this.badges.get(rowKey);

    if (existing) {
      existing.uploadedBy = asset.uploadedBy;
      existing.uploadedAt = asset.uploadedAt;
      return;
    }

    this.badges.set(rowKey, { guildId, ...asset });
  }

  async badge(
    guildId: string,
    assetId: string,
  ): Promise<{ contentType: string; base64: string } | null> {
    const row = this.badges.get(key(guildId, assetId));
    return row ? { contentType: row.contentType, base64: row.base64 } : null;
  }

  async pruneBadges(guildId: string, keep: readonly string[], olderThan: number): Promise<number> {
    let pruned = 0;

    for (const [rowKey, row] of this.badges) {
      if (row.guildId === guildId && !keep.includes(row.assetId) && row.uploadedAt < olderThan) {
        this.badges.delete(rowKey);
        pruned += 1;
      }
    }

    return pruned;
  }

  async rebuildSlice(
    guildId: string,
    plan: RebuildPlan,
    cursor: string | null,
    mode: RebuildMode,
  ): Promise<RebuildSliceResult> {
    const empty: RebuildSliceResult = {
      cursor: null,
      members: 0,
      changed: 0,
      lost: 0,
      newlyEarned: { ...NO_NEWLY_EARNED },
    };
    if (plan.requirements.length === 0) return empty;

    const metrics = new Set<string>(plan.requirements.map((requirement) => requirement.metric));
    const earliest =
      plan.windows.length > 0 ? Math.min(...plan.windows.map((window) => window.start)) : null;
    const after = (userId: string) => cursor === null || userId > cursor;

    const candidates = new Set<string>();
    for (const row of this.activity.values()) {
      if (
        earliest !== null &&
        row.guildId === guildId &&
        metrics.has(row.metric) &&
        row.hour >= earliest &&
        after(row.userId)
      ) {
        candidates.add(row.userId);
      }
    }
    for (const row of this.progress.values()) {
      if (
        row.guildId === guildId &&
        row.achievementId === plan.achievementId &&
        after(row.userId)
      ) {
        candidates.add(row.userId);
      }
    }

    const userIds = [...candidates].sort(byText).slice(0, JOB_SLICE);
    const achievementId = plan.achievementId;
    const remember = { rebuilt: { [achievementId]: plan.signature } };

    if (userIds.length === 0) {
      if (mode === 'write') this.#mergeBag(guildId, remember);
      return empty;
    }

    if (mode === 'write') {
      this.#ensureState(guildId, achievementId);
      for (const userId of userIds) {
        const generation = this.#effective(guildId, achievementId, userId).generation;
        for (const requirement of plan.requirements) {
          const rowKey = key(guildId, achievementId, requirement.requirementId, userId);
          if (this.progress.has(rowKey)) continue;
          this.progress.set(rowKey, {
            guildId,
            achievementId,
            requirementId: requirement.requirementId,
            userId,
            value: 0,
            version: requirement.version,
            generation,
            updatedAt: this.#now(),
          });
        }
      }
    }

    const inputs: RebuildMemberInput[] = userIds.map((userId) => {
      const effective = this.#effective(guildId, achievementId, userId);
      const buckets = [...this.activity.values()].filter(
        (row) => row.guildId === guildId && row.userId === userId,
      );

      const rebuilt: Record<string, number> = {};
      for (const requirement of plan.requirements) {
        const counted = buckets.filter((bucket) =>
          bucketCounts(requirement, bucket, plan.windows, effective.countedFrom),
        );
        rebuilt[requirement.requirementId] =
          requirement.aggregate === 'max'
            ? Math.max(
                0,
                ...counted.map((bucket) => maxInWindow(bucket, bucket.amountMax, plan.windows)),
              )
            : counted.reduce((sum, bucket) => sum + bucket.amountSum, 0);
      }

      const current: Record<string, { value: number; version: number; generation: number }> = {};
      for (const row of this.progress.values()) {
        if (
          row.guildId === guildId &&
          row.achievementId === achievementId &&
          row.userId === userId
        ) {
          current[row.requirementId] = {
            value: row.value,
            version: row.version,
            generation: row.generation,
          };
        }
      }

      const unlocked = [...this.unlocks.values()]
        .filter(
          (row) =>
            row.guildId === guildId &&
            row.userId === userId &&
            row.achievementId === achievementId &&
            row.voidedAt === null &&
            row.generation === effective.generation,
        )
        .map((row) => row.tierId);

      return { userId, generation: effective.generation, rebuilt, current, unlocked };
    });

    const outcome = rebuildOutcome(plan, inputs);

    if (mode === 'write') {
      for (const write of outcome.writes) {
        const row = this.progress.get(
          key(guildId, achievementId, write.requirementId, write.userId),
        );
        if (!row) continue;
        row.value = write.value;
        row.version = write.version;
        row.generation = write.generation;
        row.updatedAt = this.#now();
      }
    }

    const next = userIds.length < JOB_SLICE ? null : (userIds[userIds.length - 1] ?? null);
    if (mode === 'write' && next === null) this.#mergeBag(guildId, remember);

    return {
      cursor: next,
      members: userIds.length,
      changed: outcome.changed,
      lost: outcome.lost,
      newlyEarned: outcome.newlyEarned,
    };
  }

  async membersForRecheck(
    guildId: string,
    achievementId: string,
    cursor: string | null,
    limit: number,
    opts: { unlockedIn?: readonly string[] | 'any' } = {},
  ): Promise<{ userIds: string[]; cursor: string | null }> {
    const take = Math.max(1, Math.floor(limit));
    const after = (userId: string) => cursor === null || userId > cursor;
    const unlockedIn = opts.unlockedIn;
    const found = new Set<string>();

    for (const row of this.progress.values()) {
      if (row.guildId === guildId && row.achievementId === achievementId && after(row.userId)) {
        found.add(row.userId);
      }
    }

    if (unlockedIn !== undefined) {
      for (const row of this.unlocks.values()) {
        if (
          row.guildId === guildId &&
          row.voidedAt === null &&
          after(row.userId) &&
          (unlockedIn === 'any' || unlockedIn.includes(row.achievementId))
        ) {
          found.add(row.userId);
        }
      }
    }

    const userIds = [...found].sort(byText).slice(0, take);
    return {
      userIds,
      cursor: userIds.length < take ? null : (userIds[userIds.length - 1] ?? null),
    };
  }

  async setJob(guildId: string, achievementId: string, patch: JobPatch): Promise<void> {
    const row = this.#ensureState(guildId, achievementId);

    if (patch.job !== undefined) row.job = patch.job;
    if (patch.status !== undefined) row.jobStatus = patch.status;
    if (patch.cursor !== undefined) row.jobCursor = patch.cursor;
    if (patch.requestedAt !== undefined) row.jobRequestedAt = patch.requestedAt;
    if (patch.requestedBy !== undefined) row.jobRequestedBy = patch.requestedBy;
    if (patch.finishedAt !== undefined) row.jobFinishedAt = patch.finishedAt;
    if (patch.result !== undefined) row.jobResult = clone(patch.result);
    if (patch.announce !== undefined) row.jobAnnounce = patch.announce;
    if (patch.acceptLoss !== undefined) row.jobAcceptLoss = patch.acceptLoss;
    row.updatedAt = this.#now();
  }

  #jobOf(row: StateRow): JobState {
    const result = jobResultSchema.safeParse(row.jobResult);
    return {
      achievementId: row.achievementId,
      job: row.job,
      status: row.jobStatus,
      cursor: row.jobCursor,
      requestedAt: row.jobRequestedAt,
      requestedBy: row.jobRequestedBy,
      finishedAt: row.jobFinishedAt,
      result: result.success ? result.data : null,
      announce: row.jobAnnounce,
      acceptLoss: row.jobAcceptLoss,
    };
  }

  async job(guildId: string, achievementId: string): Promise<JobState | null> {
    if (achievementId === MODULE_ROW) return null;
    const row = this.#state(guildId, achievementId);
    return row ? this.#jobOf(row) : null;
  }

  async jobs(guildId: string): Promise<JobState[]> {
    return [...this.states.values()]
      .filter(
        (row) => row.guildId === guildId && row.achievementId !== MODULE_ROW && row.job !== null,
      )
      .sort((a, b) => byText(a.achievementId, b.achievementId))
      .map((row) => this.#jobOf(row));
  }

  #audit(entry: NewAuditTrailEntry): boolean {
    if (this.audits.some((existing) => existing.id === entry.id)) return false;
    this.audits.push(clone(entry));
    return true;
  }

  #void(
    guildId: string,
    achievementIds: readonly string[],
    userId: string | null,
    actorId: string,
    at: number,
  ): void {
    for (const row of this.unlocks.values()) {
      if (
        row.guildId !== guildId ||
        !achievementIds.includes(row.achievementId) ||
        (userId !== null && row.userId !== userId) ||
        row.voidedAt !== null
      ) {
        continue;
      }

      row.voidedAt = at;
      row.voidedBy = actorId;
      if (row.announceStatus === 'pending') {
        row.announceStatus = 'skipped';
        row.announceError = RESET_BEFORE_ANNOUNCED;
      }
    }

    for (const row of this.rewards.values()) {
      if (
        row.guildId !== guildId ||
        !achievementIds.includes(row.achievementId) ||
        (userId !== null && row.userId !== userId) ||
        !(row.status === 'pending' || row.status === 'failed')
      ) {
        continue;
      }

      row.status = 'cancelled';
      row.transient = false;
      row.nextAttemptAt = null;
      row.leaseUntil = null;
      row.error = CANCELLED_BY_RESET;
      row.updatedAt = at;
    }
  }

  async resetMember(input: ResetMemberInput): Promise<{ achievements: number }> {
    if (!this.#audit(input.audit)) return { achievements: 0 };

    const ids = [...new Set(input.achievementIds)];
    for (const achievementId of ids) {
      const member = this.#ensureMember(input.guildId, achievementId, input.userId);
      member.generation += 1;
      member.rewardEpoch += input.allowRewardsAgain ? 1 : 0;
      member.countedFrom = input.at;
      member.resetAt = input.at;
      member.resetBy = input.actorId;
      member.almostNotified = [];
      member.almostNotifiedAt = null;
      member.updatedAt = input.at;
    }

    this.#void(input.guildId, ids, input.userId, input.actorId, input.at);
    return { achievements: ids.length };
  }

  async resetAchievement(input: ResetAchievementInput): Promise<{ members: number }> {
    if (!this.#audit(input.audit)) return { members: 0 };

    const { guildId, achievementId } = input;
    const touched = new Set<string>();

    for (const row of this.unlocks.values()) {
      if (row.guildId === guildId && row.achievementId === achievementId && row.voidedAt === null) {
        touched.add(row.userId);
      }
    }
    for (const row of this.progress.values()) {
      if (
        row.guildId === guildId &&
        row.achievementId === achievementId &&
        row.value > 0 &&
        row.generation === this.#effective(guildId, achievementId, row.userId).generation
      ) {
        touched.add(row.userId);
      }
    }

    const state = this.#ensureState(guildId, achievementId);
    state.generation += 1;
    state.rewardEpoch += input.allowRewardsAgain ? 1 : 0;
    state.countedFrom = input.at;
    state.resetAt = input.at;
    state.resetBy = input.actorId;
    state.updatedAt = input.at;

    for (const member of this.members.values()) {
      if (
        member.guildId === guildId &&
        member.achievementId === achievementId &&
        (member.almostNotified.length > 0 || member.almostNotifiedAt !== null)
      ) {
        member.almostNotified = [];
        member.almostNotifiedAt = null;
        member.updatedAt = input.at;
      }
    }

    this.#void(guildId, [achievementId], null, input.actorId, input.at);
    return { members: touched.size };
  }

  async unlocksOf(guildId: string, userId: string): Promise<UnlockRow[]> {
    return this.#currentUnlocks(guildId, userId).sort(UNLOCK_ORDER).map(clone);
  }

  async earnedCount(
    guildId: string,
    userId: string,
    excludeIds: readonly string[],
  ): Promise<number> {
    return new Set(
      this.#currentUnlocks(guildId, userId)
        .map((row) => row.achievementId)
        .filter((id) => !excludeIds.includes(id)),
    ).size;
  }

  async topBadges(guildId: string, userId: string, limit: number): Promise<UnlockRow[]> {
    const best = new Map<string, UnlockRow>();

    for (const row of this.#currentUnlocks(guildId, userId)) {
      const held = best.get(row.achievementId);
      if (
        !held ||
        rank(row.tierId) > rank(held.tierId) ||
        (rank(row.tierId) === rank(held.tierId) && row.unlockedAt > held.unlockedAt)
      ) {
        best.set(row.achievementId, row);
      }
    }

    return [...best.values()]
      .sort(
        (a, b) =>
          rank(b.tierId) - rank(a.tierId) ||
          b.unlockedAt - a.unlockedAt ||
          byText(a.achievementId, b.achievementId),
      )
      .slice(0, Math.max(0, Math.floor(limit)))
      .map(clone);
  }

  async holders(guildId: string): Promise<TierHolders[]> {
    const counts = new Map<string, { achievementId: string; tierId: TierId; users: Set<string> }>();

    for (const row of this.unlocks.values()) {
      if (row.guildId !== guildId || row.voidedAt !== null) continue;
      const groupKey = key(row.achievementId, row.tierId);
      const entry = counts.get(groupKey) ?? {
        achievementId: row.achievementId,
        tierId: row.tierId,
        users: new Set<string>(),
      };
      entry.users.add(row.userId);
      counts.set(groupKey, entry);
    }

    return [...counts.values()]
      .sort((a, b) => byText(a.achievementId, b.achievementId) || rank(a.tierId) - rank(b.tierId))
      .map((entry) => ({
        achievementId: entry.achievementId,
        tierId: entry.tierId,
        members: entry.users.size,
      }));
  }

  async inProgress(guildId: string): Promise<AchievementMembersCount[]> {
    const counts = new Map<string, Set<string>>();

    for (const row of this.progress.values()) {
      if (
        row.guildId !== guildId ||
        row.value <= 0 ||
        row.generation !== this.#effective(guildId, row.achievementId, row.userId).generation
      ) {
        continue;
      }
      const users = counts.get(row.achievementId) ?? new Set<string>();
      users.add(row.userId);
      counts.set(row.achievementId, users);
    }

    return [...counts]
      .sort(([a], [b]) => byText(a, b))
      .map(([achievementId, users]) => ({ achievementId, members: users.size }));
  }

  async rewardCounts(guildId: string): Promise<RewardStatusCount[]> {
    const counts = new Map<string, RewardStatusCount>();

    for (const row of this.rewards.values()) {
      if (row.guildId !== guildId) continue;
      const groupKey = key(row.achievementId, row.status);
      const entry = counts.get(groupKey) ?? {
        achievementId: row.achievementId,
        status: row.status,
        count: 0,
      };
      entry.count += 1;
      counts.set(groupKey, entry);
    }

    return [...counts.values()].sort(
      (a, b) => byText(a.achievementId, b.achievementId) || byText(a.status, b.status),
    );
  }

  async listUnlocks(guildId: string, query: UnlockListQuery): Promise<Page<UnlockRow>> {
    const matching = [...this.unlocks.values()]
      .filter(
        (row) =>
          row.guildId === guildId &&
          row.voidedAt === null &&
          (query.achievementId === undefined || row.achievementId === query.achievementId),
      )
      .sort(
        (a, b) =>
          b.unlockedAt - a.unlockedAt ||
          byText(a.userId, b.userId) ||
          byText(a.achievementId, b.achievementId) ||
          a.tierIndex - b.tierIndex,
      );

    const offset = (query.page - 1) * query.pageSize;
    return {
      items: matching.slice(offset, offset + query.pageSize).map(clone),
      total: matching.length,
    };
  }

  async listRewards(guildId: string, query: RewardListQuery): Promise<Page<RewardRow>> {
    const statuses: readonly string[] =
      query.status === 'failed'
        ? ['failed']
        : query.status === 'pending'
          ? ['pending', 'delivering', 'requested']
          : ['pending', 'delivering', 'requested', 'delivered', 'failed', 'skipped', 'cancelled'];

    const matching = [...this.rewards.values()]
      .filter(
        (row) =>
          row.guildId === guildId &&
          statuses.includes(row.status) &&
          (query.achievementId === undefined || row.achievementId === query.achievementId),
      )
      .sort(
        (a, b) =>
          b.updatedAt - a.updatedAt ||
          byText(a.userId, b.userId) ||
          byText(a.achievementId, b.achievementId) ||
          byText(a.tierId, b.tierId) ||
          byText(a.rewardKey, b.rewardKey),
      );

    const offset = (query.page - 1) * query.pageSize;
    return {
      items: matching.slice(offset, offset + query.pageSize).map(clone),
      total: matching.length,
    };
  }

  async memberDetail(guildId: string, userId: string): Promise<MemberDetailRows> {
    const ids = new Set<string>();
    for (const row of this.progress.values()) {
      if (row.guildId === guildId && row.userId === userId) ids.add(row.achievementId);
    }
    for (const row of this.members.values()) {
      if (row.guildId === guildId && row.userId === userId) ids.add(row.achievementId);
    }

    const unlocks = [...this.unlocks.values()]
      .filter((row) => row.guildId === guildId && row.userId === userId)
      .sort(UNLOCK_ORDER);
    for (const row of unlocks) ids.add(row.achievementId);

    const rewards = [...this.rewards.values()]
      .filter((row) => row.guildId === guildId && row.userId === userId)
      .sort(
        (a, b) =>
          a.createdAt - b.createdAt ||
          byText(a.achievementId, b.achievementId) ||
          a.generation - b.generation ||
          rank(a.tierId) - rank(b.tierId) ||
          byText(a.rewardKey, b.rewardKey),
      );

    return {
      states: this.#states(guildId, userId, [...ids].sort(byText)),
      unlocks: unlocks.filter((row) => row.voidedAt === null).map(clone),
      voided: unlocks.filter((row) => row.voidedAt !== null).map(clone),
      rewards: rewards.map(clone),
      facts: await this.facts(guildId, userId),
    };
  }

  async purge(now: number): Promise<PurgeResult> {
    let activity = 0;
    let seen = 0;
    let facts = 0;

    for (const [rowKey, row] of this.activity) {
      if (row.hour < now - ACTIVITY_RETENTION_DAYS * DAY_MS) {
        this.activity.delete(rowKey);
        activity += 1;
      }
    }

    const retention = { ...SEEN_RETENTION_MS, ...RESERVED_SEEN_RETENTION_MS };

    for (const [rowKey, row] of this.seen) {
      const keep = retention[row.metric];
      if (keep !== null && row.state !== 'pending' && row.seenAt < now - keep) {
        this.seen.delete(rowKey);
        seen += 1;
      }
    }

    for (const [rowKey, row] of this.factRows) {
      if (
        (row.leftAt !== null && row.leftAt < now - 30 * DAY_MS) ||
        (row.joinedAt === null &&
          row.leftAt === null &&
          row.updatedAt < now - ACTIVITY_RETENTION_DAYS * DAY_MS)
      ) {
        this.factRows.delete(rowKey);
        facts += 1;
      }
    }

    return { activity, seen, facts };
  }
}
