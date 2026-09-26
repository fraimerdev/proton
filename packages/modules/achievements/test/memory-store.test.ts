import { describe, expect, test } from 'bun:test';
import { achievementSchema, achievementsConfigSchema } from '../src/config.ts';
import { ACTIVITY_RETENTION_DAYS } from '../src/constants.ts';
import { hourCeil, hourFloor, planRebuild, rebuildSignature } from '../src/rebuild.ts';
import type { GuildRuntime } from '../src/store.ts';
import {
  ACHIEVEMENT,
  CHANNEL,
  CHATTERBOX,
  DAY,
  describeAchievementStore,
  describeVoiceStore,
  HOUR,
  MINUTE,
  OTHER_CHANNEL,
  T0,
} from './contracts.ts';
import { MemoryAchievementStore } from './memory-store.ts';
import {
  MemoryAchievementVoiceStore,
  MemoryFencedLocks,
  MemoryLimits,
} from './memory-voice-store.ts';

describeAchievementStore('memory store', async () => {
  const store = new MemoryAchievementStore();
  return {
    store,
    setModule: async (guildId, enabled, config) => store.setModule(guildId, { enabled, config }),
  };
});

describeVoiceStore('memory voice store', async () => ({
  voice: new MemoryAchievementVoiceStore(),
  locks: new MemoryFencedLocks(),
  limits: new MemoryLimits(),
}));

function runtime(overrides: Partial<GuildRuntime> = {}): GuildRuntime {
  return {
    modulePeriods: [{ start: T0 - 10 * DAY, end: null }],
    periods: new Map([[ACHIEVEMENT, [{ start: T0 - 2 * DAY + 20 * MINUTE, end: null }]]]),
    state: new Map(),
    ...overrides,
  };
}

describe('planning a rebuild', () => {
  const config = achievementsConfigSchema.parse({
    enabled: true,
    excludedChannelIds: [OTHER_CHANNEL],
  });

  test('counts only the achievement’s own periods unless recorded progress is included', () => {
    const achievement = achievementSchema.parse(CHATTERBOX);

    expect(planRebuild(config, achievement, runtime(), T0).windows).toEqual([
      { start: T0 - 2 * DAY + HOUR, end: null },
    ]);
    expect(
      planRebuild(config, { ...achievement, includeRecorded: true }, runtime(), T0).windows,
    ).toEqual([{ start: T0 - 10 * DAY, end: null }]);
  });

  test('clips windows inward to whole hours, to the dates and to the last 365 days', () => {
    const achievement = achievementSchema.parse({
      ...CHATTERBOX,
      includeRecorded: true,
      endsAt: new Date(T0 - DAY + 30 * MINUTE).toISOString(),
    });
    const old = runtime({
      modulePeriods: [
        { start: T0 - 500 * DAY, end: T0 - 400 * DAY },
        { start: T0 - 3 * DAY + 10 * MINUTE, end: T0 - 2 * DAY + 50 * MINUTE },
        { start: T0 - 30 * MINUTE, end: null },
      ],
    });

    expect(planRebuild(config, achievement, old, T0).windows).toEqual([
      { start: T0 - 3 * DAY + HOUR, end: T0 - 2 * DAY },
    ]);

    const { endsAt: _endsAt, ...endless } = achievement;
    const horizon = runtime({ modulePeriods: [{ start: T0 - 500 * DAY, end: null }] });
    const [window] = planRebuild(config, endless, horizon, T0 + 17 * MINUTE).windows;
    expect(window).toEqual({
      start: hourCeil(T0 + 17 * MINUTE - ACTIVITY_RETENTION_DAYS * DAY),
      end: null,
    });
  });

  test('splits ledger and state requirements and merges the module’s excluded channels', () => {
    const achievement = achievementSchema.parse({
      ...CHATTERBOX,
      kind: 'single',
      requirements: [
        { id: 'messages', trigger: 'messages.sent', version: 3, excludedChannelIds: [CHANNEL] },
        { id: 'xp', trigger: 'leveling.activity_xp', xpSources: ['voice', 'message'] },
        { id: 'level', trigger: 'leveling.level', version: 2 },
      ],
      tiers: [{ id: 'single', targets: { messages: 5, xp: 50, level: 3 } }],
    });

    const planned = planRebuild(config, achievement, runtime(), T0);

    expect(planned.requirements).toEqual([
      {
        requirementId: 'messages',
        version: 3,
        metric: 'messages',
        aggregate: 'sum',
        temporaryOnly: false,
        xpSources: null,
        channelIds: [],
        excludedChannelIds: [CHANNEL, OTHER_CHANNEL],
      },
      {
        requirementId: 'xp',
        version: 1,
        metric: 'activity_xp',
        aggregate: 'sum',
        temporaryOnly: false,
        xpSources: ['message', 'voice'],
        channelIds: [],
        excludedChannelIds: [OTHER_CHANNEL],
      },
    ]);
    expect(planned.stateRequirements).toEqual([{ requirementId: 'level', version: 2 }]);
    expect(planned.tiers).toEqual([
      { tierId: 'single', targets: { messages: 5, xp: 50, level: 3 } },
    ]);

    const temporary = achievementSchema.parse({
      ...CHATTERBOX,
      requirements: [{ id: 'temp', trigger: 'tempvc.minutes' }],
      tiers: [
        { id: 'bronze', targets: { temp: 60 } },
        { id: 'silver', targets: { temp: 600 } },
      ],
    });
    const stay = achievementSchema.parse({
      ...CHATTERBOX,
      kind: 'single',
      requirements: [{ id: 'stay', trigger: 'voice.longest_stay' }],
      tiers: [{ id: 'single', targets: { stay: 120 } }],
    });

    expect(planRebuild(config, temporary, runtime(), T0).requirements[0]).toMatchObject({
      metric: 'voice_minutes',
      temporaryOnly: true,
      aggregate: 'sum',
    });
    expect(planRebuild(config, stay, runtime(), T0).requirements[0]).toMatchObject({
      metric: 'voice_stay',
      temporaryOnly: false,
      aggregate: 'max',
    });
  });

  test('keeps the higher value only while the dates and versions match the last rebuild', () => {
    const achievement = achievementSchema.parse(CHATTERBOX);
    const signature = rebuildSignature(achievement);
    const withSignature = (rebuiltWith: string | null) =>
      runtime({
        state: new Map([
          [
            ACHIEVEMENT,
            { generation: 0, rewardEpoch: 0, countedFrom: null, firstActiveAt: T0, rebuiltWith },
          ],
        ]),
      });

    expect(planRebuild(config, achievement, runtime(), T0).keepHigher).toBe(true);
    expect(planRebuild(config, achievement, withSignature(signature), T0).keepHigher).toBe(true);
    expect(planRebuild(config, achievement, withSignature(signature), T0).signature).toBe(
      signature,
    );

    const moved = { ...achievement, startsAt: new Date(T0).toISOString() };
    expect(planRebuild(config, moved, withSignature(signature), T0).keepHigher).toBe(false);

    const bumped = {
      ...achievement,
      requirements: achievement.requirements.map((requirement) => ({
        ...requirement,
        version: requirement.version + 1,
      })),
    };
    expect(planRebuild(config, bumped, withSignature(signature), T0).keepHigher).toBe(false);
  });

  test('hour helpers round to whole UTC hours', () => {
    expect(hourFloor(T0 + 59 * MINUTE)).toBe(T0);
    expect(hourCeil(T0 + 1)).toBe(T0 + HOUR);
    expect(hourCeil(T0)).toBe(T0);
  });
});
