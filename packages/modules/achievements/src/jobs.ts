import { type Causation, type ModuleContext, type ScheduledHandler, TIER_IDS } from '@proton/core';
import { z } from 'zod';
import { announceDueGroup } from './announce.ts';
import { type Achievement, type AchievementsConfig, MODULE_ID } from './config.ts';
import { JOB_SLICE } from './constants.ts';
import { type AchievementsDeps, clockOf, describeUnbound } from './deps.ts';
import {
  ACHIEVEMENT_JOB,
  activate,
  armSweep,
  DAILY_JOB,
  DAILY_KEY,
  DAY_MS,
  type EvaluateInput,
  evaluateMemberUnlocks,
  forgetRuntime,
  initialJobFor,
  JOB_START_DELAY_MS,
  publishUnlocks,
  recheckReopened,
  SWEEP_JOB,
  startsAfter,
  sweepSlot,
  VOICE_JOB,
} from './engine.ts';
import { acceptsAt } from './evaluate.ts';
import { planRebuild } from './rebuild.ts';
import { deliverDue } from './rewards.ts';
import {
  type AchievementStore,
  type JobState,
  NO_NEWLY_EARNED,
  type RebuildSliceResult,
} from './store.ts';
import type { JobResult } from './view.ts';
import { voiceCheckpoint } from './voice.ts';

type Context = ModuleContext<AchievementsConfig>;

export const ACHIEVEMENT_SCHEDULES = [SWEEP_JOB, DAILY_JOB, VOICE_JOB, ACHIEVEMENT_JOB] as const;

export type AchievementSchedule = (typeof ACHIEVEMENT_SCHEDULES)[number];

export const SWEEP_BATCH = 50;
export const SWEEP_MIN_DELAY_MS = 30 * 1000;
export const SWEEP_MAX_DELAY_MS = 10 * 60 * 1000;
export const SWEEP_IDLE_DELAY_MS = 5 * 60 * 1000;
export const SWEEP_RETRY_DELAY_MS = 60 * 1000;

const SECOND_MS = 1000;

export const JOB_BUDGET_MS = 2000;

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function storeFor(ctx: Context, deps: AchievementsDeps, what: string): AchievementStore | null {
  if (deps.store) return deps.store;
  ctx.logger.error(describeUnbound(what, ['store']), { guildId: ctx.guildId, moduleId: MODULE_ID });
  return null;
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), high);
}

async function runSweep(deps: AchievementsDeps, ctx: Context): Promise<void> {
  if (!ctx.config.enabled) return;

  const store = storeFor(ctx, deps, 'the reward and announcement sweep');
  if (!store) return;

  const clock = clockOf(deps);
  let next: number | null;

  try {
    const work = await store.dueWork(ctx.guildId, clock(), SWEEP_BATCH);

    await publishUnlocks(ctx, deps, work.unpublished);
    await deliverDue(ctx, deps, work.rewards);

    for (const group of work.groups) {
      try {
        await announceDueGroup(ctx, deps, group);
      } catch (error) {
        ctx.logger.error(
          `achievements could not announce an unlock (group ${group.group}); the sweep tries ` +
            `again: ${reasonOf(error)}`,
          { guildId: ctx.guildId, moduleId: MODULE_ID },
        );
      }
    }

    const after = clock();
    const later = await store.dueWork(ctx.guildId, after, 0);
    const lists = [work.rewards, work.groups, work.unpublished];
    const full = lists.some((list) => list.length >= SWEEP_BATCH);
    const busy = lists.some((list) => list.length > 0);

    next = full
      ? after
      : later.nextDueAt !== null
        ? clamp(later.nextDueAt, after + SWEEP_MIN_DELAY_MS, after + SWEEP_MAX_DELAY_MS)
        : busy
          ? after + SWEEP_IDLE_DELAY_MS
          : null;
  } catch (error) {
    ctx.logger.error(
      `achievements’ sweep hit a problem and runs again in a minute: ${reasonOf(error)}`,
      { guildId: ctx.guildId, moduleId: MODULE_ID },
    );
    next = clock() + SWEEP_RETRY_DELAY_MS;
  }

  if (next === null) return;

  const slot = sweepSlot(Math.max(next, clock() + SECOND_MS), SECOND_MS);
  await ctx.schedule?.(SWEEP_JOB, new Date(slot.at), slot.key, {});
}

const dailyDataSchema = z.object({
  cursor: z.string().nullable().optional(),
  windowEnd: z.number().int().optional(),
});

function membershipAchievements(ctx: Context, at: number, now: number): Achievement[] {
  return ctx.config.achievements.filter(
    (achievement) =>
      achievement.status === 'active' &&
      achievement.requirements.some(({ trigger }) => trigger === 'membership.days') &&
      acceptsAt(achievement, at, now),
  );
}

function targetDays(achievements: readonly Achievement[]): number[] {
  const days = new Set<number>();

  for (const achievement of achievements) {
    for (const requirement of achievement.requirements) {
      if (requirement.trigger !== 'membership.days') continue;
      for (const tier of achievement.tiers) {
        const target = tier.targets[requirement.id];
        if (target !== undefined) days.add(target);
      }
    }
  }

  return [...days].sort((a, b) => a - b);
}

async function anniversaries(
  ctx: Context,
  deps: AchievementsDeps,
  store: AchievementStore,
  windowEnd: number,
  cursor: string | null,
  started: number,
): Promise<{ done: true } | { done: false; cursor: string | null }> {
  const clock = clockOf(deps);
  const achievements = membershipAchievements(ctx, windowEnd, clock());
  const days = targetDays(achievements);
  if (days.length === 0) return { done: true };

  const lastRun = (await store.anniversaryRunAt(ctx.guildId)) ?? windowEnd - DAY_MS;
  if (lastRun >= windowEnd) return { done: true };

  const windows = days.map((target) => ({
    targetDays: target,
    from: lastRun - target * DAY_MS,
    to: windowEnd - target * DAY_MS,
  }));

  const ids = achievements.map(({ id }) => id);
  const causation: Causation = {
    kind: 'organic',
    rootId: `achievements:anniversary:${ctx.guildId}:${windowEnd}`,
    depth: 0,
  };

  let after = cursor;
  let processed = 0;

  for (;;) {
    const page = await store.anniversaryCandidates(ctx.guildId, windows, after, JOB_SLICE);

    for (const member of page) {
      if (processed > 0 && clock() - started > JOB_BUDGET_MS) return { done: false, cursor: after };

      await evaluateMemberUnlocks(ctx, deps, {
        userId: member.userId,
        achievementIds: ids,
        originChannelId: null,
        causation,
      });

      after = member.userId;
      processed += 1;
    }

    if (page.length < JOB_SLICE) return { done: true };
  }
}

// Repairs a start date whose queued re-check was dropped, e.g. while the module was off.
async function startedSince(
  ctx: Context,
  store: AchievementStore,
  from: number,
  to: number,
): Promise<string[]> {
  const due: string[] = [];

  for (const achievement of ctx.config.achievements) {
    if (achievement.status !== 'active' || initialJobFor(achievement) !== 'recheck') continue;

    const startsAt = startsAfter(achievement, from);
    if (startsAt === null || startsAt > to) continue;

    const state = await store.job(ctx.guildId, achievement.id);
    const covered =
      state?.job === 'recheck' &&
      (state.status === 'running' ||
        (state.status === 'done' && (state.finishedAt ?? 0) >= startsAt));
    if (covered) continue;

    due.push(achievement.id);
  }

  return due;
}

async function runDaily(deps: AchievementsDeps, data: unknown, ctx: Context): Promise<void> {
  if (!ctx.config.enabled) return;

  const store = storeFor(ctx, deps, 'the daily achievement check');
  if (!store) return;

  const clock = clockOf(deps);
  const started = clock();
  const parsed = dailyDataSchema.safeParse(data ?? {});
  const resumed =
    parsed.success && parsed.data.windowEnd !== undefined
      ? { cursor: parsed.data.cursor ?? null, windowEnd: parsed.data.windowEnd }
      : null;

  try {
    if (resumed === null) {
      const { firstActivation, reopened } = await store.syncPeriods(ctx.guildId, started);
      forgetRuntime(store, ctx.guildId);

      const lastRun = (await store.anniversaryRunAt(ctx.guildId)) ?? started - DAY_MS;
      const due = await startedSince(ctx, store, lastRun, started);

      await activate(ctx, deps, [...new Set([...firstActivation, ...due])]);
      await recheckReopened(ctx, deps, reopened);
      await armSweep(ctx, deps);
    }

    const windowEnd = resumed?.windowEnd ?? started;
    const progress = await anniversaries(
      ctx,
      deps,
      store,
      windowEnd,
      resumed?.cursor ?? null,
      started,
    );

    if (!progress.done) {
      await ctx.schedule?.(DAILY_JOB, new Date(clock()), DAILY_KEY, {
        cursor: progress.cursor,
        windowEnd,
      });
      return;
    }

    await store.setAnniversaryRunAt(ctx.guildId, windowEnd);

    const keep = ctx.config.achievements.flatMap(({ badge }) =>
      badge.assetId === undefined ? [] : [badge.assetId],
    );
    await store.pruneBadges(ctx.guildId, keep, started - DAY_MS);
  } catch (error) {
    ctx.logger.error(
      `achievements’ daily check hit a problem; tomorrow’s run covers what it missed: ` +
        reasonOf(error),
      { guildId: ctx.guildId, moduleId: MODULE_ID },
    );
  }

  await ctx.schedule?.(DAILY_JOB, new Date(started + DAY_MS), DAILY_KEY, {});
}

const jobDataSchema = z.object({ achievementId: z.string().min(1).max(40) });

const JOB_PHASES = ['preview', 'check', 'write', 'progress', 'levels', 'members'] as const;

type JobPhase = (typeof JOB_PHASES)[number];

const jobCursorSchema = z.object({
  phase: z.enum(JOB_PHASES),
  after: z.string().nullable(),
  lost: z.number().int().min(0).default(0),
});

type JobCursor = z.infer<typeof jobCursorSchema>;

type JobStep =
  | { cursor: JobCursor | null; result: JobResult }
  | { failure: string; result: JobResult };

function emptyResult(): JobResult {
  return { members: 0, changed: 0, lost: 0, newlyEarned: { ...NO_NEWLY_EARNED } };
}

function decodeCursor(raw: string | null): JobCursor | null {
  if (raw === null) return null;

  try {
    const parsed = jobCursorSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function firstCursor(state: JobState): JobCursor {
  if (state.job === 'rebuild_preview') return { phase: 'preview', after: null, lost: 0 };
  if (state.job === 'rebuild') {
    return { phase: state.acceptLoss ? 'write' : 'check', after: null, lost: 0 };
  }
  return { phase: 'progress', after: null, lost: 0 };
}

function withSlice(result: JobResult, slice: RebuildSliceResult): JobResult {
  const newlyEarned = { ...NO_NEWLY_EARNED };
  for (const tier of TIER_IDS) {
    newlyEarned[tier] = (result.newlyEarned[tier] ?? 0) + (slice.newlyEarned[tier] ?? 0);
  }

  return {
    members: result.members + slice.members,
    changed: result.changed + slice.changed,
    lost: result.lost + slice.lost,
    newlyEarned,
  };
}

function lossReason(lost: number): string {
  return (
    `Activity older than 365 days can’t be rebuilt, so ${lost} ` +
    `${lost === 1 ? 'member' : 'members'} would lose progress. Confirm the loss to rebuild anyway.`
  );
}

function requirementsOf(achievement: Achievement, trigger: string) {
  return achievement.requirements.filter((requirement) => requirement.trigger === trigger);
}

function lowestTarget(achievement: Achievement, trigger: string): number | null {
  const targets = requirementsOf(achievement, trigger).flatMap((requirement) =>
    achievement.tiers.flatMap((tier) => {
      const target = tier.targets[requirement.id];
      return target === undefined ? [] : [target];
    }),
  );
  return targets.length > 0 ? Math.min(...targets) : null;
}

function unlockedIn(achievement: Achievement): readonly string[] | 'any' | undefined {
  if (requirementsOf(achievement, 'achievements.earned').length > 0) return 'any';

  const prerequisites = requirementsOf(achievement, 'achievements.unlocked').flatMap(
    ({ achievementId }) => (achievementId === undefined ? [] : [achievementId]),
  );
  return prerequisites.length > 0 ? prerequisites : undefined;
}

function phasesAfterRebuild(
  state: JobState,
  achievement: Achievement,
  deps: AchievementsDeps,
): JobPhase[] {
  if (state.job !== 'recheck') return ['progress'];

  return [
    'progress',
    ...(lowestTarget(achievement, 'leveling.level') !== null && deps.levelHolders
      ? (['levels'] as const)
      : []),
    ...(lowestTarget(achievement, 'membership.days') !== null && deps.listMembers
      ? (['members'] as const)
      : []),
  ];
}

function nextPhase(
  phase: JobPhase,
  state: JobState,
  achievement: Achievement,
  deps: AchievementsDeps,
): JobCursor | null {
  const phases = phasesAfterRebuild(state, achievement, deps);
  const next = phases[phases.indexOf(phase) + 1];
  return next === undefined ? null : { phase: next, after: null, lost: 0 };
}

interface Candidate {
  userId: string;
  extra: Pick<EvaluateInput, 'stateValues' | 'subject'>;
}

interface CandidatePage {
  candidates: Candidate[];
  end: string | null;
}

const LISTED_MEMBER = { roleIds: null, isMember: true, isBot: false } as const;

function pageEnd(ids: readonly string[]): string | null {
  return ids.length >= JOB_SLICE ? (ids.at(-1) ?? null) : null;
}

async function candidatesFor(
  ctx: Context,
  deps: AchievementsDeps,
  store: AchievementStore,
  achievement: Achievement,
  state: JobState,
  cursor: JobCursor,
): Promise<CandidatePage> {
  const guildId = ctx.guildId;

  if (cursor.phase === 'progress') {
    const scope = state.job === 'recheck' ? unlockedIn(achievement) : undefined;
    const page = await store.membersForRecheck(
      guildId,
      achievement.id,
      cursor.after,
      JOB_SLICE,
      scope === undefined ? undefined : { unlockedIn: scope },
    );
    return {
      candidates: page.userIds.map((userId) => ({ userId, extra: {} })),
      end: page.cursor,
    };
  }

  if (cursor.phase === 'levels') {
    const minimum = lowestTarget(achievement, 'leveling.level');
    if (minimum === null || !deps.levelHolders) return { candidates: [], end: null };

    const page = await deps.levelHolders(guildId, minimum, cursor.after, JOB_SLICE);
    return {
      candidates: page.map(({ userId, level }) => ({ userId, extra: { stateValues: { level } } })),
      end: pageEnd(page.map(({ userId }) => userId)),
    };
  }

  const days = lowestTarget(achievement, 'membership.days');
  if (days === null || !deps.listMembers) return { candidates: [], end: null };

  const page = await deps.listMembers(guildId, cursor.after, JOB_SLICE);
  const cutoff = clockOf(deps)() - days * DAY_MS;
  const candidates: Candidate[] = [];

  for (const member of page) {
    if (member.bot || member.joinedAt === null) continue;

    await store.upsertFacts(guildId, member.userId, { joinedAt: member.joinedAt, leftAt: null });
    if (member.joinedAt <= cutoff) {
      candidates.push({ userId: member.userId, extra: { subject: { ...LISTED_MEMBER } } });
    }
  }

  return { candidates, end: pageEnd(page.map(({ userId }) => userId)) };
}

async function jobStep(
  ctx: Context,
  deps: AchievementsDeps,
  store: AchievementStore,
  achievement: Achievement,
  state: JobState,
  cursor: JobCursor,
  result: JobResult,
  started: number,
): Promise<JobStep> {
  const clock = clockOf(deps);
  const guildId = ctx.guildId;

  if (cursor.phase === 'preview' || cursor.phase === 'check' || cursor.phase === 'write') {
    const runtime = await store.runtime(guildId);
    const plan = planRebuild(ctx.config, achievement, runtime, clock());
    const slice = await store.rebuildSlice(
      guildId,
      plan,
      cursor.after,
      cursor.phase === 'write' ? 'write' : 'preview',
    );

    if (cursor.phase === 'check') {
      const lost = cursor.lost + slice.lost;
      if (slice.cursor !== null) {
        return { cursor: { phase: 'check', after: slice.cursor, lost }, result };
      }
      if (lost > 0) return { failure: lossReason(lost), result: { ...result, lost } };
      return { cursor: { phase: 'write', after: null, lost: 0 }, result };
    }

    const next = withSlice(result, slice);
    if (slice.cursor !== null) {
      return { cursor: { phase: cursor.phase, after: slice.cursor, lost: 0 }, result: next };
    }
    if (cursor.phase === 'preview') return { cursor: null, result: next };

    forgetRuntime(store, guildId);
    return { cursor: { phase: 'progress', after: null, lost: 0 }, result: next };
  }

  const page = await candidatesFor(ctx, deps, store, achievement, state, cursor);

  const counting = state.job === 'recheck';
  const announce = state.announce ? 'pending' : 'suppressed';
  const causation: Causation = {
    kind: 'admin',
    rootId: `achievements:job:${guildId}:${achievement.id}:${state.requestedAt ?? 0}`,
    depth: 0,
  };

  let tally = result;
  let after = cursor.after;
  let processed = 0;

  for (const candidate of page.candidates) {
    if (processed > 0 && clock() - started > JOB_BUDGET_MS) {
      return { cursor: { phase: cursor.phase, after, lost: 0 }, result: tally };
    }

    const rows = await evaluateMemberUnlocks(ctx, deps, {
      userId: candidate.userId,
      achievementIds: [achievement.id],
      originChannelId: null,
      causation,
      announce,
      ...candidate.extra,
    });

    if (counting) {
      const newlyEarned = { ...tally.newlyEarned };
      for (const row of rows) newlyEarned[row.tierId] = (newlyEarned[row.tierId] ?? 0) + 1;
      tally = { ...tally, members: tally.members + 1, newlyEarned };
    }

    after = candidate.userId;
    processed += 1;
  }

  if (page.end !== null) {
    return { cursor: { phase: cursor.phase, after: page.end, lost: 0 }, result: tally };
  }
  return { cursor: nextPhase(cursor.phase, state, achievement, deps), result: tally };
}

async function runJob(deps: AchievementsDeps, data: unknown, ctx: Context): Promise<void> {
  const parsed = jobDataSchema.safeParse(data);
  if (!parsed.success) {
    ctx.logger.error(`achievements dropped a job it could not read: ${parsed.error.message}`, {
      guildId: ctx.guildId,
      moduleId: MODULE_ID,
    });
    return;
  }

  const store = storeFor(ctx, deps, 'achievement jobs');
  if (!store) return;

  const { achievementId } = parsed.data;
  const clock = clockOf(deps);
  const started = clock();
  const state = await store.job(ctx.guildId, achievementId);
  if (!state || state.job === null) return;
  if (state.status !== 'queued' && state.status !== 'running') return;

  const fresh = state.status === 'queued';
  const cursor = (fresh ? null : decodeCursor(state.cursor)) ?? firstCursor(state);
  const result = fresh ? emptyResult() : (state.result ?? emptyResult());

  const fail = (reason: string, partial: JobResult) =>
    store.setJob(ctx.guildId, achievementId, {
      status: 'failed',
      cursor: null,
      finishedAt: clock(),
      result: { ...partial, reason: reason.slice(0, 400) },
    });

  const achievement = ctx.config.achievements.find(({ id }) => id === achievementId);
  if (!ctx.config.enabled) {
    await fail('Achievements is off in this server, so the job stopped.', result);
    return;
  }
  if (!achievement) {
    await fail('That achievement is no longer in this server’s settings.', result);
    return;
  }

  const waitUntil =
    fresh && state.job === 'recheck' && ctx.schedule ? startsAfter(achievement, started) : null;
  if (waitUntil !== null) {
    // Nothing is accepted before the start date, so the job stays queued and wakes up there.
    await ctx.schedule?.(
      ACHIEVEMENT_JOB,
      new Date(waitUntil + JOB_START_DELAY_MS),
      achievementId,
      { achievementId },
      { replace: true },
    );
    return;
  }

  if (fresh) {
    await store.setJob(ctx.guildId, achievementId, {
      status: 'running',
      cursor: JSON.stringify(cursor),
      result,
      finishedAt: null,
    });
  }

  try {
    const step = await jobStep(ctx, deps, store, achievement, state, cursor, result, started);

    if ('failure' in step) {
      await fail(step.failure, step.result);
      return;
    }

    if (step.cursor === null) {
      await store.setJob(ctx.guildId, achievementId, {
        status: 'done',
        cursor: null,
        finishedAt: clock(),
        result: step.result,
      });
      return;
    }

    await store.setJob(ctx.guildId, achievementId, {
      cursor: JSON.stringify(step.cursor),
      result: step.result,
    });
  } catch (error) {
    ctx.logger.error(
      `achievements’ ${state.job} of ${achievementId} hit a problem and stopped: ${reasonOf(error)}`,
      { guildId: ctx.guildId, moduleId: MODULE_ID },
    );
    await fail(`Proton hit a problem running this: ${reasonOf(error)}. Start it again.`, result);
    return;
  }

  await ctx.schedule?.(ACHIEVEMENT_JOB, new Date(clock()), achievementId, { achievementId });
}

export function createScheduledHandlers(
  deps: AchievementsDeps,
): Record<AchievementSchedule, ScheduledHandler<AchievementsConfig>> {
  return {
    [SWEEP_JOB]: (_data, ctx) => runSweep(deps, ctx),
    [DAILY_JOB]: (data, ctx) => runDaily(deps, data, ctx),
    [VOICE_JOB]: (data, ctx) => voiceCheckpoint(data, ctx, deps),
    [ACHIEVEMENT_JOB]: (data, ctx) => runJob(deps, data, ctx),
  };
}

export function purgeAchievements(store: AchievementStore, now: number): Promise<unknown> {
  return store.purge(now);
}
