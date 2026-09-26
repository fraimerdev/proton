import type {
  AchievementJob,
  AchievementRewardRef,
  Causation,
  TierId,
  XpSource,
} from '@proton/core';
import type { NewAuditTrailEntry } from '@proton/db';
import type { ActivityRecord } from './activity.ts';
import type { Interval } from './evaluate.ts';
import type { LedgerMetric } from './triggers.ts';
import type {
  JobResult,
  JobStatus,
  MemberFactsView,
  RewardListQuery,
  RewardView,
  UnlockCause,
  UnlockDefinition,
  UnlockListQuery,
  UnlockProgress,
  UnlockView,
} from './view.ts';

export type { ActivityRecord } from './activity.ts';
export type { Interval } from './evaluate.ts';

export type ProgressAggregate = 'sum' | 'max';

export interface ProgressTarget {
  achievementId: string;
  requirementId: string;
  version: number;
  aggregate: ProgressAggregate;
  amount: number;
}

export interface RequirementValue {
  value: number;
  version: number;
  generation: number;
}

export interface MemberAchievementState {
  achievementId: string;
  userId: string;
  generation: number;
  rewardEpoch: number;
  countedFrom: number | null;
  values: Record<string, RequirementValue>;
  unlocked: TierId[];
  almostNotified: TierId[];
  almostNotifiedAt: number | null;
}

export interface RecordResult {
  fresh: boolean;
  states: MemberAchievementState[];
}

export interface PendingOrigin {
  sourceModule: string;
  causation: Causation;
}

export interface StateValue {
  achievementId: string;
  requirementId: string;
  version: number;
  value: number;
}

export interface UnlockTierInput {
  tierId: TierId;
  tierIndex: number;
  revision: string;
  definition: UnlockDefinition;
  progress: UnlockProgress;
}

export type UnlockAnnounce = 'pending' | 'suppressed';

export interface UnlockInput {
  guildId: string;
  userId: string;
  achievementId: string;
  generation: number;
  rewardEpoch: number;
  tiers: UnlockTierInput[];
  unlockedAt: number;
  cause: UnlockCause;
  originChannelId: string | null;
  announceGroup: string;
  announce: UnlockAnnounce;
}

export interface UnlockRow extends UnlockView {
  guildId: string;
  announceLeaseUntil: number | null;
}

export interface RewardRow extends RewardView {
  guildId: string;
  leaseUntil: number | null;
}

export interface UnlockResult {
  stale: boolean;
  unlocks: UnlockRow[];
  rewards: RewardRow[];
}

export interface RewardRef extends AchievementRewardRef {
  guildId: string;
}

export interface RewardClaim {
  row: RewardRow;
  token: number;
}

export interface RewardOutcome {
  status: 'delivered' | 'failed' | 'skipped';
  transient?: boolean;
  errorCode?: string | null;
  error?: string | null;
  nextAttemptAt?: number | null;
  now: number;
}

export interface XpGrantOutcome {
  granted: boolean;
  error?: string;
  now: number;
}

export interface AnnounceGroup {
  group: string;
  userId: string;
  achievementId: string;
  generation: number;
  oldestUnlockedAt: number;
  attempts: number;
  rewardsSettled: boolean;
}

export interface DueWork {
  rewards: RewardRow[];
  groups: AnnounceGroup[];
  unpublished: UnlockRow[];
  nextDueAt: number | null;
}

export interface AnnouncementClaim {
  rows: UnlockRow[];
  attempt: number;
}

export interface AnnouncementOutcome {
  status: 'sent' | 'failed' | 'skipped' | 'pending';
  error?: string | null;
  messageId?: string | null;
  now: number;
}

export interface AchievementRuntimeState {
  generation: number;
  rewardEpoch: number;
  countedFrom: number | null;
  firstActiveAt: number | null;
  rebuiltWith: string | null;
}

export interface GuildRuntime {
  modulePeriods: Interval[];
  periods: Map<string, Interval[]>;
  state: Map<string, AchievementRuntimeState>;
}

export interface FactsPatch {
  joinedAt?: number | null;
  premiumSince?: number | null;
  leftAt?: number | null;
}

export interface MemberFacts extends MemberFactsView {
  userId: string;
}

export interface AnniversaryWindow {
  targetDays: number;
  from: number;
  to: number;
}

export interface BadgeAsset {
  assetId: string;
  contentType: string;
  base64: string;
  byteSize: number;
  uploadedBy: string;
  uploadedAt: number;
}

export interface RebuildRequirement {
  requirementId: string;
  version: number;
  metric: LedgerMetric;
  aggregate: ProgressAggregate;
  temporaryOnly: boolean;
  xpSources: XpSource[] | null;
  channelIds: string[];
  excludedChannelIds: string[];
}

export interface RebuildPlan {
  achievementId: string;
  requirements: RebuildRequirement[];
  stateRequirements: Array<{ requirementId: string; version: number }>;
  tiers: Array<{ tierId: TierId; targets: Record<string, number> }>;
  windows: Interval[];
  keepHigher: boolean;
  signature: string;
}

export type RebuildMode = 'write' | 'preview';

export interface RebuildSliceResult {
  cursor: string | null;
  members: number;
  changed: number;
  lost: number;
  newlyEarned: Record<TierId, number>;
}

export interface JobPatch {
  job?: AchievementJob | null;
  status?: JobStatus | null;
  cursor?: string | null;
  requestedAt?: number | null;
  requestedBy?: string | null;
  finishedAt?: number | null;
  result?: JobResult | null;
  announce?: boolean;
  acceptLoss?: boolean;
}

export interface JobState {
  achievementId: string;
  job: AchievementJob | null;
  status: JobStatus | null;
  cursor: string | null;
  requestedAt: number | null;
  requestedBy: string | null;
  finishedAt: number | null;
  result: JobResult | null;
  announce: boolean;
  acceptLoss: boolean;
}

export interface ResetMemberInput {
  guildId: string;
  achievementIds: readonly string[];
  userId: string;
  allowRewardsAgain: boolean;
  actorId: string;
  at: number;
  audit: NewAuditTrailEntry;
}

export interface ResetAchievementInput {
  guildId: string;
  achievementId: string;
  allowRewardsAgain: boolean;
  actorId: string;
  at: number;
  audit: NewAuditTrailEntry;
}

export interface TierHolders {
  achievementId: string;
  tierId: TierId;
  members: number;
}

export interface AchievementMembersCount {
  achievementId: string;
  members: number;
}

export interface RewardStatusCount {
  achievementId: string;
  status: RewardView['status'];
  count: number;
}

export interface Page<T> {
  items: T[];
  total: number;
}

export interface MemberDetailRows {
  states: MemberAchievementState[];
  unlocks: UnlockRow[];
  voided: UnlockRow[];
  rewards: RewardRow[];
  facts: MemberFacts | null;
}

export interface PurgeResult {
  activity: number;
  seen: number;
  facts: number;
}

export interface AchievementStore {
  record(
    record: ActivityRecord,
    targets: readonly ProgressTarget[],
    achievementIds: readonly string[],
  ): Promise<RecordResult>;
  releasePending(
    guildId: string,
    groupKey: string,
    outcome: 'count' | 'void',
    origin: PendingOrigin,
  ): Promise<ActivityRecord[]>;
  setValues(guildId: string, userId: string, values: readonly StateValue[]): Promise<void>;
  memberStates(
    guildId: string,
    userId: string,
    achievementIds: readonly string[],
  ): Promise<MemberAchievementState[]>;

  unlock(input: UnlockInput): Promise<UnlockResult>;
  publishable(guildId: string, limit: number): Promise<UnlockRow[]>;
  markPublished(rows: readonly UnlockRow[], now: number): Promise<void>;

  claimReward(
    ref: RewardRef,
    now: number,
    leaseMs: number,
    opts?: { manual?: boolean },
  ): Promise<RewardClaim | null>;
  finishReward(ref: RewardRef, token: number, outcome: RewardOutcome): Promise<boolean>;
  confirmXpGrant(
    guildId: string,
    grantId: string,
    outcome: XpGrantOutcome,
  ): Promise<RewardRow | null>;
  rewardsFor(
    guildId: string,
    userId: string,
    achievementId: string,
    generation: number,
  ): Promise<RewardRow[]>;
  dueWork(guildId: string, now: number, limit: number): Promise<DueWork>;

  claimAnnouncement(
    guildId: string,
    group: string,
    now: number,
    leaseMs: number,
  ): Promise<AnnouncementClaim | null>;
  finishAnnouncement(
    guildId: string,
    group: string,
    attempt: number,
    outcome: AnnouncementOutcome,
  ): Promise<void>;
  claimAlmostThere(
    guildId: string,
    userId: string,
    achievementId: string,
    tierId: TierId,
    generation: number,
    now: number,
    cooldownMs: number,
  ): Promise<boolean>;

  // firstActivation: the period opened and first_active_at was still null. reopened: the period
  // opened over a closed one — a resume, a re-enable or the module coming back. Turning the module
  // off closes every achievement, so re-enabling it reports them all as reopened; that is the
  // truth, and the caller decides what deserves a re-check.
  syncPeriods(
    guildId: string,
    at: number,
    opts?: { openOnly?: boolean },
  ): Promise<{ firstActivation: string[]; reopened: string[] }>;
  runtime(guildId: string): Promise<GuildRuntime>;

  upsertFacts(guildId: string, userId: string, facts: FactsPatch): Promise<void>;
  facts(guildId: string, userId: string): Promise<MemberFacts | null>;
  anniversaryCandidates(
    guildId: string,
    windows: readonly AnniversaryWindow[],
    afterUserId: string | null,
    limit: number,
  ): Promise<MemberFacts[]>;
  anniversaryRunAt(guildId: string): Promise<number | null>;
  setAnniversaryRunAt(guildId: string, at: number): Promise<void>;

  putBadge(guildId: string, asset: BadgeAsset): Promise<void>;
  badge(guildId: string, assetId: string): Promise<{ contentType: string; base64: string } | null>;
  pruneBadges(guildId: string, keep: readonly string[], olderThan: number): Promise<number>;

  rebuildSlice(
    guildId: string,
    plan: RebuildPlan,
    cursor: string | null,
    mode: RebuildMode,
  ): Promise<RebuildSliceResult>;
  membersForRecheck(
    guildId: string,
    achievementId: string,
    cursor: string | null,
    limit: number,
    opts?: { unlockedIn?: readonly string[] | 'any' },
  ): Promise<{ userIds: string[]; cursor: string | null }>;
  setJob(guildId: string, achievementId: string, patch: JobPatch): Promise<void>;
  job(guildId: string, achievementId: string): Promise<JobState | null>;
  jobs(guildId: string): Promise<JobState[]>;

  resetMember(input: ResetMemberInput): Promise<{ achievements: number }>;
  resetAchievement(input: ResetAchievementInput): Promise<{ members: number }>;

  unlocksOf(guildId: string, userId: string): Promise<UnlockRow[]>;
  earnedCount(guildId: string, userId: string, excludeIds: readonly string[]): Promise<number>;
  topBadges(guildId: string, userId: string, limit: number): Promise<UnlockRow[]>;
  holders(guildId: string): Promise<TierHolders[]>;
  inProgress(guildId: string): Promise<AchievementMembersCount[]>;
  rewardCounts(guildId: string): Promise<RewardStatusCount[]>;
  listUnlocks(guildId: string, query: UnlockListQuery): Promise<Page<UnlockRow>>;
  listRewards(guildId: string, query: RewardListQuery): Promise<Page<RewardRow>>;
  memberDetail(guildId: string, userId: string): Promise<MemberDetailRows>;

  purge(now: number): Promise<PurgeResult>;
}

export function requirementValue(
  state: MemberAchievementState,
  requirementId: string,
  version: number,
): number {
  const stored = state.values[requirementId];
  if (!stored || stored.version !== version || stored.generation !== state.generation) return 0;
  return stored.value;
}

export function xpGrantId(
  guildId: string,
  userId: string,
  achievementId: string,
  tierId: TierId,
  rewardEpoch: number,
): string {
  return `achievements:${guildId}:${userId}:${achievementId}:${tierId}:${rewardEpoch}`;
}

export interface XpGrantIdentity {
  guildId: string;
  userId: string;
  achievementId: string;
  tierId: string;
  rewardEpoch: number;
}

export function parseXpGrantId(grantId: string): XpGrantIdentity | null {
  const parts = grantId.split(':');
  if (parts.length !== 6 || parts[0] !== 'achievements') return null;

  const [, guildId, userId, achievementId, tierId, epoch] = parts;
  const rewardEpoch = Number(epoch);
  if (!guildId || !userId || !achievementId || !tierId || !Number.isInteger(rewardEpoch)) {
    return null;
  }

  return { guildId, userId, achievementId, tierId, rewardEpoch };
}

export const ALREADY_GIVEN = 'Already given before a reset.';
export const CANCELLED_BY_RESET = 'Cancelled by a reset before it was given.';
export const RESET_BEFORE_ANNOUNCED = 'Reset before it was announced.';
export const XP_REFUSED = 'Leveling refused the XP reward.';

export const NO_NEWLY_EARNED: Readonly<Record<TierId, number>> = {
  single: 0,
  bronze: 0,
  silver: 0,
  gold: 0,
  diamond: 0,
};
