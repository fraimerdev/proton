import {
  type AchievementRetryResult,
  achievementJobRequestedSchema,
  achievementRewardRetryRequestedSchema,
  achievementUnlockedSchema,
  type Causation,
  type ModuleContext,
  type ProtonEvent,
  protonConfigChangedSchema,
  type TierId,
  tryParseDuration,
  xpGrantedSchema,
} from '@proton/core';
import { type ActivityRecord, activityRecordSchema } from './activity.ts';
import { announceIfReady, announceUnlockOf, sendAlmostThere } from './announce.ts';
import {
  type Achievement,
  type AchievementsConfig,
  MODULE_ID,
  type Requirement,
  type Tier,
} from './config.ts';
import { ACHIEVEMENTS_ACTOR, MAX_CAUSATION_DEPTH, STATE_CHECK_TTL_MS } from './constants.ts';
import { type AchievementsDeps, clockOf, describeUnbound, type MemberLookup } from './deps.ts';
import {
  acceptsAt,
  achievementRevision,
  almostThereDue,
  channelMatches,
  clipSpan,
  countingWindows,
  currentTierIds,
  dependenciesOf,
  earnedTierIds,
  effectiveXpSources,
  type Interval,
  tierRank,
  withinWindows,
} from './evaluate.ts';
import { deliverRewards, retryReward } from './rewards.ts';
import {
  type AchievementStore,
  type GuildRuntime,
  type MemberAchievementState,
  NO_NEWLY_EARNED,
  type ProgressAggregate,
  type ProgressTarget,
  parseXpGrantId,
  requirementValue,
  type StateValue,
  type UnlockAnnounce,
  type UnlockRow,
  type UnlockTierInput,
  XP_REFUSED,
} from './store.ts';
import {
  aggregateOf,
  LEDGER_METRICS,
  type LedgerMetric,
  type StateMetric,
  type TriggerDefinition,
  triggerOf,
} from './triggers.ts';
import type { UnlockCause, UnlockDefinition } from './view.ts';

type Context = ModuleContext<AchievementsConfig>;

export const SWEEP_JOB = 'sweep';
export const DAILY_JOB = 'daily';
export const VOICE_JOB = 'voice';
export const ACHIEVEMENT_JOB = 'job';

export const SWEEP_KEY = 'sweep';
export const DAILY_KEY = 'daily';

const MINUTE_MS = 60 * 1000;

export const DAY_MS = 24 * 60 * MINUTE_MS;

export const SWEEP_ARM_DELAY_MS = MINUTE_MS;

export const SWEEP_SLOT_MS = MINUTE_MS;

export const JOB_START_DELAY_MS = 15 * 1000;

const RUNTIME_TTL_MS = 5 * 1000;

export interface SubjectFacts {
  roleIds: readonly string[] | null;
  isMember: boolean | null;
  isBot: boolean | null;
}

export interface ProcessInput {
  records: ActivityRecord[];
  subjects?: ReadonlyMap<string, SubjectFacts>;
  originChannelId: string | null;
  announce?: 'pending' | 'suppressed';
  onRecorded?: (record: ActivityRecord) => Promise<void>;
}

export interface EvaluateInput {
  userId: string;
  achievementIds?: readonly string[];
  stateValues?: Partial<Record<StateMetric, number>>;
  subject?: SubjectFacts;
  originChannelId: string | null;
  occurredAt?: number;
  causation: Causation;
  announce?: 'pending' | 'suppressed';
}

export interface StateCheckInput {
  userId: string;
  subject?: SubjectFacts;
  originChannelId: string | null;
  occurredAt?: number;
  causation: Causation;
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const LEDGER: ReadonlySet<string> = new Set(LEDGER_METRICS);

function isLedger(metric: string): metric is LedgerMetric {
  return LEDGER.has(metric);
}

function hasStateRequirement(achievement: Achievement): boolean {
  return achievement.requirements.some(
    (requirement) => !isLedger(triggerOf(requirement.trigger).metric),
  );
}

function hasLedgerRequirement(achievement: Achievement): boolean {
  return achievement.requirements.some((requirement) =>
    isLedger(triggerOf(requirement.trigger).metric),
  );
}

interface Route {
  achievement: Achievement;
  requirement: Requirement;
  trigger: TriggerDefinition;
  aggregate: ProgressAggregate;
  xpSources: readonly string[] | null;
}

export interface RoutingIndex {
  active: readonly Achievement[];
  byId: ReadonlyMap<string, Achievement>;
  routes: ReadonlyMap<LedgerMetric, readonly Route[]>;
  stateful: readonly Achievement[];
  collectors: readonly string[];
}

const ROUTING = new WeakMap<AchievementsConfig, RoutingIndex>();

export function routingOf(config: AchievementsConfig): RoutingIndex {
  const cached = ROUTING.get(config);
  if (cached) return cached;

  const active = config.achievements.filter((achievement) => achievement.status === 'active');
  const routes = new Map<LedgerMetric, Route[]>();

  for (const achievement of active) {
    for (const requirement of achievement.requirements) {
      const trigger = triggerOf(requirement.trigger);
      if (!isLedger(trigger.metric)) continue;

      const list = routes.get(trigger.metric) ?? [];
      list.push({
        achievement,
        requirement,
        trigger,
        aggregate: aggregateOf(trigger),
        xpSources: effectiveXpSources(requirement),
      });
      routes.set(trigger.metric, list);
    }
  }

  const byId = new Map<string, Achievement>();
  for (const achievement of config.achievements) {
    if (!byId.has(achievement.id)) byId.set(achievement.id, achievement);
  }

  const index: RoutingIndex = {
    active,
    byId,
    routes,
    stateful: active.filter(hasStateRequirement),
    collectors: config.achievements
      .filter((achievement) =>
        achievement.requirements.some(({ trigger }) => trigger === 'achievements.earned'),
      )
      .map(({ id }) => id),
  };

  ROUTING.set(config, index);
  return index;
}

interface RuntimeEntry {
  at: number;
  runtime: GuildRuntime;
  synced: boolean;
}

const RUNTIMES = new WeakMap<AchievementStore, Map<string, RuntimeEntry>>();

function runtimeCache(store: AchievementStore): Map<string, RuntimeEntry> {
  let cache = RUNTIMES.get(store);
  if (!cache) {
    cache = new Map();
    RUNTIMES.set(store, cache);
  }
  return cache;
}

export function forgetRuntime(store: AchievementStore, guildId: string): void {
  RUNTIMES.get(store)?.delete(guildId);
}

function openIn(periods: readonly Interval[]): boolean {
  return periods.some((period) => period.end === null);
}

function missingPeriods(index: RoutingIndex, runtime: GuildRuntime): boolean {
  if (!openIn(runtime.modulePeriods)) return true;
  return index.active.some((achievement) => !openIn(runtime.periods.get(achievement.id) ?? []));
}

interface MemberCache {
  subject: SubjectFacts | undefined;
  lookup?: Promise<MemberLookup | null | undefined>;
  blocked?: Promise<boolean>;
}

interface Run {
  ctx: Context;
  deps: AchievementsDeps;
  store: AchievementStore;
  index: RoutingIndex;
  now: number;
  announce: UnlockAnnounce;
  armed: boolean;
  runtime: GuildRuntime | null;
  modules: Map<string, Promise<boolean>>;
  members: Map<string, MemberCache>;
}

function newRun(
  ctx: Context,
  deps: AchievementsDeps,
  store: AchievementStore,
  announce: UnlockAnnounce | undefined,
): Run {
  return {
    ctx,
    deps,
    store,
    index: routingOf(ctx.config),
    now: clockOf(deps)(),
    announce: announce ?? 'pending',
    armed: false,
    runtime: null,
    modules: new Map(),
    members: new Map(),
  };
}

function storeOf(ctx: Context, deps: AchievementsDeps, what: string): AchievementStore | null {
  if (deps.store) return deps.store;
  ctx.logger.error(describeUnbound(what, ['store']), { guildId: ctx.guildId, moduleId: MODULE_ID });
  return null;
}

async function runtimeOf(run: Run): Promise<GuildRuntime> {
  if (run.runtime) return run.runtime;

  const { store, now } = run;
  const guildId = run.ctx.guildId;
  const cache = runtimeCache(store);
  const hit = cache.get(guildId);
  const warm = hit !== undefined && now >= hit.at && now - hit.at < RUNTIME_TTL_MS;

  if (warm && (hit.synced || !missingPeriods(run.index, hit.runtime))) {
    run.runtime = hit.runtime;
    return hit.runtime;
  }

  let runtime = warm ? hit.runtime : await store.runtime(guildId);
  let synced = false;

  if (missingPeriods(run.index, runtime)) {
    const { firstActivation } = await store.syncPeriods(guildId, now, { openOnly: true });
    await activate(run.ctx, run.deps, firstActivation);
    runtime = await store.runtime(guildId);
    synced = true;
  }

  cache.set(guildId, { at: now, runtime, synced });
  run.runtime = runtime;
  return runtime;
}

function moduleOn(run: Run, moduleId: string): Promise<boolean> {
  const cached = run.modules.get(moduleId);
  if (cached) return cached;

  const availability = run.deps.availability;
  const answer = availability
    ? availability.isEnabled(run.ctx.guildId, moduleId).catch((error: unknown) => {
        run.ctx.logger.warn(
          `achievements could not tell whether ${moduleId} is on, so it assumed it is: ` +
            reasonOf(error),
          { guildId: run.ctx.guildId, moduleId: MODULE_ID },
        );
        return true;
      })
    : Promise.resolve(true);

  run.modules.set(moduleId, answer);
  return answer;
}

async function dependenciesOn(run: Run, achievement: Achievement): Promise<boolean> {
  for (const moduleId of dependenciesOf(achievement)) {
    if (!(await moduleOn(run, moduleId))) return false;
  }
  return true;
}

function memberOf(run: Run, userId: string): MemberCache {
  let member = run.members.get(userId);
  if (!member) {
    member = { subject: undefined };
    run.members.set(userId, member);
  }
  return member;
}

function lookupMember(run: Run, userId: string): Promise<MemberLookup | null | undefined> {
  const member = memberOf(run, userId);

  if (!member.lookup) {
    const read = run.deps.memberFacts;
    member.lookup = read
      ? read(run.ctx.guildId, userId).catch((error: unknown) => {
          run.ctx.logger.warn(
            `achievements could not look ${userId} up, so nothing is unlocked for them this time: ` +
              reasonOf(error),
            { guildId: run.ctx.guildId, moduleId: MODULE_ID },
          );
          return undefined;
        })
      : Promise.resolve(undefined);
  }

  return member.lookup;
}

function isBlocked(run: Run, userId: string): Promise<boolean> {
  const member = memberOf(run, userId);

  if (!member.blocked) {
    const blocked = run.deps.blocked;
    member.blocked = blocked
      ? blocked
          .find(run.ctx.guildId, userId)
          .then((row) => row !== null)
          .catch((error: unknown) => {
            run.ctx.logger.warn(
              `achievements could not check whether ${userId} is blocked, so it treated them as ` +
                `not blocked: ${reasonOf(error)}`,
              { guildId: run.ctx.guildId, moduleId: MODULE_ID },
            );
            return false;
          })
      : Promise.resolve(false);
  }

  return member.blocked;
}

async function knownRoles(run: Run, userId: string): Promise<readonly string[] | null> {
  const member = memberOf(run, userId);
  if (member.subject?.roleIds) return member.subject.roleIds;
  if (!member.lookup) return null;
  return (await member.lookup)?.roleIds ?? null;
}

async function eligible(run: Run, userId: string, achievement: Achievement): Promise<boolean> {
  const subject = memberOf(run, userId).subject;
  if (subject?.isMember === false || subject?.isBot === true) return false;

  let roles: readonly string[] | null = subject?.roleIds ?? null;

  if (subject?.isMember !== true || subject.isBot !== false) {
    const found = await lookupMember(run, userId);
    if (found === undefined || found === null || found.bot) return false;
    roles ??= found.roleIds;
  }

  const excluded = [...achievement.excludedRoleIds, ...run.ctx.config.excludedRoleIds];

  if (achievement.roleIds.length > 0 || excluded.length > 0) {
    roles ??= (await lookupMember(run, userId))?.roleIds ?? null;
    if (roles === null) return false;

    const held = new Set(roles);
    if (achievement.roleIds.length > 0 && !achievement.roleIds.some((id) => held.has(id))) {
      return false;
    }
    if (excluded.some((id) => held.has(id))) return false;
  }

  return !(await isBlocked(run, userId));
}

function memo<T>(load: () => Promise<T>): () => Promise<T> {
  let loaded: Promise<T> | undefined;
  return () => {
    loaded ??= load();
    return loaded;
  };
}

interface StateReader {
  level(): Promise<number>;
  membershipDays(): Promise<number>;
  earned(): Promise<number>;
  holds(): Promise<UnlockRow[]>;
}

function stateReader(
  run: Run,
  userId: string,
  provided: Partial<Record<StateMetric, number>> | undefined,
): StateReader {
  const { ctx, deps, store, now } = run;
  const guildId = ctx.guildId;

  return {
    level: memo(async () => {
      if (provided?.level !== undefined) return provided.level;
      if (!deps.levelOf) return 0;
      try {
        return (await deps.levelOf(guildId, userId)) ?? 0;
      } catch (error) {
        ctx.logger.warn(`achievements could not read ${userId}’s level: ${reasonOf(error)}`, {
          guildId,
          moduleId: MODULE_ID,
        });
        return 0;
      }
    }),

    membershipDays: memo(async () => {
      if (provided?.membership_days !== undefined) return provided.membership_days;
      const facts = await store.facts(guildId, userId);
      if (!facts || facts.joinedAt === null || facts.leftAt !== null) return 0;
      return Math.max(0, Math.floor((now - facts.joinedAt) / DAY_MS));
    }),

    earned: memo(async () => {
      if (provided?.achievements_earned !== undefined) return provided.achievements_earned;
      return store.earnedCount(guildId, userId, run.index.collectors);
    }),

    holds: memo(() => store.unlocksOf(guildId, userId)),
  };
}

async function stateValue(requirement: Requirement, reader: StateReader): Promise<number> {
  switch (triggerOf(requirement.trigger).metric) {
    case 'level':
      return reader.level();
    case 'membership_days':
      return reader.membershipDays();
    case 'achievements_earned':
      return reader.earned();
    case 'achievement_tier': {
      const least = tierRank(requirement.tierId ?? 'single');
      const holds = await reader.holds();
      return holds.some(
        (row) => row.achievementId === requirement.achievementId && tierRank(row.tierId) >= least,
      )
        ? 1
        : 0;
    }
    default:
      return 0;
  }
}

async function valuesOf(
  achievement: Achievement,
  state: MemberAchievementState,
  reader: StateReader,
  display?: StateValue[],
): Promise<Record<string, number>> {
  const values: Record<string, number> = {};

  for (const requirement of achievement.requirements) {
    if (isLedger(triggerOf(requirement.trigger).metric)) {
      values[requirement.id] = requirementValue(state, requirement.id, requirement.version);
      continue;
    }

    const value = Math.max(0, Math.floor(await stateValue(requirement, reader)));
    values[requirement.id] = value;

    if (display && value !== requirementValue(state, requirement.id, requirement.version)) {
      display.push({
        achievementId: achievement.id,
        requirementId: requirement.id,
        version: requirement.version,
        value,
      });
    }
  }

  return values;
}

function snapshotOf(achievement: Achievement, tier: Tier, revision: string): UnlockDefinition {
  return {
    name: achievement.name,
    kind: achievement.kind,
    requirements: achievement.requirements.map((requirement) => ({
      id: requirement.id,
      version: requirement.version,
      trigger: requirement.trigger,
      target: tier.targets[requirement.id] ?? 1,
      channelIds: [...requirement.channelIds],
      excludedChannelIds: [...requirement.excludedChannelIds],
      ...(requirement.xpSources === undefined ? {} : { xpSources: [...requirement.xpSources] }),
      ...(requirement.achievementId === undefined
        ? {}
        : { achievementId: requirement.achievementId }),
      ...(requirement.tierId === undefined ? {} : { tierId: requirement.tierId }),
    })),
    rewards: tier.rewards.map((reward) => ({ ...reward })),
    revision,
  };
}

function tierInputs(
  achievement: Achievement,
  tierIds: readonly TierId[],
  values: Readonly<Record<string, number>>,
): UnlockTierInput[] {
  const revision = achievementRevision(achievement);
  const progress = Object.fromEntries(
    achievement.requirements.map(({ id }) => [id, Math.max(0, Math.floor(values[id] ?? 0))]),
  );

  return tierIds.flatMap((tierId) => {
    const tier = achievement.tiers.find(({ id }) => id === tierId);
    if (!tier) return [];

    return [
      {
        tierId,
        tierIndex: Math.max(0, tierRank(tierId) - 1),
        revision,
        definition: snapshotOf(achievement, tier, revision),
        progress,
      },
    ];
  });
}

function highestTier(achievement: Achievement): TierId | null {
  return [...achievement.tiers].sort((a, b) => tierRank(a.id) - tierRank(b.id)).at(-1)?.id ?? null;
}

// A running sweep holds a row whose run_at is past, so only a future-dated key survives it.
export function sweepSlot(at: number, step: number = SWEEP_SLOT_MS): { at: number; key: string } {
  const slot = Math.ceil(at / step) * step;
  return { at: slot, key: `${SWEEP_KEY}:${slot}` };
}

export async function armSweep(ctx: Context, deps: AchievementsDeps): Promise<void> {
  if (!ctx.schedule) {
    ctx.logger.warn(
      'achievements could not arm its sweep: this module’s context has no schedule port, so ' +
        'rewards and announcements a failure left behind are never retried. The process running ' +
        'modules must supply ModuleContext.schedule.',
      { guildId: ctx.guildId, moduleId: MODULE_ID },
    );
    return;
  }

  const slot = sweepSlot(clockOf(deps)() + SWEEP_ARM_DELAY_MS);
  await ctx.schedule(SWEEP_JOB, new Date(slot.at), slot.key, {});
}

export async function armDaily(ctx: Context, deps: AchievementsDeps): Promise<void> {
  if (!ctx.schedule) return;
  await ctx.schedule(DAILY_JOB, new Date(clockOf(deps)() + DAY_MS), DAILY_KEY, {});
}

async function ensureSweep(run: Run): Promise<void> {
  if (run.armed) return;
  await armSweep(run.ctx, run.deps);
  run.armed = true;
}

function unlockKey(row: UnlockRow): string {
  return `${row.userId}:${row.achievementId}:${row.tierId}:${row.generation}`;
}

export async function publishUnlocks(
  ctx: Context,
  deps: AchievementsDeps,
  rows: readonly UnlockRow[],
  causation?: Causation,
): Promise<void> {
  const store = deps.store;
  if (!store || rows.length === 0) return;

  const now = clockOf(deps)();

  if (!ctx.publish) {
    ctx.logger.warn(
      'achievements unlocked a tier but could not publish achievements.unlocked: this module’s ' +
        'context has no publish port, so achievements that count other achievements never see ' +
        'it. The process running modules must supply ModuleContext.publish.',
      { guildId: ctx.guildId, moduleId: MODULE_ID },
    );
    await store.markPublished(rows, now);
    return;
  }

  const published: UnlockRow[] = [];

  for (const row of rows) {
    const achievement = ctx.config.achievements.find(({ id }) => id === row.achievementId);
    const top = achievement ? highestTier(achievement) : null;

    const parsed = achievementUnlockedSchema.safeParse({
      guildId: ctx.guildId,
      userId: row.userId,
      achievementId: row.achievementId,
      tierId: row.tierId,
      generation: row.generation,
      unlockedAt: row.unlockedAt,
      final: top === null || top === row.tierId,
      ...(row.originChannelId === null ? {} : { originChannelId: row.originChannelId }),
      causation: {
        kind: 'achievement',
        rootId: causation?.rootId ?? `achievements:${ctx.guildId}:${unlockKey(row)}`,
        depth: Math.min(row.cause.depth, 32),
        sourceModule: MODULE_ID,
      },
    });

    if (!parsed.success) {
      ctx.logger.error(
        `achievements could not publish the unlock of ${row.achievementId} (${row.tierId}) for ` +
          `${row.userId}: ${parsed.error.message}`,
        { guildId: ctx.guildId, moduleId: MODULE_ID },
      );
      published.push(row);
      continue;
    }

    try {
      await ctx.publish('achievements.unlocked', unlockKey(row), parsed.data);
      published.push(row);
    } catch (error) {
      ctx.logger.error(
        `achievements could not publish the unlock of ${row.achievementId} (${row.tierId}) for ` +
          `${row.userId}; the sweep publishes it again: ${reasonOf(error)}`,
        { guildId: ctx.guildId, moduleId: MODULE_ID },
      );
    }
  }

  if (published.length > 0) await store.markPublished(published, now);
}

interface Trigger {
  userId: string;
  occurredAt: number;
  spanStart?: number | null | undefined;
  cause: UnlockCause;
  causation: Causation;
  originChannelId: string | null;
  stateValues?: Partial<Record<StateMetric, number>> | undefined;
}

function acceptedAt(
  achievement: Achievement,
  occurredAt: number,
  spanStart: number | null,
): number {
  const endsAt = achievement.endsAt === undefined ? Number.NaN : Date.parse(achievement.endsAt);
  if (spanStart === null || Number.isNaN(endsAt)) return occurredAt;
  return Math.min(occurredAt, Math.max(spanStart, endsAt));
}

async function mayUnlock(run: Run, trigger: Trigger, achievement: Achievement): Promise<boolean> {
  const at = acceptedAt(achievement, trigger.occurredAt, trigger.spanStart ?? null);
  if (!acceptsAt(achievement, at, run.now)) return false;

  if (trigger.causation.depth > MAX_CAUSATION_DEPTH) {
    run.ctx.logger.warn(
      `achievements did not unlock ${achievement.id} for ${trigger.userId}: it was caused by a ` +
        `chain ${trigger.causation.depth} steps deep, past the limit of ${MAX_CAUSATION_DEPTH}. ` +
        'The next state check or a re-check picks it up.',
      { guildId: run.ctx.guildId, moduleId: MODULE_ID, rootId: trigger.causation.rootId },
    );
    return false;
  }

  if (!(await dependenciesOn(run, achievement))) return false;
  return eligible(run, trigger.userId, achievement);
}

async function unlockTiers(
  run: Run,
  trigger: Trigger,
  achievement: Achievement,
  state: MemberAchievementState,
  tiers: readonly TierId[],
  values: Readonly<Record<string, number>>,
  reader: StateReader,
): Promise<{ rows: UnlockRow[]; generation: number }> {
  await ensureSweep(run);

  let current = state;
  let pending = tiers;
  let progress = values;

  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await run.store.unlock({
      guildId: run.ctx.guildId,
      userId: trigger.userId,
      achievementId: achievement.id,
      generation: current.generation,
      rewardEpoch: current.rewardEpoch,
      tiers: tierInputs(achievement, pending, progress),
      unlockedAt: run.now,
      cause: trigger.cause,
      originChannelId: trigger.originChannelId,
      announceGroup: crypto.randomUUID(),
      announce: run.announce,
    });

    if (!result.stale) return { rows: result.unlocks, generation: current.generation };

    const [reread] = await run.store.memberStates(run.ctx.guildId, trigger.userId, [
      achievement.id,
    ]);
    if (!reread) break;

    current = reread;
    progress = await valuesOf(achievement, reread, reader);
    pending = earnedTierIds(achievement, progress).filter((id) => !reread.unlocked.includes(id));
    if (pending.length === 0) return { rows: [], generation: current.generation };
  }

  run.ctx.logger.warn(
    `achievements did not unlock ${achievement.id} for ${trigger.userId}: a reset kept moving ` +
      'under it. The next activity or a re-check picks it up.',
    { guildId: run.ctx.guildId, moduleId: MODULE_ID },
  );
  return { rows: [], generation: current.generation };
}

async function afterUnlock(
  run: Run,
  trigger: Trigger,
  achievement: Achievement,
  rows: readonly UnlockRow[],
  generation: number,
): Promise<void> {
  const { ctx, deps } = run;

  await publishUnlocks(ctx, deps, rows, trigger.causation);

  await deliverRewards(ctx, deps, {
    userId: trigger.userId,
    achievementId: achievement.id,
    generation,
    roleIds: await knownRoles(run, trigger.userId),
    causation: trigger.causation,
    originChannelId: trigger.originChannelId,
  });

  const group = rows[0]?.announceGroup;
  if (group !== undefined) {
    await announceIfReady(ctx, deps, {
      userId: trigger.userId,
      achievementId: achievement.id,
      generation,
      group,
    });
  }
}

async function remind(
  run: Run,
  trigger: Trigger,
  achievement: Achievement,
  state: MemberAchievementState,
  values: Readonly<Record<string, number>>,
): Promise<void> {
  if (run.announce === 'suppressed' || !achievement.almostThere.enabled) return;
  if (trigger.causation.depth > MAX_CAUSATION_DEPTH) return;
  if (!acceptsAt(achievement, run.now, run.now)) return;

  const tierId = almostThereDue(achievement, values, state.unlocked, state.almostNotified);
  if (tierId === null) return;

  const cooldownMs = tryParseDuration(run.ctx.config.almostThere.cooldown) ?? DAY_MS;
  if (state.almostNotifiedAt !== null && state.almostNotifiedAt > run.now - cooldownMs) return;

  if (!(await dependenciesOn(run, achievement))) return;
  if (!(await eligible(run, trigger.userId, achievement))) return;

  await sendAlmostThere(run.ctx, run.deps, {
    userId: trigger.userId,
    achievement,
    generation: state.generation,
    tierId,
    values,
    unlocked: state.unlocked,
    originChannelId: trigger.originChannelId,
  });
}

async function evaluateStates(
  run: Run,
  trigger: Trigger,
  states: readonly MemberAchievementState[],
): Promise<UnlockRow[]> {
  const reader = stateReader(run, trigger.userId, trigger.stateValues);
  const display: StateValue[] = [];
  const open: Array<{
    achievement: Achievement;
    state: MemberAchievementState;
    values: Record<string, number>;
  }> = [];

  for (const state of states) {
    const achievement = run.index.byId.get(state.achievementId);
    if (achievement?.status !== 'active') continue;
    if (currentTierIds(achievement, state.unlocked).length >= achievement.tiers.length) continue;

    open.push({ achievement, state, values: await valuesOf(achievement, state, reader, display) });
  }

  if (display.length > 0) await run.store.setValues(run.ctx.guildId, trigger.userId, display);

  const created: UnlockRow[] = [];

  for (const { achievement, state, values } of open) {
    const fresh = earnedTierIds(achievement, values).filter((id) => !state.unlocked.includes(id));
    let rows: UnlockRow[] = [];

    if (fresh.length > 0 && (await mayUnlock(run, trigger, achievement))) {
      const result = await unlockTiers(run, trigger, achievement, state, fresh, values, reader);
      rows = result.rows;
      if (rows.length > 0) await afterUnlock(run, trigger, achievement, rows, result.generation);
    }

    if (rows.length === 0) await remind(run, trigger, achievement, state, values);
    created.push(...rows);
  }

  return created;
}

function windowsOf(achievement: Achievement, runtime: GuildRuntime): Interval[] {
  return countingWindows(achievement, {
    module: runtime.modulePeriods,
    achievement: runtime.periods.get(achievement.id) ?? [],
  });
}

function amountFor(route: Route, record: ActivityRecord, windows: readonly Interval[]): number {
  if (route.trigger.measurement === 'count') {
    return withinWindows(record.occurredAt, windows) ? record.amount : 0;
  }

  if (record.spanStart === null) return 0;
  return Math.floor(
    clipSpan({ start: record.spanStart, end: record.occurredAt }, windows) / MINUTE_MS,
  );
}

async function routeRecord(
  run: Run,
  record: ActivityRecord,
  runtime: GuildRuntime,
): Promise<{ targets: ProgressTarget[]; candidates: string[] }> {
  const targets: ProgressTarget[] = [];
  const candidates = new Set<string>();

  for (const route of run.index.routes.get(record.metric) ?? []) {
    const { achievement, requirement, trigger } = route;

    if (trigger.temporaryOnly && !record.temporary) continue;
    if (route.xpSources !== null) {
      if (record.xpSource === null || !route.xpSources.includes(record.xpSource)) continue;
    }
    if (trigger.filters.channels && !channelMatches(requirement, record)) continue;
    const at = acceptedAt(achievement, record.occurredAt, record.spanStart);
    if (!acceptsAt(achievement, at, run.now)) continue;
    if (!(await dependenciesOn(run, achievement))) continue;

    candidates.add(achievement.id);

    const amount = amountFor(route, record, windowsOf(achievement, runtime));
    if (amount > 0) {
      targets.push({
        achievementId: achievement.id,
        requirementId: requirement.id,
        version: requirement.version,
        aggregate: route.aggregate,
        amount,
      });
    }
  }

  return { targets, candidates: [...candidates] };
}

async function checkState(
  run: Run,
  input: StateCheckInput,
  exclude: readonly string[] = [],
): Promise<UnlockRow[]> {
  const ids = run.index.stateful.map(({ id }) => id).filter((id) => !exclude.includes(id));
  if (ids.length === 0 || !run.deps.limits) return [];

  // Keyed by the root event so a redelivery of the event that won the slot runs the check again.
  const claimed = await run.deps.limits.claim(
    `proton:achievements:state:${run.ctx.guildId}:${input.userId}`,
    input.causation.rootId,
    STATE_CHECK_TTL_MS,
  );
  if (!claimed) return [];

  const states = await run.store.memberStates(run.ctx.guildId, input.userId, ids);
  const at = Math.min(input.occurredAt ?? run.now, run.now);

  return evaluateStates(
    run,
    {
      userId: input.userId,
      occurredAt: run.now,
      // The state has held since the event that raised it, so a deadline is judged against that.
      spanStart: at,
      cause: {
        metric: 'state',
        occurredAt: at,
        sourceModule: input.causation.sourceModule ?? MODULE_ID,
        depth: input.causation.depth,
      },
      causation: input.causation,
      originChannelId: input.originChannelId,
    },
    states,
  );
}

export async function processRecords(
  ctx: Context,
  deps: AchievementsDeps,
  input: ProcessInput,
): Promise<void> {
  if (!ctx.config.enabled || input.records.length === 0) return;

  const store = storeOf(ctx, deps, 'counting activity');
  if (!store) return;

  const run = newRun(ctx, deps, store, input.announce);
  for (const [userId, subject] of input.subjects ?? new Map<string, SubjectFacts>()) {
    memberOf(run, userId).subject = subject;
  }

  for (const raw of input.records) {
    const parsed = activityRecordSchema.safeParse(raw);
    if (!parsed.success) {
      ctx.logger.error(
        `achievements ignored an activity record it could not read: ${parsed.error.message}`,
        { guildId: ctx.guildId, moduleId: MODULE_ID },
      );
      continue;
    }

    const record = parsed.data;
    if (record.guildId !== ctx.guildId) {
      ctx.logger.error(
        `achievements ignored an activity record for server ${record.guildId}: it arrived for ` +
          'this one.',
        { guildId: ctx.guildId, moduleId: MODULE_ID },
      );
      continue;
    }

    const runtime = await runtimeOf(run);
    const { targets, candidates } = await routeRecord(run, record, runtime);
    const result = await store.record(record, targets, candidates);
    // The row is committed and its key is deduped, so the collector settles its own cursor here.
    await input.onRecorded?.(record);

    await evaluateStates(
      run,
      {
        userId: record.userId,
        occurredAt: record.occurredAt,
        spanStart: record.spanStart,
        cause: {
          metric: record.metric,
          occurredAt: record.occurredAt,
          sourceModule: record.sourceModule,
          depth: record.causation.depth,
        },
        causation: record.causation,
        originChannelId: input.originChannelId,
      },
      result.states,
    );

    await checkState(
      run,
      {
        userId: record.userId,
        originChannelId: input.originChannelId,
        occurredAt: record.occurredAt,
        causation: record.causation,
      },
      candidates,
    );
  }
}

export async function evaluateMemberUnlocks(
  ctx: Context,
  deps: AchievementsDeps,
  input: EvaluateInput,
): Promise<UnlockRow[]> {
  if (!ctx.config.enabled) return [];

  const store = storeOf(ctx, deps, 'checking achievements');
  if (!store) return [];

  const run = newRun(ctx, deps, store, input.announce);
  if (input.subject) memberOf(run, input.userId).subject = input.subject;

  const wanted = input.achievementIds ?? run.index.active.map(({ id }) => id);
  const ids = [...new Set(wanted)].filter((id) => run.index.byId.get(id)?.status === 'active');
  if (ids.length === 0) return [];

  const states = await store.memberStates(ctx.guildId, input.userId, ids);
  const at = Math.min(input.occurredAt ?? run.now, run.now);

  return evaluateStates(
    run,
    {
      userId: input.userId,
      occurredAt: run.now,
      // The state has held since the event that raised it, so a deadline is judged against that.
      spanStart: at,
      cause: {
        metric: Object.keys(input.stateValues ?? {})[0] ?? 'state',
        occurredAt: at,
        sourceModule: input.causation.sourceModule ?? MODULE_ID,
        depth: input.causation.depth,
      },
      causation: input.causation,
      originChannelId: input.originChannelId,
      stateValues: input.stateValues,
    },
    states,
  );
}

export async function evaluateMember(
  ctx: Context,
  deps: AchievementsDeps,
  input: EvaluateInput,
): Promise<void> {
  await evaluateMemberUnlocks(ctx, deps, input);
}

export async function maybeCheckState(
  ctx: Context,
  deps: AchievementsDeps,
  input: StateCheckInput,
): Promise<void> {
  if (!ctx.config.enabled) return;

  const store = storeOf(ctx, deps, 'checking state achievements');
  if (!store) return;

  const run = newRun(ctx, deps, store, 'pending');
  if (input.subject) memberOf(run, input.userId).subject = input.subject;

  await checkState(run, input);
}

export function startsAfter(achievement: Achievement, now: number): number | null {
  const startsAt =
    achievement.startsAt === undefined ? Number.NaN : Date.parse(achievement.startsAt);
  return Number.isNaN(startsAt) || startsAt <= now ? null : startsAt;
}

export function initialJobFor(achievement: Achievement): 'rebuild' | 'recheck' | null {
  if (achievement.includeRecorded && hasLedgerRequirement(achievement)) return 'rebuild';
  if (hasStateRequirement(achievement)) return 'recheck';
  return null;
}

async function queueJob(
  ctx: Context,
  store: AchievementStore,
  achievement: Achievement,
  job: 'rebuild' | 'recheck',
  now: number,
): Promise<void> {
  if (!ctx.schedule) {
    ctx.logger.warn(
      `achievements could not queue the ${job} of ${achievement.id}: this module’s context has ` +
        'no schedule port.',
      { guildId: ctx.guildId, moduleId: MODULE_ID },
    );
    return;
  }

  await store.setJob(ctx.guildId, achievement.id, {
    job,
    status: 'queued',
    cursor: null,
    requestedAt: now,
    requestedBy: ACHIEVEMENTS_ACTOR,
    finishedAt: null,
    result: null,
    announce: false,
    acceptLoss: false,
  });

  // A re-check before the start date accepts nobody, so it waits for the date instead.
  const waitUntil = job === 'recheck' ? startsAfter(achievement, now) : null;

  await ctx.schedule(
    ACHIEVEMENT_JOB,
    new Date((waitUntil ?? now) + JOB_START_DELAY_MS),
    achievement.id,
    { achievementId: achievement.id },
    { replace: true },
  );
}

export async function activate(
  ctx: Context,
  deps: AchievementsDeps,
  achievementIds: readonly string[],
): Promise<void> {
  const store = deps.store;
  if (!store || achievementIds.length === 0) return;

  const now = clockOf(deps)();

  for (const achievementId of achievementIds) {
    const achievement = ctx.config.achievements.find(({ id }) => id === achievementId);
    const job = achievement === undefined ? null : initialJobFor(achievement);
    if (achievement === undefined || job === null) continue;

    await queueJob(ctx, store, achievement, job, now);
  }
}

function openedAt(runtime: GuildRuntime, achievementId: string): number | null {
  return runtime.periods.get(achievementId)?.find(({ end }) => end === null)?.start ?? null;
}

export async function recheckReopened(
  ctx: Context,
  deps: AchievementsDeps,
  achievementIds: readonly string[],
): Promise<void> {
  const store = deps.store;
  if (!store || achievementIds.length === 0) return;

  const now = clockOf(deps)();
  const runtime = await store.runtime(ctx.guildId);

  for (const achievementId of achievementIds) {
    const achievement = ctx.config.achievements.find(
      ({ id, status }) => id === achievementId && status === 'active',
    );
    if (!achievement || !hasStateRequirement(achievement)) continue;

    const start = openedAt(runtime, achievementId);
    if (start === null) continue;

    // Re-enabling the module reopens every achievement at once, so a covered one is left alone.
    const state = await store.job(ctx.guildId, achievementId);
    if (state && (state.status === 'queued' || state.status === 'running')) continue;
    if (state?.job === 'recheck' && state.status === 'done' && (state.finishedAt ?? 0) >= start) {
      continue;
    }

    await queueJob(ctx, store, achievement, 'recheck', now);
  }
}

export const JOB_STOPPED_OFF = 'Achievements was turned off, so the job stopped. Start it again.';

async function stopJobs(ctx: Context, store: AchievementStore, now: number): Promise<void> {
  for (const state of await store.jobs(ctx.guildId)) {
    if (state.status !== 'queued' && state.status !== 'running') continue;

    await store.setJob(ctx.guildId, state.achievementId, {
      status: 'failed',
      cursor: null,
      finishedAt: now,
      result: {
        ...(state.result ?? {
          members: 0,
          changed: 0,
          lost: 0,
          newlyEarned: { ...NO_NEWLY_EARNED },
        }),
        reason: JOB_STOPPED_OFF,
      },
    });
  }
}

const NOT_CHANGED = { turnedOff: false, turnedOn: false } as const;

export async function handleConfigChanged(
  ctx: Context,
  deps: AchievementsDeps,
  event: ProtonEvent,
): Promise<{ turnedOff: boolean; turnedOn: boolean }> {
  const parsed = protonConfigChangedSchema.safeParse(event.payload);
  if (!parsed.success || parsed.data.moduleId !== MODULE_ID) return { ...NOT_CHANGED };

  const change = parsed.data;
  const flipped =
    change.enabledBefore !== change.enabledAfter || change.changedKeys.includes('enabled');
  const on = change.enabledAfter && ctx.config.enabled;
  const outcome = {
    turnedOff: !on && (change.enabledBefore || flipped),
    turnedOn: on && (!change.enabledBefore || flipped),
  };

  const store = deps.store;
  if (!store) {
    if (on) storeOf(ctx, deps, 'counting activity');
    return outcome;
  }

  forgetRuntime(store, ctx.guildId);
  const { firstActivation, reopened } = await store.syncPeriods(ctx.guildId, event.occurredAt);
  forgetRuntime(store, ctx.guildId);

  if (on) {
    // syncPeriods reports a first activation once, so its job is queued before anything that can throw.
    await activate(ctx, deps, firstActivation);
    await recheckReopened(ctx, deps, reopened);
    await armSweep(ctx, deps);
    await armDaily(ctx, deps);
  } else {
    await stopJobs(ctx, store, clockOf(deps)());
  }

  return outcome;
}

export async function handleGuildAvailable(
  ctx: Context,
  deps: AchievementsDeps,
  _event: ProtonEvent,
): Promise<void> {
  if (!ctx.config.enabled) return;

  const store = storeOf(ctx, deps, 'counting activity');
  if (!store) return;

  const { firstActivation, reopened } = await store.syncPeriods(ctx.guildId, clockOf(deps)());
  forgetRuntime(store, ctx.guildId);

  await activate(ctx, deps, firstActivation);
  await recheckReopened(ctx, deps, reopened);
  await armSweep(ctx, deps);
  await armDaily(ctx, deps);
}

export async function handleXpGranted(
  ctx: Context,
  deps: AchievementsDeps,
  event: ProtonEvent,
): Promise<void> {
  if (!ctx.config.enabled) return;

  const parsed = xpGrantedSchema.safeParse(event.payload);
  if (!parsed.success) {
    ctx.logger.warn(
      `achievements ignored an XP grant answer it could not read: ${parsed.error.message}`,
      { guildId: ctx.guildId, moduleId: MODULE_ID, eventId: event.id },
    );
    return;
  }

  const answer = parsed.data;
  if (answer.sourceModule !== MODULE_ID || answer.guildId !== ctx.guildId) return;

  const grant = parseXpGrantId(answer.grantId);
  if (!grant || grant.guildId !== ctx.guildId) return;

  const store = storeOf(ctx, deps, 'recording XP rewards');
  if (!store) return;

  const row = await store.confirmXpGrant(ctx.guildId, answer.grantId, {
    granted: answer.status === 'granted',
    ...(answer.status === 'refused'
      ? {
          error:
            answer.reason === undefined
              ? XP_REFUSED
              : `Leveling refused the XP reward: ${answer.reason}`,
        }
      : {}),
    now: clockOf(deps)(),
  });
  if (!row) return;

  await announceUnlockOf(ctx, deps, {
    userId: row.userId,
    achievementId: row.achievementId,
    tierId: row.tierId,
    generation: row.generation,
  });
}

function notRetried(
  rewards: ReadonlyArray<Omit<AchievementRetryResult, 'status' | 'message'>>,
  message: string,
): AchievementRetryResult[] {
  return rewards.map((reward) => ({ ...reward, status: 'not_retryable', message }));
}

export async function handleRetryRequest(
  ctx: Context,
  deps: AchievementsDeps,
  event: ProtonEvent,
): Promise<void> {
  const parsed = achievementRewardRetryRequestedSchema.safeParse(event.payload);
  if (!parsed.success) {
    ctx.logger.error(
      `achievements ignored a reward retry request it could not read: ${parsed.error.message}`,
      { guildId: ctx.guildId, moduleId: MODULE_ID, eventId: event.id },
    );
    return;
  }

  const request = parsed.data;
  if (request.guildId !== ctx.guildId) return;

  const mailbox = deps.mailbox;
  if (!mailbox) {
    ctx.logger.error(describeUnbound('retrying rewards', ['mailbox']), {
      guildId: ctx.guildId,
      moduleId: MODULE_ID,
    });
    return;
  }

  const answerId = `${ctx.guildId}:${request.requestId}`;

  if (!deps.store) {
    await mailbox.answer(answerId, {
      results: notRetried(request.rewards, describeUnbound('retrying rewards', ['store'])),
    });
    return;
  }

  if (!ctx.config.enabled) {
    await mailbox.answer(answerId, {
      results: notRetried(
        request.rewards,
        'Achievements is off in this server, so nothing was retried.',
      ),
    });
    return;
  }

  const results: AchievementRetryResult[] = [];

  for (const ref of request.rewards) {
    try {
      results.push(await retryReward(ctx, deps, ref));
      await announceUnlockOf(ctx, deps, ref);
    } catch (error) {
      ctx.logger.error(
        `achievements could not retry ${ref.rewardKey} for ${ref.userId}: ${reasonOf(error)}`,
        { guildId: ctx.guildId, moduleId: MODULE_ID },
      );
      results.push({
        ...ref,
        status: 'failed',
        message: `Proton hit an unexpected problem retrying it: ${reasonOf(error)}`.slice(0, 400),
      });
    }
  }

  await mailbox.answer(answerId, { results });
}

export async function handleJobRequest(
  ctx: Context,
  deps: AchievementsDeps,
  event: ProtonEvent,
): Promise<void> {
  const parsed = achievementJobRequestedSchema.safeParse(event.payload);
  if (!parsed.success) {
    ctx.logger.error(
      `achievements ignored a job request it could not read: ${parsed.error.message}`,
      { guildId: ctx.guildId, moduleId: MODULE_ID, eventId: event.id },
    );
    return;
  }

  const request = parsed.data;
  if (request.guildId !== ctx.guildId) return;

  const store = storeOf(ctx, deps, 'running achievement jobs');
  if (!store) return;

  const now = clockOf(deps)();
  const refuse = (reason: string) =>
    store.setJob(ctx.guildId, request.achievementId, {
      job: request.job,
      status: 'failed',
      cursor: null,
      finishedAt: now,
      result: { members: 0, changed: 0, lost: 0, newlyEarned: { ...NO_NEWLY_EARNED }, reason },
    });

  if (!ctx.config.enabled) {
    await refuse(
      'Achievements is off in this server, so the job didn’t run. Turn it on and try again.',
    );
    return;
  }

  if (!ctx.schedule) {
    await refuse('Proton couldn’t schedule this job, so it didn’t run. Try again in a moment.');
    return;
  }

  await store.setJob(ctx.guildId, request.achievementId, {
    job: request.job,
    status: 'queued',
    cursor: null,
    requestedAt: event.occurredAt,
    requestedBy: request.actorId,
    finishedAt: null,
    result: null,
    announce: request.announce,
    acceptLoss: request.acceptLoss,
  });

  await ctx.schedule(
    ACHIEVEMENT_JOB,
    new Date(now + JOB_START_DELAY_MS),
    request.achievementId,
    request,
    { replace: true },
  );
}
