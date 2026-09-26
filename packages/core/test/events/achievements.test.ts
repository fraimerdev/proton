import { describe, expect, test } from 'bun:test';
import {
  ACHIEVEMENT_RETRY_MAILBOX_PREFIX,
  achievementJobRequestedSchema,
  achievementRetryOutcomeSchema,
  achievementRewardRefSchema,
  achievementRewardRetryRequestedSchema,
  achievementUnlockedSchema,
  TIER_IDS,
} from '../../src/events/achievements.ts';
import { isEventType, SERVICE_EMITTED_EVENT_TYPES } from '../../src/events/types.ts';

const GUILD = '900000000000000001';
const USER = '100000000000000010';
const ACTOR = '100000000000000002';

const unlocked = {
  guildId: GUILD,
  userId: USER,
  achievementId: 'chatterbox',
  tierId: 'gold',
  generation: 0,
  unlockedAt: 1_800_000_000_000,
  final: false,
  originChannelId: '500000000000000001',
  causation: { kind: 'organic', rootId: 'message.created:1', depth: 0 },
} as const;

const ref = {
  userId: USER,
  achievementId: 'chatterbox',
  tierId: 'gold',
  generation: 1,
  rewardKey: 'add_role:100000000000000021',
} as const;

const retry = {
  requestId: '01J8Z0000000000000000000RQ',
  guildId: GUILD,
  actorId: ACTOR,
  rewards: [ref],
} as const;

const job = {
  requestId: '01J8Z0000000000000000000JB',
  guildId: GUILD,
  actorId: ACTOR,
  achievementId: 'chatterbox',
  job: 'rebuild_preview',
  announce: false,
  acceptLoss: false,
} as const;

describe('the achievements event types', () => {
  test('achievements.unlocked is published by the module, not a service', () => {
    expect(isEventType('achievements.unlocked')).toBe(true);
    expect(SERVICE_EMITTED_EVENT_TYPES as readonly string[]).not.toContain('achievements.unlocked');
  });

  test('retries and jobs are requested by the api, so they are service-emitted', () => {
    for (const type of ['achievements.reward_retry_requested', 'achievements.job_requested']) {
      expect(isEventType(type)).toBe(true);
      expect(SERVICE_EMITTED_EVENT_TYPES as readonly string[]).toContain(type);
    }
  });

  test('the tiers run from single through diamond', () => {
    expect(TIER_IDS).toEqual(['single', 'bronze', 'silver', 'gold', 'diamond']);
  });

  test('the retry mailbox has its own prefix', () => {
    expect(ACHIEVEMENT_RETRY_MAILBOX_PREFIX).toBe('proton:achievements:retry');
  });
});

describe('achievements.unlocked', () => {
  test('accepts every tier, with or without an origin channel', () => {
    for (const tierId of TIER_IDS) {
      expect(achievementUnlockedSchema.safeParse({ ...unlocked, tierId }).success).toBe(true);
    }
    const { originChannelId: _origin, ...nowhere } = unlocked;
    expect(achievementUnlockedSchema.safeParse(nowhere).success).toBe(true);
  });

  test('refuses an unknown tier, a negative generation and a missing causation', () => {
    expect(achievementUnlockedSchema.safeParse({ ...unlocked, tierId: 'platinum' }).success).toBe(
      false,
    );
    expect(achievementUnlockedSchema.safeParse({ ...unlocked, generation: -1 }).success).toBe(
      false,
    );
    const { causation: _causation, ...uncaused } = unlocked;
    expect(achievementUnlockedSchema.safeParse(uncaused).success).toBe(false);
  });

  test('refuses an empty or overlong achievement id', () => {
    expect(achievementUnlockedSchema.safeParse({ ...unlocked, achievementId: '' }).success).toBe(
      false,
    );
    expect(
      achievementUnlockedSchema.safeParse({ ...unlocked, achievementId: 'a'.repeat(41) }).success,
    ).toBe(false);
  });

  test('survives a JSON round trip', () => {
    expect(achievementUnlockedSchema.parse(JSON.parse(JSON.stringify(unlocked)))).toEqual({
      ...unlocked,
    });
  });
});

describe('achievements.reward_retry_requested', () => {
  test('accepts one reward and fifty', () => {
    expect(achievementRewardRetryRequestedSchema.safeParse(retry).success).toBe(true);
    expect(
      achievementRewardRetryRequestedSchema.safeParse({
        ...retry,
        rewards: Array.from({ length: 50 }, () => ref),
      }).success,
    ).toBe(true);
  });

  test('refuses none, more than fifty, and a malformed request id', () => {
    expect(achievementRewardRetryRequestedSchema.safeParse({ ...retry, rewards: [] }).success).toBe(
      false,
    );
    expect(
      achievementRewardRetryRequestedSchema.safeParse({
        ...retry,
        rewards: Array.from({ length: 51 }, () => ref),
      }).success,
    ).toBe(false);
    expect(
      achievementRewardRetryRequestedSchema.safeParse({ ...retry, requestId: 'short' }).success,
    ).toBe(false);
    expect(
      achievementRewardRetryRequestedSchema.safeParse({ ...retry, requestId: 'has space in it' })
        .success,
    ).toBe(false);
  });

  test('refuses an actor that is not a member, such as a pseudo-actor', () => {
    expect(
      achievementRewardRetryRequestedSchema.safeParse({ ...retry, actorId: 'proton:achievements' })
        .success,
    ).toBe(false);
  });

  test('refuses a reward reference with an empty or overlong key', () => {
    expect(achievementRewardRefSchema.safeParse({ ...ref, rewardKey: '' }).success).toBe(false);
    expect(
      achievementRewardRefSchema.safeParse({ ...ref, rewardKey: 'x'.repeat(81) }).success,
    ).toBe(false);
  });
});

describe('achievements.job_requested', () => {
  test('accepts each job', () => {
    for (const kind of ['rebuild', 'rebuild_preview', 'recheck'] as const) {
      expect(achievementJobRequestedSchema.safeParse({ ...job, job: kind }).success).toBe(true);
    }
  });

  test('refuses an unknown job and a missing confirmation flag', () => {
    expect(achievementJobRequestedSchema.safeParse({ ...job, job: 'purge' }).success).toBe(false);
    const { acceptLoss: _acceptLoss, ...unconfirmed } = job;
    expect(achievementJobRequestedSchema.safeParse(unconfirmed).success).toBe(false);
  });
});

describe('the retry outcome the worker answers with', () => {
  test('accepts each status with its message', () => {
    for (const status of [
      'delivered',
      'requested',
      'failed',
      'skipped',
      'not_found',
      'not_retryable',
    ] as const) {
      expect(
        achievementRetryOutcomeSchema.safeParse({
          results: [{ ...ref, status, message: 'Proton gave the role.' }],
        }).success,
      ).toBe(true);
    }
  });

  test('refuses an unknown status and an overlong message', () => {
    expect(
      achievementRetryOutcomeSchema.safeParse({
        results: [{ ...ref, status: 'maybe', message: '' }],
      }).success,
    ).toBe(false);
    expect(
      achievementRetryOutcomeSchema.safeParse({
        results: [{ ...ref, status: 'failed', message: 'x'.repeat(401) }],
      }).success,
    ).toBe(false);
  });
});
