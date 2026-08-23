import { describe, expect, test } from 'bun:test';
import {
  evaluateRequirement,
  evaluateWeight,
  type MemberContext,
  ProviderRegistry,
} from '@proton/core';
import {
  type ActivityQuery,
  type ActivityStore,
  type ActivityTotals,
  type MemberStats,
  utcDay,
  windowStart,
} from '../src/activity.ts';
import { createLevelingProviders } from '../src/providers.ts';

const GUILD = '100000000000000000';
const USER_A = '400000000000000001';
const USER_B = '400000000000000002';
const NOW = new Date('2026-08-14T12:00:00.000Z');

interface DayRow {
  userId: string;
  day: string;
  messageCount: number;
  voiceSeconds: number;
}

class FakeActivityStore implements ActivityStore {
  readonly calls: { totals: number; stats: number; topRanked: number } = {
    totals: 0,
    stats: 0,
    topRanked: 0,
  };

  readonly lastTotals: ActivityQuery[] = [];

  constructor(
    private readonly stats_: Map<string, MemberStats>,
    private readonly days: DayRow[] = [],
  ) {}

  async totals(query: ActivityQuery): Promise<Map<string, ActivityTotals>> {
    this.calls.totals += 1;
    this.lastTotals.push(query);

    const wanted = new Set(query.userIds);
    const totals = new Map<string, ActivityTotals>();

    if (query.window === 'lifetime') {
      for (const [userId, stat] of this.stats_) {
        if (!wanted.has(userId)) continue;
        totals.set(userId, {
          messageCount: stat.messageCount,
          voiceSeconds: stat.voiceSeconds,
        });
      }
      return totals;
    }

    const start = windowStart(query.window, query.now);
    for (const row of this.days) {
      if (!wanted.has(row.userId)) continue;
      if (start && row.day < utcDay(start)) continue;

      const current = totals.get(row.userId) ?? { messageCount: 0, voiceSeconds: 0 };
      totals.set(row.userId, {
        messageCount: current.messageCount + row.messageCount,
        voiceSeconds: current.voiceSeconds + row.voiceSeconds,
      });
    }

    return totals;
  }

  async stats(_guildId: string, userIds: readonly string[]): Promise<Map<string, MemberStats>> {
    this.calls.stats += 1;

    const wanted = new Set(userIds);
    return new Map([...this.stats_].filter(([userId]) => wanted.has(userId)));
  }

  async topRanked(_guildId: string, n: number): Promise<string[]> {
    this.calls.topRanked += 1;

    return [...this.stats_]
      .sort(([, a], [, b]) => b.xp - a.xp)
      .slice(0, n)
      .map(([userId]) => userId);
  }

  async prune(): Promise<number> {
    return 0;
  }
}

function ctx(userId: string): MemberContext {
  return {
    guildId: GUILD,
    userId,
    member: {
      joinedAt: new Date('2024-01-01T00:00:00.000Z'),
      roleIds: [],
      premiumSince: null,
      communicationDisabledUntil: null,
    },
    user: { createdAt: new Date('2020-01-01T00:00:00.000Z'), hasAvatar: true, bot: false },
    tier: 'free',
    now: NOW,
  };
}

function stats(entries: Record<string, Partial<MemberStats>>): Map<string, MemberStats> {
  return new Map(
    Object.entries(entries).map(([userId, stat]) => [
      userId,
      { xp: 0, level: 0, messageCount: 0, voiceSeconds: 0, ...stat },
    ]),
  );
}

function registryFor(store: ActivityStore): ProviderRegistry {
  const registry = new ProviderRegistry();
  registry.register({ id: 'leveling', providers: createLevelingProviders(store) });
  return registry;
}

describe('leveling conditions', () => {
  test('leveling.level compares against the level derived from XP', async () => {
    const store = new FakeActivityStore(stats({ [USER_A]: { level: 7 }, [USER_B]: { level: 2 } }));
    const registry = registryFor(store);

    const passing = await evaluateRequirement(
      registry,
      ctx(USER_A),
      [{ providerId: 'leveling.level', config: { min: 5 } }],
      'all',
    );
    const failing = await evaluateRequirement(
      registry,
      ctx(USER_B),
      [{ providerId: 'leveling.level', config: { min: 5 } }],
      'all',
    );

    expect(passing.passed).toBe(true);
    expect(failing.passed).toBe(false);
    expect(failing.failures[0]?.humanReason).toBe('You are level 2 and need level 5.');
  });

  test('leveling.xp reports progress toward the threshold', async () => {
    const store = new FakeActivityStore(stats({ [USER_A]: { xp: 250 } }));

    const verdict = await evaluateRequirement(
      registryFor(store),
      ctx(USER_A),
      [{ providerId: 'leveling.xp', config: { min: 1000 } }],
      'all',
    );

    expect(verdict.failures[0]?.progress).toEqual({ current: 250, required: 1000, unit: 'XP' });
  });

  test('leveling.messages defaults to the 30 day window, not lifetime', async () => {
    const store = new FakeActivityStore(new Map());
    const registry = registryFor(store);

    await evaluateRequirement(
      registry,
      ctx(USER_A),
      [{ providerId: 'leveling.messages', config: { min: 1 } }],
      'all',
    );

    expect(store.lastTotals[0]?.window).toBe('30d');
  });

  // The whole point of the windowed default: activity from two years ago is not activity now.
  test('leveling.messages at 30d ignores buckets outside the window', async () => {
    const store = new FakeActivityStore(new Map(), [
      { userId: USER_A, day: '2024-01-01', messageCount: 5000, voiceSeconds: 0 },
      { userId: USER_A, day: '2026-08-13', messageCount: 40, voiceSeconds: 0 },
    ]);

    const verdict = await evaluateRequirement(
      registryFor(store),
      ctx(USER_A),
      [{ providerId: 'leveling.messages', config: { min: 100, window: '30d' } }],
      'all',
    );

    expect(verdict.passed).toBe(false);
    expect(verdict.failures[0]?.progress?.current).toBe(40);
  });

  test('leveling.messages at lifetime reads the running total instead', async () => {
    const store = new FakeActivityStore(stats({ [USER_A]: { messageCount: 5040 } }), []);

    const verdict = await evaluateRequirement(
      registryFor(store),
      ctx(USER_A),
      [{ providerId: 'leveling.messages', config: { min: 100, window: 'lifetime' } }],
      'all',
    );

    expect(verdict.passed).toBe(true);
  });

  test('leveling.voice_minutes converts stored seconds to minutes', async () => {
    const store = new FakeActivityStore(new Map(), [
      { userId: USER_A, day: '2026-08-13', messageCount: 0, voiceSeconds: 3_540 },
    ]);

    const verdict = await evaluateRequirement(
      registryFor(store),
      ctx(USER_A),
      [{ providerId: 'leveling.voice_minutes', config: { min: 60, window: '30d' } }],
      'all',
    );

    expect(verdict.passed).toBe(false);
    expect(verdict.failures[0]?.progress?.current).toBe(59);
  });

  test('leveling.rank_top admits only the top n', async () => {
    const store = new FakeActivityStore(stats({ [USER_A]: { xp: 900 }, [USER_B]: { xp: 100 } }));
    const registry = registryFor(store);
    const spec = [{ providerId: 'leveling.rank_top', config: { n: 1 } }];

    expect((await evaluateRequirement(registry, ctx(USER_A), spec, 'all')).passed).toBe(true);
    expect((await evaluateRequirement(registry, ctx(USER_B), spec, 'all')).passed).toBe(false);
  });

  test('a member the store has never seen scores zero rather than throwing', async () => {
    const verdict = await evaluateRequirement(
      registryFor(new FakeActivityStore(new Map())),
      ctx(USER_A),
      [{ providerId: 'leveling.level', config: { min: 1 } }],
      'all',
    );

    expect(verdict.passed).toBe(false);
    expect(verdict.failures[0]?.humanReason).toContain('level 0');
  });
});

describe('leveling multipliers', () => {
  test('level_tier awards its amount at or above the level', async () => {
    const store = new FakeActivityStore(stats({ [USER_A]: { level: 10 } }));

    const weight = await evaluateWeight(registryFor(store), ctx(USER_A), [
      { providerId: 'leveling.level_tier', config: { minLevel: 5, amount: 4 }, mode: 'add' },
    ]);

    expect(weight.total).toBe(5);
  });

  // Repeating one provider under 'max' is how a tier ladder is expressed without arrays of
  // objects, which the form generator does not support (PLAN.md §9).
  test('repeated level_tier entries under max mode behave as a tier ladder', async () => {
    const store = new FakeActivityStore(stats({ [USER_A]: { level: 10 } }));

    const weight = await evaluateWeight(registryFor(store), ctx(USER_A), [
      { providerId: 'leveling.level_tier', config: { minLevel: 5, amount: 2 }, mode: 'max' },
      { providerId: 'leveling.level_tier', config: { minLevel: 10, amount: 6 }, mode: 'max' },
      { providerId: 'leveling.level_tier', config: { minLevel: 20, amount: 20 }, mode: 'max' },
    ]);

    expect(weight.total).toBe(7);
  });

  test('per_messages earns one step per `per` and stops at the cap', async () => {
    const store = new FakeActivityStore(new Map(), [
      { userId: USER_A, day: '2026-08-13', messageCount: 950, voiceSeconds: 0 },
    ]);

    const weight = await evaluateWeight(registryFor(store), ctx(USER_A), [
      {
        providerId: 'leveling.per_messages',
        config: { per: 100, amount: 1, cap: 5, window: '30d' },
        mode: 'add',
      },
    ]);

    expect(weight.total).toBe(6);
    expect(weight.breakdown[0]?.amount).toBe(5);
  });

  test('per_voice_minutes reads minutes, not seconds', async () => {
    const store = new FakeActivityStore(new Map(), [
      { userId: USER_A, day: '2026-08-13', messageCount: 0, voiceSeconds: 7_200 },
    ]);

    const weight = await evaluateWeight(registryFor(store), ctx(USER_A), [
      {
        providerId: 'leveling.per_voice_minutes',
        config: { per: 60, amount: 2, cap: 100, window: '30d' },
        mode: 'add',
      },
    ]);

    expect(weight.total).toBe(5);
  });
});

describe('batch behaviour', () => {
  test('every leveling provider declares itself query-backed and answers for a batch', () => {
    const providers = createLevelingProviders(new FakeActivityStore(new Map()));

    for (const provider of providers) {
      expect(provider.cost).toBe('query');
      expect(provider.batchEvaluate).toBeDefined();
    }
  });

  test('registering them all is accepted by the registry', () => {
    expect(() => registryFor(new FakeActivityStore(new Map()))).not.toThrow();
  });

  test('every builder fits inside one Discord modal', () => {
    for (const provider of createLevelingProviders(new FakeActivityStore(new Map()))) {
      expect(provider.builder.length).toBeLessThanOrEqual(5);
    }
  });
});
