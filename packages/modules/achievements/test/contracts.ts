import { beforeEach, describe, expect, test } from 'bun:test';
import { TIER_IDS, type TierId } from '@proton/core';
import type { NewAuditTrailEntry } from '@proton/db';
import type { ActivityRecord } from '../src/activity.ts';
import { type AchievementInput, achievementSchema, type Reward } from '../src/config.ts';
import { XP_CONFIRM_TIMEOUT_MS } from '../src/constants.ts';
import type { AchievementLimits, FencedLocks } from '../src/deps.ts';
import { rebuildSignature } from '../src/rebuild.ts';
import {
  type AchievementStore,
  ALREADY_GIVEN,
  CANCELLED_BY_RESET,
  type JobState,
  type PendingOrigin,
  type ProgressTarget,
  RESET_BEFORE_ANNOUNCED,
  type RebuildPlan,
  type RecordResult,
  type RewardRef,
  type RewardRow,
  requirementValue,
  type UnlockInput,
  xpGrantId,
} from '../src/store.ts';
import type { UnlockDefinition } from '../src/view.ts';
import type { AchievementVoiceSession, AchievementVoiceStore } from '../src/voice-store.ts';

export const GUILD = '900000000000000001';
export const OTHER_GUILD = '900000000000000002';
export const USER = '100000000000000001';
export const USER_2 = '100000000000000002';
export const USER_3 = '100000000000000003';
export const ACTOR = '100000000000000099';
export const CHANNEL = '500000000000000001';
export const OTHER_CHANNEL = '500000000000000002';
export const CATEGORY = '500000000000000009';
export const ROLE = '300000000000000001';
export const MESSAGE = '700000000000000001';

export const ACHIEVEMENT = 'chatterbox';
export const MINUTE = 60 * 1000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;
export const T0 = Date.UTC(2026, 8, 1, 12, 0, 0);

const ORIGIN: PendingOrigin = {
  sourceModule: 'giveaways',
  causation: { kind: 'organic', rootId: 'giveaways.ended:1', depth: 0 },
};

const ROLE_REWARD: Reward = { kind: 'add_role', roleId: ROLE };
const XP_REWARD: Reward = { kind: 'xp', amount: 250 };

export const CHATTERBOX: AchievementInput = {
  id: ACHIEVEMENT,
  name: 'Chatterbox',
  kind: 'tiered',
  status: 'active',
  requirements: [{ id: 'messages', trigger: 'messages.sent' }],
  tiers: [
    { id: 'bronze', targets: { messages: 10 } },
    { id: 'silver', targets: { messages: 100 } },
  ],
};

export function activity(overrides: Partial<ActivityRecord> = {}): ActivityRecord {
  return {
    guildId: GUILD,
    userId: USER,
    metric: 'messages',
    sourceKey: 'message-1',
    occurredAt: T0,
    spanStart: null,
    amount: 1,
    channelId: CHANNEL,
    parentId: null,
    categoryId: CATEGORY,
    temporary: false,
    xpSource: null,
    groupKey: null,
    pending: false,
    sourceModule: 'discord',
    causation: { kind: 'organic', rootId: 'message.created:1', depth: 0 },
    ...overrides,
  };
}

export function target(overrides: Partial<ProgressTarget> = {}): ProgressTarget {
  return {
    achievementId: ACHIEVEMENT,
    requirementId: 'messages',
    version: 1,
    aggregate: 'sum',
    amount: 1,
    ...overrides,
  };
}

function definition(rewards: readonly Reward[]): UnlockDefinition {
  return {
    name: 'Chatterbox',
    kind: 'tiered',
    requirements: [
      {
        id: 'messages',
        version: 1,
        trigger: 'messages.sent',
        target: 10,
        channelIds: [],
        excludedChannelIds: [],
      },
    ],
    rewards: [...rewards],
    revision: 'revision-1',
  };
}

export function unlockInput(
  options: {
    guildId?: string;
    userId?: string;
    achievementId?: string;
    generation?: number;
    rewardEpoch?: number;
    tiers?: TierId[];
    rewards?: Reward[];
    unlockedAt?: number;
    group?: string;
    announce?: UnlockInput['announce'];
  } = {},
): UnlockInput {
  const tiers = options.tiers ?? ['bronze'];

  return {
    guildId: options.guildId ?? GUILD,
    userId: options.userId ?? USER,
    achievementId: options.achievementId ?? ACHIEVEMENT,
    generation: options.generation ?? 0,
    rewardEpoch: options.rewardEpoch ?? 0,
    tiers: tiers.map((tierId) => ({
      tierId,
      tierIndex: Math.max(0, TIER_IDS.indexOf(tierId) - 1),
      revision: 'revision-1',
      definition: definition(options.rewards ?? []),
      progress: { messages: 10 },
    })),
    unlockedAt: options.unlockedAt ?? T0,
    cause: { metric: 'messages', occurredAt: T0, sourceModule: 'discord', depth: 0 },
    originChannelId: CHANNEL,
    announceGroup: options.group ?? 'group-1',
    announce: options.announce ?? 'pending',
  };
}

export function audit(id: string, guildId = GUILD): NewAuditTrailEntry {
  return {
    id,
    guildId,
    actorId: ACTOR,
    source: 'dashboard',
    action: 'module.achievements.reset',
    before: null,
    after: { reset: id },
  };
}

export function refOf(row: RewardRow): RewardRef {
  return {
    guildId: row.guildId,
    userId: row.userId,
    achievementId: row.achievementId,
    tierId: row.tierId,
    generation: row.generation,
    rewardKey: row.rewardKey,
  };
}

function progressOf(result: RecordResult, requirementId = 'messages', version = 1): number {
  const state = result.states[0];
  return state ? requirementValue(state, requirementId, version) : Number.NaN;
}

export function plan(overrides: Partial<RebuildPlan> = {}): RebuildPlan {
  return {
    achievementId: ACHIEVEMENT,
    requirements: [
      {
        requirementId: 'messages',
        version: 1,
        metric: 'messages',
        aggregate: 'sum',
        temporaryOnly: false,
        xpSources: null,
        channelIds: [],
        excludedChannelIds: [],
      },
    ],
    stateRequirements: [],
    tiers: [
      { tierId: 'bronze', targets: { messages: 2 } },
      { tierId: 'silver', targets: { messages: 5 } },
    ],
    windows: [{ start: T0, end: null }],
    keepHigher: false,
    signature: 'signature-1',
    ...overrides,
  };
}

export interface StoreHarness {
  store: AchievementStore;
  setModule(guildId: string, enabled: boolean, config: unknown): Promise<void>;
}

export function describeAchievementStore(name: string, setup: () => Promise<StoreHarness>): void {
  describe(`${name}: recording activity`, () => {
    let h: StoreHarness;

    beforeEach(async () => {
      h = await setup();
    });

    test('a duplicate record counts nothing but still returns the member’s states', async () => {
      const first = await h.store.record(activity(), [target()], [ACHIEVEMENT]);
      expect(first.fresh).toBe(true);
      expect(progressOf(first)).toBe(1);

      const again = await h.store.record(activity(), [target()], [ACHIEVEMENT]);
      expect(again.fresh).toBe(false);
      expect(again.states).toHaveLength(1);
      expect(progressOf(again)).toBe(1);
    });

    test('concurrent records for the same member both count', async () => {
      await Promise.all([
        h.store.record(activity({ sourceKey: 'message-1' }), [target()], [ACHIEVEMENT]),
        h.store.record(activity({ sourceKey: 'message-2' }), [target()], [ACHIEVEMENT]),
        h.store.record(activity({ sourceKey: 'message-3' }), [target()], [ACHIEVEMENT]),
      ]);

      const [state] = await h.store.memberStates(GUILD, USER, [ACHIEVEMENT]);
      expect(state && requirementValue(state, 'messages', 1)).toBe(3);
    });

    test('every listed achievement comes back, targeted or not, in the order asked', async () => {
      const result = await h.store.record(activity(), [], ['voice-regular', ACHIEVEMENT]);

      expect(result.fresh).toBe(true);
      expect(result.states.map((state) => state.achievementId)).toEqual([
        'voice-regular',
        ACHIEVEMENT,
      ]);
      expect(result.states[1]).toEqual({
        achievementId: ACHIEVEMENT,
        userId: USER,
        generation: 0,
        rewardEpoch: 0,
        countedFrom: null,
        values: {},
        unlocked: [],
        almostNotified: [],
        almostNotifiedAt: null,
      });
    });

    test('a newer version replaces, an equal one adds and an older writer changes nothing', async () => {
      await h.store.record(activity({ sourceKey: 'a' }), [target({ amount: 3 })], [ACHIEVEMENT]);
      const replaced = await h.store.record(
        activity({ sourceKey: 'b' }),
        [target({ version: 2, amount: 1 })],
        [ACHIEVEMENT],
      );
      expect(progressOf(replaced, 'messages', 2)).toBe(1);

      const stale = await h.store.record(
        activity({ sourceKey: 'c' }),
        [target({ version: 1, amount: 5 })],
        [ACHIEVEMENT],
      );
      expect(progressOf(stale, 'messages', 2)).toBe(1);
      expect(progressOf(stale, 'messages', 1)).toBe(0);

      const added = await h.store.record(
        activity({ sourceKey: 'd' }),
        [target({ version: 2, amount: 2 })],
        [ACHIEVEMENT],
      );
      expect(added.states[0]?.values.messages).toEqual({ value: 3, version: 2, generation: 0 });
    });

    test('a record-style requirement keeps the longest value', async () => {
      const stay = (sourceKey: string, amount: number) =>
        h.store.record(
          activity({ metric: 'voice_stay', sourceKey, spanStart: T0 - amount * MINUTE, amount }),
          [target({ requirementId: 'stay', aggregate: 'max', amount })],
          [ACHIEVEMENT],
        );

      expect(progressOf(await stay('stay-1', 30), 'stay')).toBe(30);
      expect(progressOf(await stay('stay-2', 20), 'stay')).toBe(30);
      expect(progressOf(await stay('stay-3', 45), 'stay')).toBe(45);
    });

    test('pending entries wait, count once when released and never after a void', async () => {
      const entered = target({ requirementId: 'entered' });
      const entry = activity({
        metric: 'giveaways_entered',
        sourceKey: `giveaway-1:${USER}`,
        groupKey: 'giveaway:giveaway-1',
        pending: true,
      });

      const held = await h.store.record(entry, [entered], [ACHIEVEMENT]);
      expect(held.fresh).toBe(true);
      expect(progressOf(held, 'entered')).toBe(0);

      const released = await h.store.releasePending(GUILD, 'giveaway:giveaway-1', 'count', ORIGIN);
      expect(released).toHaveLength(1);
      expect(released[0]).toMatchObject({
        guildId: GUILD,
        userId: USER,
        metric: 'giveaways_entered',
        sourceKey: `giveaway-1:${USER}`,
        occurredAt: T0,
        amount: 1,
        pending: false,
        groupKey: 'giveaway:giveaway-1',
        channelId: CHANNEL,
        sourceModule: 'giveaways',
        causation: ORIGIN.causation,
      });

      const released0 = released[0] as ActivityRecord;
      const counted = await h.store.record(released0, [entered], [ACHIEVEMENT]);
      expect(counted.fresh).toBe(true);
      expect(progressOf(counted, 'entered')).toBe(1);

      const again = await h.store.releasePending(GUILD, 'giveaway:giveaway-1', 'count', ORIGIN);
      expect(again).toHaveLength(1);
      const replay = await h.store.record(again[0] as ActivityRecord, [entered], [ACHIEVEMENT]);
      expect(replay.fresh).toBe(false);
      expect(progressOf(replay, 'entered')).toBe(1);

      const cancelled = activity({
        metric: 'giveaways_entered',
        sourceKey: `giveaway-2:${USER}`,
        groupKey: 'giveaway:giveaway-2',
        pending: true,
      });
      await h.store.record(cancelled, [entered], [ACHIEVEMENT]);

      const release = (outcome: 'count' | 'void') =>
        h.store.releasePending(GUILD, 'giveaway:giveaway-2', outcome, ORIGIN);
      expect(await release('void')).toEqual([]);
      expect(await release('count')).toEqual([]);

      const late = await h.store.record({ ...cancelled, pending: false }, [entered], [ACHIEVEMENT]);
      expect(late.fresh).toBe(false);
      expect(progressOf(late, 'entered')).toBe(1);
    });

    test('an entry that lands after its giveaway ended counts, one after a cancel never does', async () => {
      const entered = target({ requirementId: 'entered' });
      const entry = (giveaway: string) =>
        activity({
          metric: 'giveaways_entered',
          sourceKey: `${giveaway}:${USER}`,
          groupKey: `giveaway:${giveaway}`,
          pending: true,
        });

      expect(await h.store.releasePending(GUILD, 'giveaway:ended', 'count', ORIGIN)).toEqual([]);
      const late = await h.store.record(entry('ended'), [entered], [ACHIEVEMENT]);
      expect(late.fresh).toBe(true);
      expect(progressOf(late, 'entered')).toBe(1);

      const redelivered = await h.store.record(entry('ended'), [entered], [ACHIEVEMENT]);
      expect(redelivered.fresh).toBe(false);
      expect(progressOf(redelivered, 'entered')).toBe(1);

      const reroll = await h.store.releasePending(GUILD, 'giveaway:ended', 'count', ORIGIN);
      expect(reroll).toHaveLength(1);
      const replay = await h.store.record(reroll[0] as ActivityRecord, [entered], [ACHIEVEMENT]);
      expect(progressOf(replay, 'entered')).toBe(1);

      await h.store.releasePending(GUILD, 'giveaway:cancelled', 'void', ORIGIN);
      const void_ = await h.store.record(entry('cancelled'), [entered], [ACHIEVEMENT]);
      expect(progressOf(void_, 'entered')).toBe(1);
      expect(await h.store.releasePending(GUILD, 'giveaway:cancelled', 'count', ORIGIN)).toEqual(
        [],
      );
    });

    test('a day spent before an achievement accepted it still counts once, later that day', async () => {
      const day = target({ requirementId: 'days' });
      const activeDay = (occurredAt: number, targets: ProgressTarget[]) =>
        h.store.record(
          activity({ metric: 'active_days', sourceKey: `${USER}:2026-09-01`, occurredAt }),
          targets,
          [ACHIEVEMENT],
        );

      expect((await activeDay(T0, [])).fresh).toBe(true);
      expect(progressOf(await activeDay(T0 + HOUR, [day]), 'days')).toBe(1);
      expect(progressOf(await activeDay(T0 + 2 * HOUR, [day]), 'days')).toBe(1);

      await h.store.rebuildSlice(
        GUILD,
        plan({
          requirements: [
            {
              requirementId: 'days',
              version: 1,
              metric: 'active_days',
              aggregate: 'sum',
              temporaryOnly: false,
              xpSources: null,
              channelIds: [],
              excludedChannelIds: [],
            },
          ],
          tiers: [{ tierId: 'bronze', targets: { days: 1 } }],
          windows: [{ start: T0 - DAY, end: null }],
        }),
        null,
        'write',
      );

      const [state] = await h.store.memberStates(GUILD, USER, [ACHIEVEMENT]);
      expect(state && requirementValue(state, 'days', 1)).toBe(1);
    });

    test('activity from before a member’s reset is kept out of their progress', async () => {
      await h.store.record(activity({ sourceKey: 'a' }), [target()], [ACHIEVEMENT]);
      await h.store.resetMember({
        guildId: GUILD,
        achievementIds: [ACHIEVEMENT],
        userId: USER,
        allowRewardsAgain: false,
        actorId: ACTOR,
        at: T0 + HOUR,
        audit: audit('reset-member-1'),
      });

      const [state] = await h.store.memberStates(GUILD, USER, [ACHIEVEMENT]);
      expect(state?.generation).toBe(1);
      expect(state?.countedFrom).toBe(T0 + HOUR);
      expect(state && requirementValue(state, 'messages', 1)).toBe(0);

      const early = await h.store.record(
        activity({ sourceKey: 'b', occurredAt: T0 + HOUR - 1 }),
        [target()],
        [ACHIEVEMENT],
      );
      expect(early.fresh).toBe(true);
      expect(progressOf(early)).toBe(0);

      const later = await h.store.record(
        activity({ sourceKey: 'c', occurredAt: T0 + HOUR + 1 }),
        [target()],
        [ACHIEVEMENT],
      );
      expect(later.states[0]?.values.messages).toEqual({ value: 1, version: 1, generation: 1 });
    });

    test('state values replace rather than add, under the member’s generation', async () => {
      const level = (value: number) =>
        h.store.setValues(GUILD, USER, [
          { achievementId: 'rising-star', requirementId: 'level', version: 1, value },
        ]);

      await level(12);
      await level(9);
      let [state] = await h.store.memberStates(GUILD, USER, ['rising-star']);
      expect(state?.values.level).toEqual({ value: 9, version: 1, generation: 0 });

      await h.store.resetMember({
        guildId: GUILD,
        achievementIds: ['rising-star'],
        userId: USER,
        allowRewardsAgain: false,
        actorId: ACTOR,
        at: T0,
        audit: audit('reset-member-2'),
      });
      await level(4);
      [state] = await h.store.memberStates(GUILD, USER, ['rising-star']);
      expect(state?.values.level).toEqual({ value: 4, version: 1, generation: 1 });
    });

    test('one server’s activity never reaches another', async () => {
      await h.store.record(activity(), [target()], [ACHIEVEMENT]);
      const other = await h.store.record(
        activity({ guildId: OTHER_GUILD }),
        [target()],
        [ACHIEVEMENT],
      );
      expect(other.fresh).toBe(true);
      expect(progressOf(other)).toBe(1);

      await h.store.unlock(unlockInput());
      await h.store.resetAchievement({
        guildId: OTHER_GUILD,
        achievementId: ACHIEVEMENT,
        allowRewardsAgain: false,
        actorId: ACTOR,
        at: T0 + HOUR,
        audit: audit('reset-other', OTHER_GUILD),
      });

      const [mine] = await h.store.memberStates(GUILD, USER, [ACHIEVEMENT]);
      expect(mine?.generation).toBe(0);
      expect(mine?.unlocked).toEqual(['bronze']);
      expect(mine && requirementValue(mine, 'messages', 1)).toBe(1);

      const [theirs] = await h.store.memberStates(OTHER_GUILD, USER, [ACHIEVEMENT]);
      expect(theirs?.generation).toBe(1);
      expect(theirs && requirementValue(theirs, 'messages', 1)).toBe(0);
    });
  });

  describe(`${name}: unlocks and rewards`, () => {
    let h: StoreHarness;

    beforeEach(async () => {
      h = await setup();
    });

    test('concurrent unlocks of the same tier create it and its rewards once', async () => {
      const input = unlockInput({ rewards: [ROLE_REWARD] });
      const results = await Promise.all([h.store.unlock(input), h.store.unlock(input)]);

      expect(results.map((result) => result.stale)).toEqual([false, false]);
      expect(results.flatMap((result) => result.unlocks)).toHaveLength(1);
      expect(results.flatMap((result) => result.rewards)).toHaveLength(1);

      const again = await h.store.unlock(input);
      expect(again).toEqual({ stale: false, unlocks: [], rewards: [] });

      const [state] = await h.store.memberStates(GUILD, USER, [ACHIEVEMENT]);
      expect(state?.unlocked).toEqual(['bronze']);
    });

    test('an unlock returns the created rows with their snapshot', async () => {
      const result = await h.store.unlock(
        unlockInput({ tiers: ['silver', 'bronze'], rewards: [ROLE_REWARD, XP_REWARD] }),
      );

      expect(result.unlocks.map((row) => row.tierId).sort()).toEqual(['bronze', 'silver']);
      expect(result.unlocks[0]).toMatchObject({
        guildId: GUILD,
        userId: USER,
        achievementId: ACHIEVEMENT,
        generation: 0,
        unlockedAt: T0,
        revision: 'revision-1',
        definition: definition([ROLE_REWARD, XP_REWARD]),
        progress: { messages: 10 },
        cause: { metric: 'messages', occurredAt: T0, sourceModule: 'discord', depth: 0 },
        originChannelId: CHANNEL,
        announceGroup: 'group-1',
        announceStatus: 'pending',
        announceAttempts: 0,
        publishedAt: null,
        voidedAt: null,
      });
      expect(result.rewards.map((row) => `${row.tierId}:${row.rewardKey}`).sort()).toEqual([
        `bronze:add_role:${ROLE}`,
        'bronze:xp',
        `silver:add_role:${ROLE}`,
        'silver:xp',
      ]);
      expect(result.rewards.find((row) => row.kind === 'xp')).toMatchObject({
        status: 'pending',
        amount: 250,
        roleId: null,
        rewardEpoch: 0,
        attempts: 0,
        createdAt: T0,
      });
    });

    test('an unlock read under an older generation or epoch creates nothing', async () => {
      await h.store.resetMember({
        guildId: GUILD,
        achievementIds: [ACHIEVEMENT],
        userId: USER,
        allowRewardsAgain: false,
        actorId: ACTOR,
        at: T0,
        audit: audit('reset-member-3'),
      });

      expect(await h.store.unlock(unlockInput({ generation: 0 }))).toEqual({
        stale: true,
        unlocks: [],
        rewards: [],
      });
      expect((await h.store.unlock(unlockInput({ generation: 1, rewardEpoch: 1 }))).stale).toBe(
        true,
      );

      const current = await h.store.unlock(unlockInput({ generation: 1 }));
      expect(current.stale).toBe(false);
      expect(current.unlocks).toHaveLength(1);
    });

    test('a reward given before a reset is not given again in the same epoch', async () => {
      const first = await h.store.unlock(unlockInput({ rewards: [XP_REWARD] }));
      const reward = first.rewards[0] as RewardRow;
      const claim = await h.store.claimReward(refOf(reward), T0, MINUTE);
      expect(claim?.row.status).toBe('requested');

      const grant = xpGrantId(GUILD, USER, ACHIEVEMENT, 'bronze', 0);
      await h.store.confirmXpGrant(GUILD, grant, { granted: true, now: T0 + 1000 });

      await h.store.resetMember({
        guildId: GUILD,
        achievementIds: [ACHIEVEMENT],
        userId: USER,
        allowRewardsAgain: false,
        actorId: ACTOR,
        at: T0 + HOUR,
        audit: audit('reset-member-4'),
      });

      const second = await h.store.unlock(
        unlockInput({ generation: 1, rewards: [XP_REWARD], group: 'group-2' }),
      );
      expect(second.rewards[0]).toMatchObject({
        status: 'skipped',
        error: ALREADY_GIVEN,
        generation: 1,
        rewardEpoch: 0,
      });

      await h.store.resetMember({
        guildId: GUILD,
        achievementIds: [ACHIEVEMENT],
        userId: USER,
        allowRewardsAgain: true,
        actorId: ACTOR,
        at: T0 + 2 * HOUR,
        audit: audit('reset-member-5'),
      });

      const third = await h.store.unlock(
        unlockInput({ generation: 2, rewardEpoch: 1, rewards: [XP_REWARD], group: 'group-3' }),
      );
      expect(third.rewards[0]).toMatchObject({ status: 'pending', rewardEpoch: 1, error: null });
    });

    test('a reward still in flight at a reset counts as given when the tier is earned again', async () => {
      const first = await h.store.unlock(unlockInput({ rewards: [XP_REWARD] }));
      await h.store.claimReward(refOf(first.rewards[0] as RewardRow), T0, MINUTE);

      await h.store.resetMember({
        guildId: GUILD,
        achievementIds: [ACHIEVEMENT],
        userId: USER,
        allowRewardsAgain: false,
        actorId: ACTOR,
        at: T0 + HOUR,
        audit: audit('reset-member-6'),
      });

      const [inFlight] = await h.store.rewardsFor(GUILD, USER, ACHIEVEMENT, 0);
      expect(inFlight?.status).toBe('requested');

      const again = await h.store.unlock(
        unlockInput({ generation: 1, rewards: [XP_REWARD], group: 'group-2' }),
      );
      expect(again.rewards[0]?.status).toBe('skipped');

      const confirmed = await h.store.confirmXpGrant(
        GUILD,
        xpGrantId(GUILD, USER, ACHIEVEMENT, 'bronze', 0),
        { granted: true, now: T0 + 2 * HOUR },
      );
      expect(confirmed).toMatchObject({ status: 'delivered', generation: 0 });
    });

    test('one claim wins, and a finish is fenced by the claim token', async () => {
      const { rewards } = await h.store.unlock(unlockInput({ rewards: [ROLE_REWARD] }));
      const ref = refOf(rewards[0] as RewardRow);

      const claims = await Promise.all([
        h.store.claimReward(ref, T0, MINUTE),
        h.store.claimReward(ref, T0, MINUTE),
      ]);
      const won = claims.filter((claim) => claim !== null);
      expect(won).toHaveLength(1);
      expect(won[0]?.token).toBe(1);
      expect(won[0]?.row).toMatchObject({
        status: 'delivering',
        attempts: 1,
        leaseUntil: T0 + MINUTE,
        requestedAt: null,
      });

      expect(await h.store.claimReward(ref, T0 + 30_000, MINUTE)).toBeNull();

      const retaken = await h.store.claimReward(ref, T0 + MINUTE, MINUTE);
      expect(retaken?.token).toBe(2);

      expect(await h.store.finishReward(ref, 1, { status: 'delivered', now: T0 + 61_000 })).toBe(
        false,
      );
      expect(await h.store.finishReward(ref, 2, { status: 'delivered', now: T0 + 61_000 })).toBe(
        true,
      );
      expect(await h.store.finishReward(ref, 2, { status: 'failed', now: T0 + 62_000 })).toBe(
        false,
      );

      const [row] = await h.store.rewardsFor(GUILD, USER, ACHIEVEMENT, 0);
      expect(row).toMatchObject({
        status: 'delivered',
        deliveredAt: T0 + 61_000,
        leaseUntil: null,
        attempts: 2,
      });
      expect(await h.store.claimReward(ref, T0 + 10 * MINUTE, MINUTE)).toBeNull();
    });

    test('transient failures wait for their retry time, and the last attempt is final', async () => {
      const { rewards } = await h.store.unlock(unlockInput({ rewards: [ROLE_REWARD] }));
      const ref = refOf(rewards[0] as RewardRow);
      let now = T0;

      for (let attempt = 1; attempt <= 5; attempt += 1) {
        const claim = await h.store.claimReward(ref, now, MINUTE);
        expect(claim?.token).toBe(attempt);
        await h.store.finishReward(ref, attempt, {
          status: 'failed',
          transient: true,
          errorCode: 'transport_failure',
          error: 'Discord didn’t answer.',
          nextAttemptAt: now + 30_000,
          now: now + 1,
        });

        if (attempt < 5) {
          expect(await h.store.claimReward(ref, now + 10_000, MINUTE)).toBeNull();
          now += 30_000;
        }
      }

      const [row] = await h.store.rewardsFor(GUILD, USER, ACHIEVEMENT, 0);
      expect(row).toMatchObject({
        status: 'failed',
        transient: false,
        nextAttemptAt: null,
        errorCode: 'transport_failure',
        attempts: 5,
      });
      expect(await h.store.claimReward(ref, now + DAY, MINUTE)).toBeNull();

      const manual = await h.store.claimReward(ref, now + DAY, MINUTE, { manual: true });
      expect(manual?.token).toBe(6);
      expect(manual?.row).toMatchObject({ status: 'delivering', error: null, errorCode: null });
    });

    test('an XP grant confirmed after a reset cancelled its row is recorded as delivered', async () => {
      const { rewards } = await h.store.unlock(unlockInput({ rewards: [XP_REWARD] }));
      const ref = refOf(rewards[0] as RewardRow);
      const claim = await h.store.claimReward(ref, T0, MINUTE);
      expect(claim?.row).toMatchObject({
        status: 'requested',
        requestedAt: T0,
        leaseUntil: T0 + XP_CONFIRM_TIMEOUT_MS,
      });

      await h.store.finishReward(ref, 1, {
        status: 'failed',
        transient: true,
        errorCode: 'publish_failed',
        nextAttemptAt: T0 + 30_000,
        now: T0 + 1,
      });

      await h.store.resetMember({
        guildId: GUILD,
        achievementIds: [ACHIEVEMENT],
        userId: USER,
        allowRewardsAgain: false,
        actorId: ACTOR,
        at: T0 + HOUR,
        audit: audit('reset-member-7'),
      });

      const [cancelled] = await h.store.rewardsFor(GUILD, USER, ACHIEVEMENT, 0);
      expect(cancelled).toMatchObject({ status: 'cancelled', error: CANCELLED_BY_RESET });

      const confirmed = await h.store.confirmXpGrant(
        GUILD,
        xpGrantId(GUILD, USER, ACHIEVEMENT, 'bronze', 0),
        { granted: true, now: T0 + 2 * HOUR },
      );
      expect(confirmed).toMatchObject({
        status: 'delivered',
        deliveredAt: T0 + 2 * HOUR,
        error: null,
      });

      const again = await h.store.unlock(
        unlockInput({ generation: 1, rewards: [XP_REWARD], group: 'group-2' }),
      );
      expect(again.rewards[0]?.status).toBe('skipped');
    });

    test('a refused grant fails its row with the reason, and unknown grants change nothing', async () => {
      const { rewards } = await h.store.unlock(unlockInput({ rewards: [XP_REWARD] }));
      await h.store.claimReward(refOf(rewards[0] as RewardRow), T0, MINUTE);

      const refused = await h.store.confirmXpGrant(
        GUILD,
        xpGrantId(GUILD, USER, ACHIEVEMENT, 'bronze', 0),
        { granted: false, error: 'Leveling is off in this server.', now: T0 + 1000 },
      );
      expect(refused).toMatchObject({
        status: 'failed',
        transient: false,
        error: 'Leveling is off in this server.',
      });

      expect(
        await h.store.confirmXpGrant(GUILD, xpGrantId(GUILD, USER, 'nothing', 'bronze', 0), {
          granted: true,
          now: T0,
        }),
      ).toBeNull();
      expect(
        await h.store.confirmXpGrant(GUILD, 'not-a-grant', { granted: true, now: T0 }),
      ).toBeNull();
    });
  });

  describe(`${name}: sweeps and announcements`, () => {
    let h: StoreHarness;

    beforeEach(async () => {
      h = await setup();
    });

    test('due work names what to do now and when to look again', async () => {
      const { rewards } = await h.store.unlock(unlockInput({ rewards: [ROLE_REWARD] }));
      const ref = refOf(rewards[0] as RewardRow);

      let due = await h.store.dueWork(GUILD, T0 + 1000, 10);
      expect(due.rewards.map((row) => row.rewardKey)).toEqual([`add_role:${ROLE}`]);
      expect(due.groups).toEqual([]);
      expect(due.unpublished).toHaveLength(1);
      expect(due.nextDueAt).toBe(T0);

      await h.store.markPublished(due.unpublished, T0 + 1000);
      await h.store.claimReward(ref, T0 + 1000, MINUTE);

      due = await h.store.dueWork(GUILD, T0 + 2000, 10);
      expect(due).toEqual({ rewards: [], groups: [], unpublished: [], nextDueAt: T0 + 61_000 });

      await h.store.finishReward(ref, 1, { status: 'delivered', now: T0 + 3000 });

      due = await h.store.dueWork(GUILD, T0 + 4000, 10);
      expect(due.groups).toEqual([
        {
          group: 'group-1',
          userId: USER,
          achievementId: ACHIEVEMENT,
          generation: 0,
          oldestUnlockedAt: T0,
          attempts: 0,
          rewardsSettled: true,
        },
      ]);
      expect(due.nextDueAt).toBe(T0);

      const claim = await h.store.claimAnnouncement(GUILD, 'group-1', T0 + 4000, MINUTE);
      due = await h.store.dueWork(GUILD, T0 + 5000, 10);
      expect(due.groups).toEqual([]);
      expect(due.nextDueAt).toBe(T0 + 64_000);

      await h.store.finishAnnouncement(GUILD, 'group-1', claim?.attempt ?? 0, {
        status: 'sent',
        messageId: MESSAGE,
        now: T0 + 6000,
      });

      expect(await h.store.dueWork(GUILD, T0 + 7000, 10)).toEqual({
        rewards: [],
        groups: [],
        unpublished: [],
        nextDueAt: null,
      });
    });

    test('a group waiting on XP is announced once the confirmation window has passed', async () => {
      const { rewards } = await h.store.unlock(unlockInput({ rewards: [XP_REWARD] }));
      await h.store.claimReward(refOf(rewards[0] as RewardRow), T0, MINUTE);

      const early = await h.store.dueWork(GUILD, T0 + MINUTE, 10);
      expect(early.groups).toEqual([]);
      expect(early.rewards).toEqual([]);
      expect(early.nextDueAt).toBe(T0);

      await h.store.markPublished(early.unpublished, T0 + MINUTE);
      expect((await h.store.dueWork(GUILD, T0 + MINUTE, 0)).nextDueAt).toBe(
        T0 + XP_CONFIRM_TIMEOUT_MS,
      );

      const late = await h.store.dueWork(GUILD, T0 + XP_CONFIRM_TIMEOUT_MS, 10);
      expect(late.groups.map((group) => [group.group, group.rewardsSettled])).toEqual([
        ['group-1', false],
      ]);
      expect(late.rewards.map((row) => row.status)).toEqual(['requested']);
    });

    test('an announcement group is leased to one claimer and fenced by its attempt', async () => {
      await h.store.unlock(unlockInput({ tiers: ['bronze', 'silver'] }));

      const claims = await Promise.all([
        h.store.claimAnnouncement(GUILD, 'group-1', T0, MINUTE),
        h.store.claimAnnouncement(GUILD, 'group-1', T0, MINUTE),
      ]);
      const won = claims.filter((claim) => claim !== null);
      expect(won).toHaveLength(1);
      expect(won[0]?.attempt).toBe(1);
      expect(won[0]?.rows.map((row) => row.tierId)).toEqual(['bronze', 'silver']);

      expect(await h.store.claimAnnouncement(GUILD, 'group-1', T0 + 30_000, MINUTE)).toBeNull();
      const second = await h.store.claimAnnouncement(GUILD, 'group-1', T0 + MINUTE + 1, MINUTE);
      expect(second?.attempt).toBe(2);

      await h.store.finishAnnouncement(GUILD, 'group-1', 1, { status: 'sent', now: T0 });
      await h.store.finishAnnouncement(GUILD, 'group-1', 2, {
        status: 'pending',
        error: 'Discord was busy.',
        now: T0 + MINUTE + 2,
      });

      const third = await h.store.claimAnnouncement(GUILD, 'group-1', T0 + MINUTE + 3, MINUTE);
      expect(third?.attempt).toBe(3);

      await h.store.finishAnnouncement(GUILD, 'group-1', 3, {
        status: 'sent',
        messageId: MESSAGE,
        now: T0 + 2 * MINUTE,
      });

      const rows = await h.store.unlocksOf(GUILD, USER);
      expect(rows.map((row) => [row.announceStatus, row.announceAttempts])).toEqual([
        ['sent', 3],
        ['sent', 3],
      ]);
      expect(rows[0]).toMatchObject({
        announceMessageId: MESSAGE,
        announcedAt: T0 + 2 * MINUTE,
        announceError: null,
        announceLeaseUntil: null,
      });
      expect(await h.store.claimAnnouncement(GUILD, 'group-1', T0 + DAY, MINUTE)).toBeNull();

      await h.store.unlock(
        unlockInput({ achievementId: 'voice-regular', group: 'group-q', announce: 'suppressed' }),
      );
      expect(await h.store.claimAnnouncement(GUILD, 'group-q', T0, MINUTE)).toBeNull();
    });

    test('an almost-there reminder is claimed once per tier, after its cooldown, never once earned', async () => {
      const claim = (tier: TierId, generation: number, now: number) =>
        h.store.claimAlmostThere(GUILD, USER, ACHIEVEMENT, tier, generation, now, DAY);

      expect(await claim('bronze', 0, T0)).toBe(true);
      expect(await claim('bronze', 0, T0 + 2 * DAY)).toBe(false);
      expect(await claim('silver', 0, T0 + HOUR)).toBe(false);
      expect(await claim('silver', 1, T0 + 2 * DAY)).toBe(false);

      await h.store.unlock(unlockInput({ tiers: ['silver'] }));
      expect(await claim('silver', 0, T0 + 2 * DAY)).toBe(false);
      expect(await claim('gold', 0, T0 + 2 * DAY)).toBe(true);

      let [state] = await h.store.memberStates(GUILD, USER, [ACHIEVEMENT]);
      expect(state?.almostNotified).toEqual(['bronze', 'gold']);
      expect(state?.almostNotifiedAt).toBe(T0 + 2 * DAY);

      await h.store.resetMember({
        guildId: GUILD,
        achievementIds: [ACHIEVEMENT],
        userId: USER,
        allowRewardsAgain: false,
        actorId: ACTOR,
        at: T0 + 3 * DAY,
        audit: audit('reset-member-8'),
      });
      [state] = await h.store.memberStates(GUILD, USER, [ACHIEVEMENT]);
      expect(state?.almostNotified).toEqual([]);
      expect(await claim('bronze', 1, T0 + 3 * DAY)).toBe(true);
    });
  });

  describe(`${name}: periods and resets`, () => {
    let h: StoreHarness;

    beforeEach(async () => {
      h = await setup();
    });

    test('periods follow the stored module row and first activation is reported once', async () => {
      const on = { enabled: true, achievements: [CHATTERBOX] };
      await h.setModule(GUILD, true, on);

      expect(await h.store.syncPeriods(GUILD, T0)).toEqual({
        firstActivation: [ACHIEVEMENT],
        reopened: [],
      });
      let runtime = await h.store.runtime(GUILD);
      expect(runtime.modulePeriods).toEqual([{ start: T0, end: null }]);
      expect(runtime.periods.get(ACHIEVEMENT)).toEqual([{ start: T0, end: null }]);
      expect(runtime.state.get(ACHIEVEMENT)).toEqual({
        generation: 0,
        rewardEpoch: 0,
        countedFrom: null,
        firstActiveAt: T0,
        rebuiltWith: rebuildSignature(achievementSchema.parse(CHATTERBOX)),
      });

      expect(await h.store.syncPeriods(GUILD, T0 + HOUR)).toEqual({
        firstActivation: [],
        reopened: [],
      });

      await h.setModule(GUILD, true, { ...on, enabled: false });
      await h.store.syncPeriods(GUILD, T0 + 2 * HOUR);
      runtime = await h.store.runtime(GUILD);
      expect(runtime.modulePeriods).toEqual([{ start: T0, end: T0 + 2 * HOUR }]);
      expect(runtime.periods.get(ACHIEVEMENT)).toEqual([{ start: T0, end: T0 + 2 * HOUR }]);

      await h.setModule(GUILD, true, on);
      expect(await h.store.syncPeriods(GUILD, T0 + 3 * HOUR)).toEqual({
        firstActivation: [],
        reopened: [ACHIEVEMENT],
      });
      expect((await h.store.runtime(GUILD)).periods.get(ACHIEVEMENT)).toEqual([
        { start: T0, end: T0 + 2 * HOUR },
        { start: T0 + 3 * HOUR, end: null },
      ]);

      await h.setModule(GUILD, false, on);
      await h.store.syncPeriods(GUILD, T0 + 4 * HOUR, { openOnly: true });
      expect((await h.store.runtime(GUILD)).periods.get(ACHIEVEMENT)?.at(-1)).toEqual({
        start: T0 + 3 * HOUR,
        end: null,
      });

      await h.store.syncPeriods(GUILD, T0 + 4 * HOUR);
      expect((await h.store.runtime(GUILD)).periods.get(ACHIEVEMENT)?.at(-1)).toEqual({
        start: T0 + 3 * HOUR,
        end: T0 + 4 * HOUR,
      });

      await h.setModule(GUILD, true, {
        enabled: true,
        achievements: [{ ...CHATTERBOX, status: 'paused' }],
      });
      await h.store.syncPeriods(GUILD, T0 + 5 * HOUR);
      runtime = await h.store.runtime(GUILD);
      expect(runtime.modulePeriods.at(-1)).toEqual({ start: T0 + 5 * HOUR, end: null });
      expect(runtime.periods.get(ACHIEVEMENT)?.at(-1)).toEqual({
        start: T0 + 3 * HOUR,
        end: T0 + 4 * HOUR,
      });
    });

    test('resuming one achievement reopens that one only', async () => {
      const other = { ...CHATTERBOX, id: 'voice-regular', name: 'Voice Regular' };
      const both = { enabled: true, achievements: [CHATTERBOX, other] };
      await h.setModule(GUILD, true, both);

      expect(await h.store.syncPeriods(GUILD, T0)).toEqual({
        firstActivation: [ACHIEVEMENT, other.id],
        reopened: [],
      });

      await h.setModule(GUILD, true, {
        enabled: true,
        achievements: [{ ...CHATTERBOX, status: 'paused' }, other],
      });
      expect(await h.store.syncPeriods(GUILD, T0 + HOUR)).toEqual({
        firstActivation: [],
        reopened: [],
      });

      await h.setModule(GUILD, true, both);
      expect(await h.store.syncPeriods(GUILD, T0 + 2 * HOUR)).toEqual({
        firstActivation: [],
        reopened: [ACHIEVEMENT],
      });
    });

    test('a stored config Proton can’t read counts as off', async () => {
      await h.setModule(GUILD, true, { enabled: true, achievements: [CHATTERBOX] });
      await h.store.syncPeriods(GUILD, T0);

      await h.setModule(GUILD, true, { enabled: true, achievements: 'not a list' });
      expect(await h.store.syncPeriods(GUILD, T0 + HOUR)).toEqual({
        firstActivation: [],
        reopened: [],
      });
      expect((await h.store.runtime(GUILD)).modulePeriods).toEqual([{ start: T0, end: T0 + HOUR }]);
    });

    test('a member reset voids their unlocks, cancels only waiting rewards and happens once', async () => {
      const { rewards } = await h.store.unlock(unlockInput({ rewards: [ROLE_REWARD, XP_REWARD] }));
      const xp = rewards.find((row) => row.kind === 'xp') as RewardRow;
      await h.store.claimReward(refOf(xp), T0 + 1, MINUTE);

      const input = {
        guildId: GUILD,
        achievementIds: [ACHIEVEMENT],
        userId: USER,
        allowRewardsAgain: false,
        actorId: ACTOR,
        at: T0 + HOUR,
        audit: audit('reset-member-9'),
      };
      expect(await h.store.resetMember(input)).toEqual({ achievements: 1 });

      const detail = await h.store.memberDetail(GUILD, USER);
      expect(detail.unlocks).toEqual([]);
      expect(detail.voided).toHaveLength(1);
      expect(detail.voided[0]).toMatchObject({
        voidedAt: T0 + HOUR,
        voidedBy: ACTOR,
        announceStatus: 'skipped',
        announceError: RESET_BEFORE_ANNOUNCED,
      });
      expect(detail.rewards.map((row) => [row.kind, row.status])).toEqual([
        ['add_role', 'cancelled'],
        ['xp', 'requested'],
      ]);
      expect(detail.states[0]).toMatchObject({
        achievementId: ACHIEVEMENT,
        generation: 1,
        rewardEpoch: 0,
        countedFrom: T0 + HOUR,
        unlocked: [],
      });

      expect(await h.store.resetMember({ ...input, at: T0 + 2 * HOUR })).toEqual({
        achievements: 0,
      });
      expect((await h.store.memberStates(GUILD, USER, [ACHIEVEMENT]))[0]?.generation).toBe(1);
    });

    test('a reset cancels a permanently failed reward, so no retry can still give it', async () => {
      const { rewards } = await h.store.unlock(unlockInput({ rewards: [ROLE_REWARD] }));
      const ref = refOf(rewards[0] as RewardRow);

      await h.store.claimReward(ref, T0, MINUTE);
      await h.store.finishReward(ref, 1, {
        status: 'failed',
        errorCode: 'role_hierarchy',
        error: 'Proton sits below that role.',
        now: T0 + 1000,
      });
      expect((await h.store.rewardsFor(GUILD, USER, ACHIEVEMENT, 0))[0]).toMatchObject({
        status: 'failed',
        transient: false,
      });

      await h.store.resetMember({
        guildId: GUILD,
        achievementIds: [ACHIEVEMENT],
        userId: USER,
        allowRewardsAgain: false,
        actorId: ACTOR,
        at: T0 + HOUR,
        audit: audit('reset-member-11'),
      });

      expect((await h.store.rewardsFor(GUILD, USER, ACHIEVEMENT, 0))[0]).toMatchObject({
        status: 'cancelled',
        error: CANCELLED_BY_RESET,
      });
      expect(await h.store.claimReward(ref, T0 + 2 * HOUR, MINUTE, { manual: true })).toBeNull();
      expect(await h.store.rewardCounts(GUILD)).toEqual([
        { achievementId: ACHIEVEMENT, status: 'cancelled', count: 1 },
      ]);
    });

    test('an achievement reset moves every member on and voids every current unlock', async () => {
      await h.store.unlock(unlockInput());
      await h.store.record(activity({ userId: USER_2 }), [target()], [ACHIEVEMENT]);

      const input = {
        guildId: GUILD,
        achievementId: ACHIEVEMENT,
        allowRewardsAgain: true,
        actorId: ACTOR,
        at: T0 + HOUR,
        audit: audit('reset-achievement-1'),
      };
      expect(await h.store.resetAchievement(input)).toEqual({ members: 2 });

      const [mine] = await h.store.memberStates(GUILD, USER, [ACHIEVEMENT]);
      expect(mine).toMatchObject({ generation: 1, rewardEpoch: 1, unlocked: [] });
      expect(await h.store.unlocksOf(GUILD, USER)).toEqual([]);

      const [theirs] = await h.store.memberStates(GUILD, USER_2, [ACHIEVEMENT]);
      expect(theirs && requirementValue(theirs, 'messages', 1)).toBe(0);
      expect(theirs?.countedFrom).toBe(T0 + HOUR);

      expect(await h.store.resetAchievement({ ...input, at: T0 + 2 * HOUR })).toEqual({
        members: 0,
      });
      expect((await h.store.unlock(unlockInput({ generation: 0 }))).stale).toBe(true);
      expect(
        (await h.store.unlock(unlockInput({ generation: 1, rewardEpoch: 1, group: 'g2' }))).stale,
      ).toBe(false);
    });
  });

  describe(`${name}: rebuilding from recorded activity`, () => {
    let h: StoreHarness;

    beforeEach(async () => {
      h = await setup();

      const message = (sourceKey: string, occurredAt: number, channelId: string, userId = USER) =>
        h.store.record(
          activity({ sourceKey, occurredAt, channelId, userId }),
          [target()],
          [ACHIEVEMENT],
        );

      await message('m-1', T0 + 5 * MINUTE, CHANNEL);
      await message('m-2', T0 + HOUR + 5 * MINUTE, OTHER_CHANNEL);
      await message('m-3', T0 + 2 * HOUR + 5 * MINUTE, CHANNEL);
    });

    test('a preview counts what a rebuild would change and writes nothing', async () => {
      const preview = await h.store.rebuildSlice(
        GUILD,
        plan({
          requirements: [
            {
              ...plan().requirements[0],
              version: 2,
              excludedChannelIds: [OTHER_CHANNEL],
            } as RebuildPlan['requirements'][number],
          ],
        }),
        null,
        'preview',
      );

      expect(preview).toEqual({
        cursor: null,
        members: 1,
        changed: 1,
        lost: 0,
        newlyEarned: { single: 0, bronze: 1, silver: 0, gold: 0, diamond: 0 },
      });

      const [state] = await h.store.memberStates(GUILD, USER, [ACHIEVEMENT]);
      expect(state?.values.messages).toEqual({ value: 3, version: 1, generation: 0 });
    });

    test('a write stores the rebuilt value under the new version and remembers the plan', async () => {
      const rebuilt = await h.store.rebuildSlice(
        GUILD,
        plan({
          requirements: [
            {
              ...plan().requirements[0],
              version: 2,
              channelIds: [CATEGORY],
              excludedChannelIds: [OTHER_CHANNEL],
            } as RebuildPlan['requirements'][number],
          ],
        }),
        null,
        'write',
      );
      expect(rebuilt.changed).toBe(1);

      const [state] = await h.store.memberStates(GUILD, USER, [ACHIEVEMENT]);
      expect(state?.values.messages).toEqual({ value: 2, version: 2, generation: 0 });
      expect((await h.store.runtime(GUILD)).state.get(ACHIEVEMENT)?.rebuiltWith).toBe(
        'signature-1',
      );

      const live = await h.store.record(
        activity({ sourceKey: 'm-4', occurredAt: T0 + 3 * HOUR }),
        [target({ version: 2 })],
        [ACHIEVEMENT],
      );
      expect(progressOf(live, 'messages', 2)).toBe(3);
    });

    test('a narrowed window loses progress unless the plan keeps the higher value', async () => {
      const narrowed = plan({ windows: [{ start: T0 + HOUR, end: null }] });

      expect(await h.store.rebuildSlice(GUILD, narrowed, null, 'preview')).toMatchObject({
        changed: 1,
        lost: 1,
      });
      expect(
        await h.store.rebuildSlice(GUILD, { ...narrowed, keepHigher: true }, null, 'preview'),
      ).toMatchObject({ changed: 0, lost: 0 });

      await h.store.rebuildSlice(GUILD, narrowed, null, 'write');
      const [state] = await h.store.memberStates(GUILD, USER, [ACHIEVEMENT]);
      expect(state && requirementValue(state, 'messages', 1)).toBe(2);
    });

    test('closed windows end on the hour, and tiers already held are not counted as new', async () => {
      await h.store.unlock(unlockInput());

      const result = await h.store.rebuildSlice(
        GUILD,
        plan({ windows: [{ start: T0, end: T0 + 2 * HOUR }] }),
        null,
        'preview',
      );
      expect(result).toMatchObject({ lost: 1, newlyEarned: { bronze: 0, silver: 0 } });
    });

    test('each member is rebuilt from their own reset onwards, under their own generation', async () => {
      const second = (sourceKey: string, occurredAt: number) =>
        h.store.record(
          activity({ sourceKey, occurredAt, userId: USER_2 }),
          [target()],
          [ACHIEVEMENT],
        );
      await second('u2-1', T0 + 5 * MINUTE);
      await h.store.resetMember({
        guildId: GUILD,
        achievementIds: [ACHIEVEMENT],
        userId: USER_2,
        allowRewardsAgain: false,
        actorId: ACTOR,
        at: T0 + HOUR + 30 * MINUTE,
        audit: audit('reset-member-10'),
      });
      await second('u2-2', T0 + HOUR + 40 * MINUTE);
      await second('u2-3', T0 + 2 * HOUR + 5 * MINUTE);

      const result = await h.store.rebuildSlice(GUILD, plan(), null, 'write');
      expect(result.members).toBe(2);

      const [first] = await h.store.memberStates(GUILD, USER, [ACHIEVEMENT]);
      expect(first?.values.messages).toEqual({ value: 3, version: 1, generation: 0 });

      const [reset] = await h.store.memberStates(GUILD, USER_2, [ACHIEVEMENT]);
      expect(reset?.values.messages).toEqual({ value: 1, version: 1, generation: 1 });
    });

    test('buckets are filtered by temporary channels, XP sources and record aggregates', async () => {
      const record = (overrides: Partial<ActivityRecord>) =>
        h.store.record(activity(overrides), [], [ACHIEVEMENT]);

      await record({
        metric: 'voice_minutes',
        sourceKey: 'v-1',
        amount: 10,
        temporary: true,
        spanStart: T0,
      });
      await record({ metric: 'voice_minutes', sourceKey: 'v-2', amount: 7, spanStart: T0 });
      await record({ metric: 'activity_xp', sourceKey: 'x-1', amount: 20, xpSource: 'message' });
      await record({ metric: 'activity_xp', sourceKey: 'x-2', amount: 500, xpSource: 'reward' });
      await record({ metric: 'voice_stay', sourceKey: 's-1', amount: 30, spanStart: T0 });
      await record({
        metric: 'voice_stay',
        sourceKey: 's-2',
        amount: 45,
        spanStart: T0,
        occurredAt: T0 + HOUR,
      });

      const requirement = plan().requirements[0] as RebuildPlan['requirements'][number];
      const result = await h.store.rebuildSlice(
        GUILD,
        plan({
          requirements: [
            { ...requirement, requirementId: 'temp', metric: 'voice_minutes', temporaryOnly: true },
            { ...requirement, requirementId: 'voice', metric: 'voice_minutes' },
            { ...requirement, requirementId: 'xp', metric: 'activity_xp', xpSources: ['message'] },
            { ...requirement, requirementId: 'stay', metric: 'voice_stay', aggregate: 'max' },
          ],
          tiers: [{ tierId: 'single', targets: { temp: 10, voice: 17, xp: 20, stay: 45 } }],
        }),
        null,
        'write',
      );
      expect(result.newlyEarned.single).toBe(1);

      const [state] = await h.store.memberStates(GUILD, USER, [ACHIEVEMENT]);
      expect(
        Object.fromEntries(
          ['temp', 'voice', 'xp', 'stay'].map((id) => [id, state?.values[id]?.value]),
        ),
      ).toEqual({ temp: 10, voice: 17, xp: 20, stay: 45 });
    });

    test('a stay that began before the window rebuilds to the minutes inside it', async () => {
      const stay = (sourceKey: string, occurredAt: number, amount: number) =>
        h.store.record(
          activity({
            metric: 'voice_stay',
            sourceKey,
            occurredAt,
            amount,
            spanStart: T0 - 4 * HOUR,
          }),
          [],
          [ACHIEVEMENT],
        );

      await stay('s-1', T0 - 10 * MINUTE, 230);
      await stay('s-2', T0 + 50 * MINUTE, 290);
      await stay('s-3', T0 + HOUR, 300);

      const requirement = plan().requirements[0] as RebuildPlan['requirements'][number];
      const rebuild = plan({
        requirements: [
          { ...requirement, requirementId: 'stay', metric: 'voice_stay', aggregate: 'max' },
        ],
        tiers: [{ tierId: 'single', targets: { stay: 180 } }],
      });

      expect(await h.store.rebuildSlice(GUILD, rebuild, null, 'write')).toMatchObject({
        newlyEarned: { single: 0 },
      });

      const [state] = await h.store.memberStates(GUILD, USER, [ACHIEVEMENT]);
      expect(state?.values.stay?.value).toBe(60);
    });

    test('state requirements count toward new tiers with their stored values', async () => {
      await h.store.setValues(GUILD, USER, [
        { achievementId: ACHIEVEMENT, requirementId: 'level', version: 1, value: 4 },
      ]);

      const withLevel = (level: number) =>
        plan({
          stateRequirements: [{ requirementId: 'level', version: 1 }],
          tiers: [{ tierId: 'single', targets: { messages: 3, level } }],
        });

      const earned = async (level: number) =>
        (await h.store.rebuildSlice(GUILD, withLevel(level), null, 'preview')).newlyEarned.single;

      expect(await earned(5)).toBe(0);
      expect(await earned(4)).toBe(1);
    });
  });

  describe(`${name}: members, badges, jobs and reads`, () => {
    let h: StoreHarness;

    beforeEach(async () => {
      h = await setup();
    });

    test('facts patch only the fields given, and anniversaries page by join date', async () => {
      await h.store.upsertFacts(GUILD, USER, { joinedAt: T0 - 400 * DAY, premiumSince: null });
      await h.store.upsertFacts(GUILD, USER, { premiumSince: T0 });
      expect(await h.store.facts(GUILD, USER)).toMatchObject({
        userId: USER,
        joinedAt: T0 - 400 * DAY,
        premiumSince: T0,
        leftAt: null,
      });
      expect(await h.store.facts(OTHER_GUILD, USER)).toBeNull();

      await h.store.upsertFacts(GUILD, USER_2, { joinedAt: T0 - 365 * DAY });
      await h.store.upsertFacts(GUILD, USER_3, { joinedAt: T0 - 365 * DAY + HOUR });

      const window = [{ targetDays: 365, from: T0 - 366 * DAY, to: T0 - 365 * DAY + HOUR }];
      expect(
        (await h.store.anniversaryCandidates(GUILD, window, null, 10)).map((f) => f.userId),
      ).toEqual([USER_2, USER_3]);
      expect(
        (await h.store.anniversaryCandidates(GUILD, window, USER_2, 10)).map((f) => f.userId),
      ).toEqual([USER_3]);

      await h.store.upsertFacts(GUILD, USER_2, { leftAt: T0, joinedAt: null });
      expect(
        (await h.store.anniversaryCandidates(GUILD, window, null, 10)).map((f) => f.userId),
      ).toEqual([USER_3]);

      expect(await h.store.anniversaryRunAt(GUILD)).toBeNull();
      await h.store.setAnniversaryRunAt(GUILD, T0);
      await h.store.setAnniversaryRunAt(GUILD, T0 + DAY);
      expect(await h.store.anniversaryRunAt(GUILD)).toBe(T0 + DAY);
      expect(await h.store.jobs(GUILD)).toEqual([]);
    });

    test('badges upload idempotently and prune only what is unused and old', async () => {
      const asset = {
        assetId: 'abcd1234',
        contentType: 'image/png',
        base64: 'AA==',
        byteSize: 1,
        uploadedBy: ACTOR,
        uploadedAt: T0,
      };
      await h.store.putBadge(GUILD, asset);
      await h.store.putBadge(GUILD, { ...asset, uploadedAt: T0 + DAY });
      await h.store.putBadge(GUILD, { ...asset, assetId: 'efgh5678' });

      expect(await h.store.badge(GUILD, 'abcd1234')).toEqual({
        contentType: 'image/png',
        base64: 'AA==',
      });
      expect(await h.store.badge(OTHER_GUILD, 'abcd1234')).toBeNull();

      expect(await h.store.pruneBadges(GUILD, [], T0)).toBe(0);
      expect(await h.store.pruneBadges(GUILD, ['efgh5678'], T0 + 2 * DAY)).toBe(1);
      expect(await h.store.badge(GUILD, 'abcd1234')).toBeNull();
      expect(await h.store.badge(GUILD, 'efgh5678')).not.toBeNull();
    });

    test('jobs keep what each patch leaves out', async () => {
      expect(await h.store.job(GUILD, ACHIEVEMENT)).toBeNull();

      await h.store.setJob(GUILD, ACHIEVEMENT, {
        job: 'rebuild_preview',
        status: 'queued',
        cursor: null,
        requestedAt: T0,
        requestedBy: ACTOR,
        finishedAt: null,
        result: null,
        announce: false,
        acceptLoss: true,
      });
      await h.store.setJob(GUILD, ACHIEVEMENT, {
        status: 'done',
        finishedAt: T0 + HOUR,
        result: {
          members: 3,
          changed: 1,
          lost: 0,
          newlyEarned: { single: 0, bronze: 1, silver: 0, gold: 0, diamond: 0 },
        },
      });

      const expected: JobState = {
        achievementId: ACHIEVEMENT,
        job: 'rebuild_preview',
        status: 'done',
        cursor: null,
        requestedAt: T0,
        requestedBy: ACTOR,
        finishedAt: T0 + HOUR,
        result: {
          members: 3,
          changed: 1,
          lost: 0,
          newlyEarned: { single: 0, bronze: 1, silver: 0, gold: 0, diamond: 0 },
        },
        announce: false,
        acceptLoss: true,
      };
      expect(await h.store.job(GUILD, ACHIEVEMENT)).toEqual(expected);
      expect(await h.store.jobs(GUILD)).toEqual([expected]);
    });

    test('re-checks page members with progress and, when asked, prerequisite holders', async () => {
      await h.store.record(activity(), [target()], [ACHIEVEMENT]);
      await h.store.unlock(unlockInput({ userId: USER_2, achievementId: 'starter' }));
      await h.store.unlock(unlockInput({ userId: USER_3, achievementId: 'other', group: 'g3' }));

      const page = (
        opts?: { unlockedIn?: readonly string[] | 'any' },
        cursor: string | null = null,
        limit = 10,
      ) => h.store.membersForRecheck(GUILD, ACHIEVEMENT, cursor, limit, opts);

      expect(await page()).toEqual({ userIds: [USER], cursor: null });
      expect((await page({ unlockedIn: ['starter'] })).userIds).toEqual([USER, USER_2]);
      expect(await page({ unlockedIn: 'any' }, null, 2)).toEqual({
        userIds: [USER, USER_2],
        cursor: USER_2,
      });
      expect(await page({ unlockedIn: 'any' }, USER_2, 2)).toEqual({
        userIds: [USER_3],
        cursor: null,
      });
    });

    test('reads report current unlocks, holders, progress and rewards', async () => {
      await h.store.unlock(
        unlockInput({ tiers: ['bronze', 'silver'], rewards: [ROLE_REWARD], unlockedAt: T0 }),
      );
      await h.store.unlock(
        unlockInput({
          achievementId: 'server-supporter',
          tiers: ['single'],
          group: 'group-2',
          unlockedAt: T0 + HOUR,
        }),
      );
      await h.store.unlock(
        unlockInput({ userId: USER_2, group: 'group-3', unlockedAt: T0 + 2 * HOUR }),
      );
      await h.store.record(activity({ userId: USER_3 }), [target()], [ACHIEVEMENT]);

      const named = (rows: readonly { achievementId: string; tierId: string }[]) =>
        rows.map((row) => `${row.achievementId}:${row.tierId}`);

      expect(named(await h.store.unlocksOf(GUILD, USER))).toEqual([
        `${ACHIEVEMENT}:bronze`,
        `${ACHIEVEMENT}:silver`,
        'server-supporter:single',
      ]);
      expect(await h.store.earnedCount(GUILD, USER, [])).toBe(2);
      expect(await h.store.earnedCount(GUILD, USER, [ACHIEVEMENT])).toBe(1);
      expect(named(await h.store.topBadges(GUILD, USER, 6))).toEqual([
        `${ACHIEVEMENT}:silver`,
        'server-supporter:single',
      ]);

      expect(await h.store.holders(GUILD)).toEqual([
        { achievementId: ACHIEVEMENT, tierId: 'bronze', members: 2 },
        { achievementId: ACHIEVEMENT, tierId: 'silver', members: 1 },
        { achievementId: 'server-supporter', tierId: 'single', members: 1 },
      ]);
      expect(await h.store.inProgress(GUILD)).toEqual([{ achievementId: ACHIEVEMENT, members: 1 }]);
      expect(await h.store.rewardCounts(GUILD)).toEqual([
        { achievementId: ACHIEVEMENT, status: 'pending', count: 2 },
      ]);

      const firstPage = await h.store.listUnlocks(GUILD, { page: 1, pageSize: 2 });
      expect(firstPage.total).toBe(4);
      expect(firstPage.items.map((row) => row.userId)).toEqual([USER_2, USER]);
      const supporters = await h.store.listUnlocks(GUILD, {
        achievementId: 'server-supporter',
        page: 1,
        pageSize: 25,
      });
      expect(supporters.total).toBe(1);

      const rewards = (status: 'pending' | 'failed') =>
        h.store.listRewards(GUILD, { status, page: 1, pageSize: 25 });
      expect((await rewards('pending')).total).toBe(2);
      expect((await rewards('failed')).total).toBe(0);

      const detail = await h.store.memberDetail(GUILD, USER);
      expect(detail.states.map((state) => state.achievementId)).toEqual([
        ACHIEVEMENT,
        'server-supporter',
      ]);
      expect(detail.unlocks).toHaveLength(3);
      expect(detail.voided).toEqual([]);
      expect(detail.rewards).toHaveLength(2);
      expect(detail.facts).toBeNull();
    });

    test('purge keeps what each retention rule keeps', async () => {
      const now = Date.now();
      const seen = (metric: ActivityRecord['metric'], sourceKey: string, occurredAt = now) =>
        h.store.record(activity({ metric, sourceKey, occurredAt }), [], [ACHIEVEMENT]);

      await seen('messages', 'old', now - 400 * DAY);
      await seen('messages', 'new');
      await seen('reactions_given', 'reaction');
      await seen('starboard_messages', 'starred');
      await h.store.upsertFacts(GUILD, USER, { joinedAt: now - DAY, leftAt: now - 31 * DAY });
      await h.store.upsertFacts(GUILD, USER_2, { joinedAt: now - DAY });
      await h.store.upsertFacts(GUILD, USER_3, { joinedAt: now - 400 * DAY });

      expect(await h.store.purge(now + 3 * DAY)).toEqual({ activity: 1, seen: 2, facts: 1 });
      expect(await h.store.purge(now + 9 * DAY)).toEqual({ activity: 0, seen: 1, facts: 0 });

      expect((await h.store.purge(now + 400 * DAY)).facts).toBe(0);
      expect(await h.store.facts(GUILD, USER_3)).not.toBeNull();
      expect(
        (
          await h.store.anniversaryCandidates(
            GUILD,
            [{ targetDays: 400, from: now - 401 * DAY, to: now - 399 * DAY }],
            null,
            10,
          )
        ).map((facts) => facts.userId),
      ).toEqual([USER_3]);

      expect((await seen('starboard_messages', 'starred')).fresh).toBe(false);
      expect((await seen('messages', 'new')).fresh).toBe(true);
      expect(await h.store.facts(GUILD, USER)).toBeNull();
      expect(await h.store.facts(GUILD, USER_2)).not.toBeNull();
    });
  });
}

export interface VoiceHarness {
  voice: AchievementVoiceStore;
  locks: FencedLocks;
  limits: AchievementLimits;
}

function session(overrides: Partial<AchievementVoiceSession> = {}): AchievementVoiceSession {
  const now = Date.now();
  return {
    channelId: CHANNEL,
    joinedAt: now,
    startedAt: now,
    lastEventAt: now,
    temporary: false,
    ...overrides,
  };
}

export function describeVoiceStore(name: string, setup: () => Promise<VoiceHarness>): void {
  describe(`${name}: voice sessions`, () => {
    let h: VoiceHarness;

    beforeEach(async () => {
      h = await setup();
    });

    test('a session opens once and is listed for its server only', async () => {
      const opened = session({ temporary: true });

      expect(await h.voice.open(GUILD, USER, opened)).toBe(true);
      expect(await h.voice.open(GUILD, USER, session())).toBe(false);
      expect(await h.voice.get(GUILD, USER)).toEqual(opened);
      expect(await h.voice.list(GUILD)).toEqual([{ userId: USER, session: opened }]);
      expect(await h.voice.list(OTHER_GUILD)).toEqual([]);
      expect(await h.voice.get(OTHER_GUILD, USER)).toBeNull();
    });

    test('advancing checks the join time, and the last event time only moves forward', async () => {
      const opened = session();
      await h.voice.open(GUILD, USER, opened);

      const later = opened.lastEventAt + 5;

      expect(await h.voice.advance(GUILD, USER, opened.joinedAt - 1, { lastEventAt: later })).toBe(
        false,
      );
      expect(
        await h.voice.advance(GUILD, USER, opened.joinedAt, {
          joinedAt: opened.joinedAt + MINUTE,
          lastEventAt: later,
        }),
      ).toBe(true);
      expect(
        await h.voice.advance(GUILD, USER, opened.joinedAt + MINUTE, {
          lastEventAt: opened.lastEventAt,
        }),
      ).toBe(true);

      expect(await h.voice.get(GUILD, USER)).toEqual({
        ...opened,
        joinedAt: opened.joinedAt + MINUTE,
        lastEventAt: opened.lastEventAt + 5,
      });
    });

    test('closing checks the join time and leaves a tombstone that refuses older events', async () => {
      const opened = session();
      await h.voice.open(GUILD, USER, opened);

      const closedAt = opened.joinedAt + 10;
      const at = (instant: number) =>
        session({ joinedAt: instant, startedAt: instant, lastEventAt: instant });

      expect(await h.voice.close(GUILD, USER, opened.joinedAt + 1, closedAt)).toBe(false);
      expect(await h.voice.close(GUILD, USER, opened.joinedAt, closedAt)).toBe(true);
      expect(await h.voice.get(GUILD, USER)).toBeNull();
      expect(await h.voice.list(GUILD)).toEqual([]);
      expect(await h.voice.close(GUILD, USER, opened.joinedAt, closedAt)).toBe(false);

      expect(await h.voice.open(GUILD, USER, at(closedAt))).toBe(false);
      expect(await h.voice.open(GUILD, USER, at(closedAt + 1))).toBe(true);
    });

    test('marking a member gone refuses older joins and leaves an open session alone', async () => {
      const leftAt = Date.now();
      const at = (instant: number) =>
        session({ joinedAt: instant, startedAt: instant, lastEventAt: instant });

      expect(await h.voice.markLeft(GUILD, USER, leftAt)).toBe(true);
      expect(await h.voice.markLeft(GUILD, USER, leftAt - 5)).toBe(true);
      expect(await h.voice.open(GUILD, USER, at(leftAt))).toBe(false);
      expect(await h.voice.open(GUILD, USER, at(leftAt + 1))).toBe(true);
      expect(await h.voice.markLeft(GUILD, USER, leftAt + 2)).toBe(false);
      expect(await h.voice.get(GUILD, USER)).toEqual(at(leftAt + 1));
    });

    test('a session already past the 24-hour cap is never opened', async () => {
      const old = Date.now() - 25 * HOUR;
      const capped = session({ joinedAt: old, startedAt: old, lastEventAt: Date.now() });

      expect(await h.voice.open(GUILD, USER, capped)).toBe(false);
      expect(await h.voice.get(GUILD, USER)).toBeNull();
      expect(await h.voice.list(GUILD)).toEqual([]);
    });
  });

  describe(`${name}: locks and limits`, () => {
    let h: VoiceHarness;

    beforeEach(async () => {
      h = await setup();
    });

    test('a lock has one holder and only its token releases it', async () => {
      const token = await h.locks.acquire(`voice:${GUILD}:${USER}`, 30_000);
      expect(token).not.toBeNull();
      expect(await h.locks.acquire(`voice:${GUILD}:${USER}`, 30_000)).toBeNull();
      expect(await h.locks.acquire(`voice:${GUILD}:${USER_2}`, 30_000)).not.toBeNull();

      expect(await h.locks.release(`voice:${GUILD}:${USER}`, 'someone-else')).toBe(false);
      expect(await h.locks.release(`voice:${GUILD}:${USER}`, token ?? '')).toBe(true);
      expect(await h.locks.acquire(`voice:${GUILD}:${USER}`, 30_000)).not.toBeNull();
    });

    test('a claim lets the same value back in and refuses another; counts climb', async () => {
      const cooldown = `proton:achievements:msgcd:${GUILD}:${USER}`;

      expect(await h.limits.claim(cooldown, 'message-1', 15_000)).toBe(true);
      expect(await h.limits.claim(cooldown, 'message-1', 15_000)).toBe(true);
      expect(await h.limits.claim(cooldown, 'message-2', 15_000)).toBe(false);

      const cap = `proton:achievements:given:${GUILD}:${USER}:2026-09-01`;
      expect(await h.limits.count(cap, DAY)).toBe(1);
      expect(await h.limits.count(cap, DAY)).toBe(2);
      expect(await h.limits.count(`${cap}:other`, DAY)).toBe(1);
    });
  });
}
