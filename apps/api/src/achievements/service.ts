import {
  type AchievementJob,
  type AchievementRetryOutcome,
  achievementJobRequestedSchema,
  achievementRewardRetryRequestedSchema,
  type EntitlementTier,
  type EventBus,
  limitFor,
  type RedisMailbox,
  snowflakeSchema,
  type TierId,
} from '@proton/core';
import type { DbHandle, NewAuditTrailEntry } from '@proton/db';
import { members } from '@proton/db/schema';
import {
  DAY_MS,
  type LiveState,
  routingOf,
  startsAfter,
  valuesOf,
} from '@proton/module-achievements';
import {
  type Achievement,
  type AchievementsConfig,
  achievementsConfigSchema,
  BADGE_ASSET_ID,
  MODULE_ID,
} from '@proton/module-achievements/config';
import { tierRank } from '@proton/module-achievements/evaluate';
import {
  type AchievementStore,
  type JobState,
  type MemberAchievementState,
  type MemberFacts,
  NO_NEWLY_EARNED,
  type RewardRow,
  requirementValue,
  type UnlockRow,
} from '@proton/module-achievements/store';
import {
  achievementBadges,
  achievementMembers,
  achievementState,
} from '@proton/module-achievements/table';
import {
  type AchievementsOverview,
  BADGE_CONTENT_TYPES,
  BADGE_UPLOAD_MAX_BYTES,
  type BadgeUploadResult,
  type JobBody,
  type JobQueued,
  type JobView,
  type MemberAchievementView,
  type MemberDetail,
  type MemberFactsView,
  type ResetBody,
  type ResetResult,
  type RewardListQuery,
  type RewardListResult,
  type RewardRetryBody,
  type RewardRetryOutcome,
  type RewardView,
  type UnlockListQuery,
  type UnlockListResult,
  type UnlockView,
} from '@proton/module-achievements/view';
import { imageDimensions, imageMime } from '@proton/module-branding/image';
import { kilobytes } from '@proton/module-branding/kinds';
import { levelForXp } from '@proton/module-leveling/curve';
import { and, eq, isNotNull, sql } from 'drizzle-orm';
import type { AuditWrite } from '../leveling/xp-events.ts';
import type { ModuleConfigService } from '../modules/service.ts';

export const ACHIEVEMENT_RETRY_WAIT_MS = 20_000;

const JOB_STALE_MS = 6 * 60 * 60_000;

const BADGE_GRACE_MS = 24 * 60 * 60_000;

// The byte cap alone does not bound the render: a 256 KB PNG can declare 16000×16000 and resvg
// decodes every pixel of it, synchronously, on the one worker that serves every guild.
export const BADGE_MAX_SIDE = 1_024;

const PENDING_REWARDS: ReadonlySet<string> = new Set(['pending', 'delivering', 'requested']);

const JOB_LABELS: Record<AchievementJob, string> = {
  rebuild: 'A rebuild',
  rebuild_preview: 'A rebuild preview',
  recheck: 'A re-check',
};

export type AchievementsErrorCode =
  | 'not_found'
  | 'module_disabled'
  | 'no_bus'
  | 'worker_timeout'
  | 'invalid_request'
  | 'too_large'
  | 'too_many_badges'
  | 'unsupported_image'
  | 'job_running';

export class AchievementsError extends Error {
  readonly code: AchievementsErrorCode;

  constructor(code: AchievementsErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = 'AchievementsError';
  }
}

export type AchievementsStore = Pick<
  AchievementStore,
  | 'runtime'
  | 'holders'
  | 'inProgress'
  | 'rewardCounts'
  | 'jobs'
  | 'job'
  | 'setJob'
  | 'listUnlocks'
  | 'listRewards'
  | 'memberDetail'
  | 'unlocksOf'
  | 'resetMember'
  | 'resetAchievement'
  | 'putBadge'
  | 'pruneBadges'
  | 'badge'
>;

export type AchievementRetryMailbox = Pick<
  RedisMailbox<AchievementRetryOutcome>,
  'recall' | 'wait'
>;

export interface AchievementsServiceOptions {
  db: DbHandle;
  store: AchievementsStore;
  modules: Pick<ModuleConfigService, 'get'>;
  audit: AuditWrite;
  bus?: EventBus;
  mailbox?: AchievementRetryMailbox;
  waitMs?: number;
  logger?: Pick<Console, 'error'>;
  now?(): number;
}

export interface UploadBadgeInput {
  guildId: string;
  bytes: Uint8Array;
  actorId: string;
}

export interface ServedBadge {
  contentType: string;
  bytes: Uint8Array;
}

const RETRY_UNAVAILABLE =
  'Proton can’t retry rewards right now because part of its service is down, so nothing was ' +
  'retried. Try again later.';

const JOB_UNAVAILABLE =
  'Proton can’t run rebuilds or re-checks right now because part of its service is down, so ' +
  'nothing was started. Try again later.';

const RETRY_NOT_PASSED_ON = 'Proton hit a problem, so nothing was retried. Try again in a moment.';

const JOB_NOT_PASSED_ON = 'Proton hit a problem, so nothing was started. Try again in a moment.';

const RETRY_TIMED_OUT =
  'The retry took longer than 20 seconds. It may still go through, so refresh the list in a ' +
  'moment to see where each reward stands before trying again.';

const NO_BADGE =
  'This server has no badge image with that ID. Images no achievement uses are removed after a ' +
  'day.';

function switchedOff(outcome: string): AchievementsError {
  return new AchievementsError(
    'module_disabled',
    `Achievements is off in this server, so ${outcome}. Turn it on first.`,
  );
}

function notInSettings(achievementId: string, outcome: string): AchievementsError {
  return new AchievementsError(
    'not_found',
    `This server’s Achievements settings have no achievement with the ID ${achievementId}, so ` +
      `${outcome}.`,
  );
}

function notAServer(guildId: string, outcome: string): AchievementsError {
  return new AchievementsError(
    'invalid_request',
    `${guildId} isn’t a Discord server ID, so ${outcome}.`,
  );
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function unlockView(row: UnlockRow): UnlockView {
  const { guildId: _guildId, announceLeaseUntil: _lease, ...view } = row;
  return view;
}

function rewardView(row: RewardRow): RewardView {
  const { guildId: _guildId, leaseUntil: _lease, ...view } = row;
  return view;
}

function factsView(facts: MemberFacts): MemberFactsView {
  const { userId: _userId, ...view } = facts;
  return view;
}

function jobView(state: JobState | undefined): JobView | null {
  if (!state?.job || !state.status) return null;

  return {
    kind: state.job,
    status: state.status,
    requestedAt: state.requestedAt,
    finishedAt: state.finishedAt,
    result: state.result,
  };
}

function busy(state: JobState, achievement: Achievement, now: number): boolean {
  if (state.status !== 'queued' && state.status !== 'running') return false;

  const waiting = state.job === 'recheck' && startsAfter(achievement, now) !== null;

  // A queued re-check of a scheduled achievement sleeps until its start date; it is not under way.
  if (state.status === 'queued' && waiting) return false;

  // A job stranded by the module being switched off mid-run would otherwise refuse every new one.
  return state.requestedAt === null || now - state.requestedAt < JOB_STALE_MS;
}

export function badgeAssetId(bytes: Uint8Array): string {
  return Bun.hash(bytes).toString(36).padStart(8, '0');
}

// Room for a badge per achievement and one being swapped in, so a flood of unused images is refused.
export function badgeCap(tier: EntitlementTier): number {
  return limitFor(tier, 'achievements') * 2;
}

function badgeContentType(bytes: Uint8Array): BadgeUploadResult['contentType'] | null {
  const sniffed = imageMime(bytes);
  return BADGE_CONTENT_TYPES.find((type) => type === sniffed) ?? null;
}

interface ResetMark {
  at: number;
  by: string | null;
}

export class AchievementsService {
  readonly #db: DbHandle;
  readonly #store: AchievementsStore;
  readonly #modules: Pick<ModuleConfigService, 'get'>;
  readonly #audit: AuditWrite;
  readonly #bus: EventBus | undefined;
  readonly #mailbox: AchievementRetryMailbox | undefined;
  readonly #waitMs: number;
  readonly #logger: Pick<Console, 'error'>;
  readonly #now: () => number;

  constructor(options: AchievementsServiceOptions) {
    this.#db = options.db;
    this.#store = options.store;
    this.#modules = options.modules;
    this.#audit = options.audit;
    this.#bus = options.bus;
    this.#mailbox = options.mailbox;
    this.#waitMs = options.waitMs ?? ACHIEVEMENT_RETRY_WAIT_MS;
    this.#logger = options.logger ?? console;
    this.#now = options.now ?? Date.now;
  }

  async #config(guildId: string) {
    const view = await this.#modules.get(guildId, MODULE_ID);
    const config = achievementsConfigSchema.parse(view.config);

    return { on: view.enabled && config.enabled, config, tier: view.tier };
  }

  async overview(guildId: string): Promise<AchievementsOverview> {
    const [{ config }, runtime, holders, inProgress, rewardCounts, jobs] = await Promise.all([
      this.#config(guildId),
      this.#store.runtime(guildId),
      this.#store.holders(guildId),
      this.#store.inProgress(guildId),
      this.#store.rewardCounts(guildId),
      this.#store.jobs(guildId),
    ]);

    const tiers = new Map<string, Record<TierId, number>>();
    for (const row of holders) {
      const counts = tiers.get(row.achievementId) ?? { ...NO_NEWLY_EARNED };
      counts[row.tierId] = row.members;
      tiers.set(row.achievementId, counts);
    }

    const outstanding = new Map<string, { pending: number; failed: number }>();
    for (const row of rewardCounts) {
      const counts = outstanding.get(row.achievementId) ?? { pending: 0, failed: 0 };
      if (PENDING_REWARDS.has(row.status)) counts.pending += row.count;
      if (row.status === 'failed') counts.failed += row.count;
      outstanding.set(row.achievementId, counts);
    }

    const members = new Map(inProgress.map((row) => [row.achievementId, row.members]));
    const job = new Map(jobs.map((state) => [state.achievementId, state]));
    const modulePeriods = runtime.modulePeriods.map(({ start, end }) => ({ start, end }));

    return {
      recordingSince:
        modulePeriods.length === 0 ? null : Math.min(...modulePeriods.map(({ start }) => start)),
      periods: { module: modulePeriods },
      achievements: config.achievements.map(({ id, startsAt }) => ({
        id,
        firstActiveAt: runtime.state.get(id)?.firstActiveAt ?? null,
        startsAt: startsAt === undefined ? null : Date.parse(startsAt),
        holders: tiers.get(id) ?? { ...NO_NEWLY_EARNED },
        inProgress: members.get(id) ?? 0,
        rewards: outstanding.get(id) ?? { pending: 0, failed: 0 },
        job: jobView(job.get(id)),
      })),
    };
  }

  async member(guildId: string, userId: string): Promise<MemberDetail> {
    if (!snowflakeSchema.safeParse(userId).success) {
      throw new AchievementsError('invalid_request', `${userId} isn’t a Discord user ID.`);
    }

    const [{ config }, detail, resets] = await Promise.all([
      this.#config(guildId),
      this.#store.memberDetail(guildId, userId),
      this.#resets(guildId, userId),
    ]);

    const snapshots = new Map<string, UnlockRow>();
    for (const unlock of [...detail.voided, ...detail.unlocks]) {
      const held = snapshots.get(unlock.achievementId);
      if (!held || unlock.unlockedAt >= held.unlockedAt) {
        snapshots.set(unlock.achievementId, unlock);
      }
    }

    const live = this.#live(guildId, userId, config, detail.facts, detail.unlocks);

    const valuesFor = async (state: MemberAchievementState): Promise<Record<string, number>> => {
      const achievement = config.achievements.find(({ id }) => id === state.achievementId);
      if (achievement) return valuesOf(achievement, state, live);

      const snapshot: ReadonlyArray<{ id: string; version: number }> =
        snapshots.get(state.achievementId)?.definition.requirements ?? [];
      return Object.fromEntries(
        snapshot.map(({ id, version }) => [id, requirementValue(state, id, version)]),
      );
    };

    const achievementView = async (
      state: MemberAchievementState,
    ): Promise<MemberAchievementView> => {
      const reset = resets.get(state.achievementId);

      return {
        achievementId: state.achievementId,
        generation: state.generation,
        rewardEpoch: state.rewardEpoch,
        countedFrom: state.countedFrom,
        resetAt: reset?.at ?? null,
        resetBy: reset?.by ?? null,
        values: await valuesFor(state),
        unlocked: state.unlocked,
        almostNotified: state.almostNotified,
        almostNotifiedAt: state.almostNotifiedAt,
      };
    };

    return {
      userId,
      facts: detail.facts ? factsView(detail.facts) : null,
      achievements: await Promise.all(detail.states.map(achievementView)),
      unlocks: detail.unlocks.map(unlockView),
      voided: detail.voided.map(unlockView),
      rewards: detail.rewards.map(rewardView),
    };
  }

  #live(
    guildId: string,
    userId: string,
    config: AchievementsConfig,
    facts: MemberFacts | null,
    unlocks: readonly UnlockRow[],
  ): LiveState {
    const now = this.#now();
    const earned = new Set(unlocks.map((row) => row.achievementId));
    for (const collector of routingOf(config).collectors) earned.delete(collector);

    let level: Promise<number> | undefined;

    return {
      level: () => (level ??= this.#level(guildId, userId)),

      membershipDays: async () =>
        facts === null || facts.joinedAt === null || facts.leftAt !== null
          ? 0
          : Math.max(0, Math.floor((now - facts.joinedAt) / DAY_MS)),

      earned: () => earned.size,

      holds: (requirement) => {
        const least = tierRank(requirement.tierId ?? 'single');
        return unlocks.some(
          (row) => row.achievementId === requirement.achievementId && tierRank(row.tierId) >= least,
        );
      },
    };
  }

  async #level(guildId: string, userId: string): Promise<number> {
    const [row] = await this.#db.db
      .select({ xp: members.xp })
      .from(members)
      .where(and(eq(members.guildId, guildId), eq(members.userId, userId)));

    // Derived, never read from `members.level` — that column is a cache the worker may lag on.
    return levelForXp(row?.xp ?? 0);
  }

  async #resets(guildId: string, userId: string): Promise<Map<string, ResetMark>> {
    const [memberMarks, stateMarks] = await Promise.all([
      this.#db.db
        .select({
          achievementId: achievementMembers.achievementId,
          resetAt: achievementMembers.resetAt,
          resetBy: achievementMembers.resetBy,
        })
        .from(achievementMembers)
        .where(
          and(
            eq(achievementMembers.guildId, guildId),
            eq(achievementMembers.userId, userId),
            isNotNull(achievementMembers.resetAt),
          ),
        ),
      this.#db.db
        .select({
          achievementId: achievementState.achievementId,
          resetAt: achievementState.resetAt,
          resetBy: achievementState.resetBy,
        })
        .from(achievementState)
        .where(and(eq(achievementState.guildId, guildId), isNotNull(achievementState.resetAt))),
    ]);

    const latest = new Map<string, ResetMark>();
    for (const row of [...memberMarks, ...stateMarks]) {
      if (!row.resetAt) continue;

      const at = row.resetAt.getTime();
      const held = latest.get(row.achievementId);
      if (!held || at > held.at) latest.set(row.achievementId, { at, by: row.resetBy });
    }

    return latest;
  }

  async unlocks(guildId: string, query: UnlockListQuery): Promise<UnlockListResult> {
    const page = await this.#store.listUnlocks(guildId, query);

    return {
      items: page.items.map(unlockView),
      total: page.total,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  async rewards(guildId: string, query: RewardListQuery): Promise<RewardListResult> {
    const page = await this.#store.listRewards(guildId, query);

    return {
      items: page.items.map(rewardView),
      total: page.total,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  async retry(guildId: string, body: RewardRetryBody): Promise<RewardRetryOutcome> {
    const mailbox = this.#mailbox;
    if (!mailbox) throw new AchievementsError('no_bus', RETRY_UNAVAILABLE);

    const mailboxId = `${guildId}:${body.requestId}`;

    // Ahead of the module check: a retried press must get its first answer, not a fresh refusal.
    const kept = await mailbox.recall(mailboxId);
    if (kept !== null) return kept;

    const bus = this.#bus;
    if (!bus) throw new AchievementsError('no_bus', RETRY_UNAVAILABLE);

    const requested = achievementRewardRetryRequestedSchema.safeParse({
      requestId: body.requestId,
      guildId,
      actorId: body.actorId,
      rewards: body.rewards,
    });
    if (!requested.success) throw notAServer(guildId, 'nothing was retried');

    const { on } = await this.#config(guildId);
    if (!on) throw switchedOff('nothing was retried');

    await this.#audit({
      id: `achievements.reward_retry:${guildId}:${body.requestId}`,
      guildId,
      actorId: body.actorId,
      source: body.source,
      action: 'module.achievements.reward.retry',
      before: null,
      after: { requestId: body.requestId, rewards: body.rewards },
      ipHash: body.ipHash ?? null,
    });

    try {
      await bus.publish({
        id: `achievements.reward_retry_requested:${guildId}:${body.requestId}`,
        type: 'achievements.reward_retry_requested',
        guildId,
        occurredAt: this.#now(),
        payload: requested.data,
      });
    } catch (error) {
      this.#logger.error(
        `a reward retry in guild ${guildId} was audited but could not be published, so the ` +
          `worker never saw it: ${messageOf(error)}`,
      );
      throw new AchievementsError('no_bus', RETRY_NOT_PASSED_ON);
    }

    const outcome = await mailbox.wait(mailboxId, this.#waitMs);
    if (outcome === null) throw new AchievementsError('worker_timeout', RETRY_TIMED_OUT);

    return outcome;
  }

  async reset(guildId: string, body: ResetBody): Promise<ResetResult> {
    const { config } = await this.#config(guildId);
    const at = this.#now();

    const audit = (details: Record<string, unknown>): NewAuditTrailEntry => ({
      id: `achievements.reset:${guildId}:${body.requestId}`,
      guildId,
      actorId: body.actorId,
      source: body.source,
      action: 'module.achievements.reset',
      before: null,
      after: {
        scope: body.scope,
        requestId: body.requestId,
        ...details,
        allowRewardsAgain: body.allowRewardsAgain,
      },
      ipHash: body.ipHash ?? null,
    });

    if (body.scope === 'achievement') {
      const achievement = config.achievements.find(({ id }) => id === body.achievementId);
      if (!achievement) throw notInSettings(body.achievementId, 'nothing was reset');

      if (body.confirmation.trim() !== achievement.name) {
        throw new AchievementsError(
          'invalid_request',
          `The name typed doesn’t match ${achievement.name}, so nothing was reset. Type the ` +
            'achievement’s name exactly to reset it for everyone.',
        );
      }

      const { members } = await this.#store.resetAchievement({
        guildId,
        achievementId: achievement.id,
        allowRewardsAgain: body.allowRewardsAgain,
        actorId: body.actorId,
        at,
        audit: audit({ achievementIds: [achievement.id] }),
      });

      return { achievements: 1, members };
    }

    const held = await this.#store.unlocksOf(guildId, body.userId);
    const known = [
      ...new Set([
        ...config.achievements.map(({ id }) => id),
        ...held.map(({ achievementId }) => achievementId),
      ]),
    ];

    if (body.scope === 'member_achievement' && !known.includes(body.achievementId)) {
      throw notInSettings(body.achievementId, 'nothing was reset');
    }

    const achievementIds = body.scope === 'member_all' ? known : [body.achievementId];

    const { achievements } = await this.#store.resetMember({
      guildId,
      achievementIds,
      userId: body.userId,
      allowRewardsAgain: body.allowRewardsAgain,
      actorId: body.actorId,
      at,
      audit: audit({ userId: body.userId, achievementIds }),
    });

    return { achievements, members: achievements > 0 ? 1 : 0 };
  }

  async requestJob(guildId: string, body: JobBody): Promise<JobQueued> {
    const bus = this.#bus;
    if (!bus) throw new AchievementsError('no_bus', JOB_UNAVAILABLE);

    const requested = achievementJobRequestedSchema.safeParse({
      requestId: body.requestId,
      guildId,
      actorId: body.actorId,
      achievementId: body.achievementId,
      job: body.job,
      announce: body.announce,
      acceptLoss: body.acceptLoss,
    });
    if (!requested.success) throw notAServer(guildId, 'nothing was started');

    const { on, config } = await this.#config(guildId);
    if (!on) throw switchedOff('nothing was started');

    const achievement = config.achievements.find(({ id }) => id === body.achievementId);
    if (!achievement) throw notInSettings(body.achievementId, 'nothing was started');

    const now = this.#now();
    const current = await this.#store.job(guildId, achievement.id);

    if (current?.job && busy(current, achievement, now)) {
      throw new AchievementsError(
        'job_running',
        `${JOB_LABELS[current.job]} of ${achievement.name} is already ${current.status}, so ` +
          'another wasn’t started. Wait for it to finish, then try again.',
      );
    }

    await this.#store.setJob(guildId, achievement.id, {
      job: body.job,
      status: 'queued',
      cursor: null,
      requestedAt: now,
      requestedBy: body.actorId,
      finishedAt: null,
      result: null,
      announce: body.announce,
      acceptLoss: body.acceptLoss,
    });

    try {
      await this.#audit({
        id: `achievements.job:${guildId}:${body.requestId}`,
        guildId,
        actorId: body.actorId,
        source: body.source,
        action: `module.achievements.job.${body.job}`,
        before: null,
        after: {
          requestId: body.requestId,
          achievementId: achievement.id,
          job: body.job,
          announce: body.announce,
          acceptLoss: body.acceptLoss,
        },
        ipHash: body.ipHash ?? null,
      });

      await bus.publish({
        id: `achievements.job_requested:${guildId}:${body.requestId}`,
        type: 'achievements.job_requested',
        guildId,
        occurredAt: now,
        payload: requested.data,
      });
    } catch (error) {
      this.#logger.error(
        `the ${body.job} of ${achievement.id} in guild ${guildId} was queued but could not be ` +
          `recorded or published, so the worker never saw it: ${messageOf(error)}`,
      );
      await this.#abandonJob(guildId, achievement.id, now);
      throw new AchievementsError('no_bus', JOB_NOT_PASSED_ON);
    }

    return { status: 'queued' };
  }

  async #abandonJob(guildId: string, achievementId: string, now: number): Promise<void> {
    try {
      await this.#store.setJob(guildId, achievementId, {
        status: 'failed',
        cursor: null,
        finishedAt: now,
        result: {
          members: 0,
          changed: 0,
          lost: 0,
          newlyEarned: { ...NO_NEWLY_EARNED },
          reason: 'Proton hit a problem, so this never started. Start it again.',
        },
      });
    } catch (error) {
      this.#logger.error(
        `the unstarted job of ${achievementId} in guild ${guildId} could not be marked failed, ` +
          `so new ones are refused for 6 hours: ${messageOf(error)}`,
      );
    }
  }

  async uploadBadge(input: UploadBadgeInput): Promise<BadgeUploadResult> {
    const { guildId, bytes, actorId } = input;
    const byteSize = bytes.byteLength;

    if (byteSize === 0) {
      throw new AchievementsError('unsupported_image', 'That file is empty, so it wasn’t saved.');
    }

    if (byteSize > BADGE_UPLOAD_MAX_BYTES) {
      throw new AchievementsError(
        'too_large',
        `A badge image may be at most ${kilobytes(BADGE_UPLOAD_MAX_BYTES)}, and that one is ` +
          'larger, so it wasn’t saved.',
      );
    }

    const contentType = badgeContentType(bytes);
    if (!contentType) {
      throw new AchievementsError(
        'unsupported_image',
        'That file isn’t a PNG, JPEG or GIF, so it wasn’t saved.',
      );
    }

    const size = imageDimensions(bytes);
    if (!size) {
      throw new AchievementsError(
        'unsupported_image',
        'Proton couldn’t read that image’s width and height, so it wasn’t saved. Export it again ' +
          'and try once more.',
      );
    }

    if (size.width > BADGE_MAX_SIDE || size.height > BADGE_MAX_SIDE) {
      throw new AchievementsError(
        'unsupported_image',
        `A badge image may be at most ${BADGE_MAX_SIDE}×${BADGE_MAX_SIDE} pixels, and that one ` +
          `is ${size.width}×${size.height}, so it wasn’t saved.`,
      );
    }

    const assetId = badgeAssetId(bytes);
    const { config, tier } = await this.#config(guildId);

    const keep = config.achievements.flatMap(({ badge }) =>
      badge.assetId === undefined ? [] : [badge.assetId],
    );
    await this.#store.pruneBadges(guildId, keep, this.#now() - BADGE_GRACE_MS);

    const cap = badgeCap(tier);
    const { stored, held } = await this.#badgeUsage(guildId, assetId);
    if (!held && stored >= cap) {
      throw new AchievementsError(
        'too_many_badges',
        `This server already has ${cap} badge images, the most Proton keeps, so that one wasn’t ` +
          'saved. Images no achievement uses are removed a day after upload, so try again later, ' +
          'or use an image an achievement already has.',
      );
    }

    await this.#store.putBadge(guildId, {
      assetId,
      contentType,
      base64: Buffer.from(bytes).toString('base64'),
      byteSize,
      uploadedBy: actorId,
      uploadedAt: this.#now(),
    });

    await this.#audit({
      id: `achievements.badge:${guildId}:${assetId}`,
      guildId,
      actorId,
      source: 'dashboard',
      action: 'module.achievements.badge.upload',
      before: null,
      after: { assetId, contentType, byteSize },
      ipHash: null,
    });

    return { assetId, contentType, byteSize };
  }

  async #badgeUsage(guildId: string, assetId: string): Promise<{ stored: number; held: boolean }> {
    const [row] = await this.#db.db
      .select({
        stored: sql<number>`count(*)::int`,
        held: sql<number>`(count(*) filter (where ${achievementBadges.assetId} = ${assetId}))::int`,
      })
      .from(achievementBadges)
      .where(eq(achievementBadges.guildId, guildId));

    return { stored: row?.stored ?? 0, held: (row?.held ?? 0) > 0 };
  }

  async badge(guildId: string, assetId: string): Promise<ServedBadge> {
    const asset = BADGE_ASSET_ID.test(assetId) ? await this.#store.badge(guildId, assetId) : null;
    if (!asset) throw new AchievementsError('not_found', NO_BADGE);

    return { contentType: asset.contentType, bytes: Buffer.from(asset.base64, 'base64') };
  }
}
