import { describe, expect, test } from 'bun:test';
import type { TierId } from '@proton/core';
import fc from 'fast-check';
import {
  type Achievement,
  type AchievementInput,
  achievementSchema,
  TIERED_IDS,
} from '../src/config.ts';
import {
  acceptsAt,
  almostThereDue,
  channelMatches,
  clipSpan,
  countingWindows,
  displayStatus,
  earnedTierIds,
  formatProgress,
  type Interval,
  netRoleIntent,
  nextTier,
  progressBar,
  revisionOf,
  tierRank,
} from '../src/evaluate.ts';
import { triggerOf } from '../src/triggers.ts';
import { intervalSchema } from '../src/view.ts';

const REQUIREMENT_IDS = ['aa', 'bb', 'cc'] as const;
const COUNT_TRIGGERS = ['messages.sent', 'voice.minutes', 'reactions.given'] as const;
const ROLES = ['400000000000000001', '400000000000000002', '400000000000000003'] as const;

function parse(input: AchievementInput): Achievement {
  return achievementSchema.parse(input);
}

const singleAchievement = fc
  .integer({ min: 1, max: 3 })
  .chain((count) =>
    fc.array(fc.integer({ min: 1, max: 200 }), { minLength: count, maxLength: count }),
  )
  .map((targets) =>
    parse({
      id: 'combined',
      name: 'Combined',
      kind: 'single',
      requirements: targets.map((_, index) => ({
        id: REQUIREMENT_IDS[index] ?? 'aa',
        trigger: COUNT_TRIGGERS[index] ?? 'messages.sent',
      })),
      tiers: [
        {
          id: 'single',
          targets: Object.fromEntries(
            targets.map((target, index) => [REQUIREMENT_IDS[index] ?? 'aa', target]),
          ),
        },
      ],
    }),
  );

const tieredAchievement = fc
  .array(fc.integer({ min: 1, max: 100 }), { minLength: 2, maxLength: 4 })
  .map((steps) => {
    let running = 0;
    const targets = steps.map((step) => {
      running += step;
      return running;
    });

    return parse({
      id: 'ladder',
      name: 'Ladder',
      kind: 'tiered',
      requirements: [{ id: 'aa', trigger: 'messages.sent' }],
      tiers: targets.map((target, index) => ({
        id: TIERED_IDS[index] ?? 'bronze',
        targets: { aa: target },
      })),
    });
  });

const anyAchievement = fc.oneof(singleAchievement, tieredAchievement);

const values = fc.record({
  aa: fc.integer({ min: 0, max: 1000 }),
  bb: fc.integer({ min: 0, max: 1000 }),
  cc: fc.integer({ min: 0, max: 1000 }),
});

const increments = fc.record({
  aa: fc.integer({ min: 0, max: 500 }),
  bb: fc.integer({ min: 0, max: 500 }),
  cc: fc.integer({ min: 0, max: 500 }),
});

const event = fc.record({
  requirement: fc.constantFrom(...REQUIREMENT_IDS),
  amount: fc.integer({ min: 1, max: 60 }),
});

const events = fc
  .array(event, { maxLength: 30 })
  .chain((list) =>
    fc.tuple(
      fc.constant(list),
      fc.shuffledSubarray(list, { minLength: list.length, maxLength: list.length }),
    ),
  );

function replay(
  achievement: Achievement,
  list: ReadonlyArray<{ requirement: string; amount: number }>,
) {
  const totals: Record<string, number> = {};
  const seen = new Set<TierId>();

  for (const { requirement, amount } of list) {
    totals[requirement] = (totals[requirement] ?? 0) + amount;
    for (const tier of earnedTierIds(achievement, totals)) seen.add(tier);
  }

  return {
    final: earnedTierIds(achievement, totals),
    seen: [...seen].sort((a, b) => tierRank(a) - tierRank(b)),
  };
}

describe('earnedTierIds', () => {
  test('raising values never un-earns a tier', () => {
    fc.assert(
      fc.property(anyAchievement, values, increments, (achievement, before, extra) => {
        const after = {
          aa: before.aa + extra.aa,
          bb: before.bb + extra.bb,
          cc: before.cc + extra.cc,
        };
        const earlier = earnedTierIds(achievement, before);
        const later = earnedTierIds(achievement, after);

        for (const tier of earlier) expect(later).toContain(tier);
      }),
    );
  });

  test('the order activity arrives in changes nothing', () => {
    fc.assert(
      fc.property(anyAchievement, events, (achievement, [list, shuffled]) => {
        const inOrder = replay(achievement, list);
        const reordered = replay(achievement, shuffled);

        expect(reordered.final).toEqual(inOrder.final);
        expect(inOrder.seen).toEqual(inOrder.final);
        expect(reordered.seen).toEqual(reordered.final);
      }),
    );
  });

  test('strictly increasing tiers are earned bottom up', () => {
    fc.assert(
      fc.property(tieredAchievement, fc.integer({ min: 0, max: 500 }), (achievement, value) => {
        const earned = earnedTierIds(achievement, { aa: value });
        const prefix = achievement.tiers.slice(0, earned.length).map((tier) => tier.id);
        expect(earned).toEqual(prefix);
      }),
    );
  });

  test('a combined achievement needs every requirement', () => {
    fc.assert(
      fc.property(singleAchievement, values, (achievement, current) => {
        const tier = achievement.tiers[0];
        const allMet = achievement.requirements.every(
          (requirement) =>
            current[requirement.id as keyof typeof current] >= (tier?.targets[requirement.id] ?? 0),
        );
        expect(earnedTierIds(achievement, current)).toEqual(allMet ? ['single'] : []);
      }),
    );
  });
});

describe('nextTier and almostThereDue', () => {
  test('a reminder never names a tier already earned, unlocked or reminded', () => {
    fc.assert(
      fc.property(
        anyAchievement,
        values,
        fc.subarray(['single', ...TIERED_IDS] as TierId[]),
        fc.subarray(['single', ...TIERED_IDS] as TierId[]),
        fc.integer({ min: 50, max: 95 }),
        (base, current, unlocked, notified, percent) => {
          const achievement = { ...base, almostThere: { enabled: true, percent } };
          const due = almostThereDue(achievement, current, unlocked, notified);
          if (due === null) return;

          expect(unlocked).not.toContain(due);
          expect(notified).not.toContain(due);
          expect(earnedTierIds(achievement, current)).not.toContain(due);
          expect(nextTier(achievement, current, unlocked)?.percent ?? 0).toBeGreaterThanOrEqual(
            percent,
          );
        },
      ),
    );
  });

  test('percent is the least-finished requirement, floored', () => {
    const achievement = parse({
      id: 'combined',
      name: 'Combined',
      kind: 'single',
      requirements: [
        { id: 'aa', trigger: 'messages.sent' },
        { id: 'bb', trigger: 'voice.minutes' },
      ],
      tiers: [{ id: 'single', targets: { aa: 100, bb: 60 } }],
    });

    const next = nextTier(achievement, { aa: 29, bb: 59 }, []);
    expect(next?.percent).toBe(29);
    expect(next?.requirements.map((requirement) => requirement.remaining)).toEqual([71, 1]);
    expect(nextTier(achievement, { aa: 100, bb: 60 }, ['single'])).toBeNull();
  });
});

describe('netRoleIntent', () => {
  const mention = fc.constantFrom<'add' | 'remove' | null>('add', 'remove', null);
  const tierRewards = fc.tuple(mention, mention, mention);

  const rewarded = fc.array(tierRewards, { minLength: 2, maxLength: 4 }).map((perTier) =>
    parse({
      id: 'ladder',
      name: 'Ladder',
      kind: 'tiered',
      requirements: [{ id: 'aa', trigger: 'messages.sent' }],
      tiers: perTier.map((mentions, index) => ({
        id: TIERED_IDS[index] ?? 'bronze',
        targets: { aa: (index + 1) * 10 },
        rewards: mentions.flatMap((intent, role) =>
          intent === null
            ? []
            : [
                {
                  kind: intent === 'add' ? ('add_role' as const) : ('remove_role' as const),
                  roleId: ROLES[role] ?? ROLES[0],
                },
              ],
        ),
      })),
    }),
  );

  test('the highest unlocked tier that mentions a role wins', () => {
    fc.assert(
      fc.property(rewarded, fc.subarray([...TIERED_IDS] as TierId[]), (achievement, unlocked) => {
        const intent = netRoleIntent(achievement, unlocked);

        for (const roleId of ROLES) {
          const deciding = achievement.tiers
            .filter((tier) => unlocked.includes(tier.id))
            .filter((tier) =>
              tier.rewards.some((reward) => reward.kind !== 'xp' && reward.roleId === roleId),
            )
            .sort((a, b) => tierRank(b.id) - tierRank(a.id))[0];

          if (!deciding) {
            expect(intent.has(roleId)).toBe(false);
            continue;
          }

          const reward = deciding.rewards.find(
            (candidate) => candidate.kind !== 'xp' && candidate.roleId === roleId,
          );
          expect(intent.get(roleId)).toBe(reward?.kind === 'add_role' ? 'add' : 'remove');
        }
      }),
    );
  });

  test('a later tier removing an earlier tier’s role takes it away', () => {
    const achievement = parse({
      id: 'ladder',
      name: 'Ladder',
      kind: 'tiered',
      requirements: [{ id: 'aa', trigger: 'messages.sent' }],
      tiers: [
        { id: 'bronze', targets: { aa: 10 }, rewards: [{ kind: 'add_role', roleId: ROLES[0] }] },
        {
          id: 'silver',
          targets: { aa: 20 },
          rewards: [
            { kind: 'remove_role', roleId: ROLES[0] },
            { kind: 'add_role', roleId: ROLES[1] },
          ],
        },
      ],
    });

    expect([...netRoleIntent(achievement, ['bronze']).entries()]).toEqual([[ROLES[0], 'add']]);
    expect(Object.fromEntries(netRoleIntent(achievement, ['bronze', 'silver']))).toEqual({
      [ROLES[0]]: 'remove',
      [ROLES[1]]: 'add',
    });
  });
});

describe('clipSpan', () => {
  const instant = fc.integer({ min: 0, max: 10_000 });
  const span = fc
    .tuple(instant, instant)
    .map(([a, b]) => ({ start: Math.min(a, b), end: Math.max(a, b) }));
  const window = fc.tuple(instant, fc.option(instant, { nil: null })).map(
    ([start, end]): Interval => ({
      start: end === null ? start : Math.min(start, end),
      end: end === null ? null : Math.max(start, end),
    }),
  );
  const windows = fc.array(window, { maxLength: 6 });

  test('stays between zero and the length of the span', () => {
    fc.assert(
      fc.property(span, windows, (s, list) => {
        const clipped = clipSpan(s, list);
        expect(clipped).toBeGreaterThanOrEqual(0);
        expect(clipped).toBeLessThanOrEqual(s.end - s.start);
      }),
    );
  });

  test('overlapping windows are not counted twice', () => {
    fc.assert(
      fc.property(span, windows, (s, list) => {
        expect(clipSpan(s, [...list, ...list])).toBe(clipSpan(s, list));
      }),
    );
  });

  test('a covering window keeps the whole span, and no window keeps nothing', () => {
    fc.assert(
      fc.property(span, (s) => {
        expect(clipSpan(s, [{ start: s.start, end: null }])).toBe(s.end - s.start);
        expect(clipSpan(s, [])).toBe(0);
      }),
    );
  });

  test('splitting a window in two changes nothing', () => {
    fc.assert(
      fc.property(span, instant, instant, (s, a, b) => {
        const start = Math.min(a, b);
        const end = Math.max(a, b);
        const middle = Math.floor((start + end) / 2);

        expect(
          clipSpan(s, [
            { start, end: middle },
            { start: middle, end },
          ]),
        ).toBe(clipSpan(s, [{ start, end }]));
      }),
    );
  });

  test('intervals match the view schema', () => {
    fc.assert(
      fc.property(window, (interval) => {
        expect(intervalSchema.parse(interval)).toEqual(interval);
      }),
    );
  });
});

describe('revisionOf', () => {
  test('channel order and repeats don’t change what counts', () => {
    const channel = fc.integer({ min: 0, max: 5 }).map((n) => `30000000000000000${n}`);

    fc.assert(
      fc.property(fc.array(channel, { maxLength: 6 }), (ids) => {
        const base = {
          id: 'aa',
          version: 1,
          trigger: 'messages.sent' as const,
          excludedChannelIds: [],
        };
        const a = revisionOf({ ...base, channelIds: ids });
        const b = revisionOf({ ...base, channelIds: [...ids].reverse().concat(ids) });
        expect(a).toBe(b);
      }),
    );
  });

  test('an absent XP source list is the default one', () => {
    const base = {
      id: 'xp',
      version: 1,
      trigger: 'leveling.activity_xp' as const,
      channelIds: [],
      excludedChannelIds: [],
    };
    expect(revisionOf(base)).toBe(revisionOf({ ...base, xpSources: ['voice', 'message'] }));
    expect(revisionOf(base)).not.toBe(revisionOf({ ...base, xpSources: ['message'] }));
    expect(revisionOf(base)).not.toBe(revisionOf({ ...base, trigger: 'messages.sent' }));
  });
});

describe('small helpers', () => {
  test('channelMatches follows the thread, channel and category chain', () => {
    const where = { channelId: 'thread', parentId: 'channel', categoryId: 'category' };
    expect(channelMatches({ channelIds: [], excludedChannelIds: [] }, where)).toBe(true);
    expect(channelMatches({ channelIds: ['category'], excludedChannelIds: [] }, where)).toBe(true);
    expect(channelMatches({ channelIds: ['other'], excludedChannelIds: [] }, where)).toBe(false);
    expect(channelMatches({ channelIds: ['channel'], excludedChannelIds: ['thread'] }, where)).toBe(
      false,
    );
    expect(
      channelMatches(
        { channelIds: ['channel'], excludedChannelIds: [] },
        { channelId: null, parentId: null, categoryId: null },
      ),
    ).toBe(false);
  });

  test('progress reads as text first, then a bar of fixed width', () => {
    expect(formatProgress(320, 500, triggerOf('messages.sent').unit)).toBe(
      '320 / 500 messages (64%)',
    );
    expect(formatProgress(1240, 5000, triggerOf('messages.sent').unit)).toBe(
      '1,240 / 5,000 messages (24%)',
    );
    expect(progressBar(0.3)).toBe('▰▰▰▱▱▱▱▱▱▱');

    fc.assert(
      fc.property(fc.double({ noNaN: false }), fc.integer({ min: 1, max: 30 }), (ratio, width) => {
        expect([...progressBar(ratio, width)]).toHaveLength(width);
      }),
    );
  });

  test('acceptsAt honours the dates and the grace period', () => {
    const achievement = parse({
      id: 'dated',
      name: 'Dated',
      kind: 'single',
      requirements: [{ id: 'aa', trigger: 'messages.sent' }],
      tiers: [{ id: 'single', targets: { aa: 1 } }],
      startsAt: '2026-10-01T00:00:00.000Z',
      endsAt: '2026-10-31T00:00:00.000Z',
    });
    const start = Date.parse('2026-10-01T00:00:00.000Z');
    const end = Date.parse('2026-10-31T00:00:00.000Z');
    const hour = 60 * 60 * 1000;

    expect(acceptsAt(achievement, start - 1, start)).toBe(false);
    expect(acceptsAt(achievement, start, start)).toBe(true);
    expect(acceptsAt(achievement, end, end + hour)).toBe(true);
    expect(acceptsAt(achievement, end, end + hour + 1)).toBe(false);
    expect(acceptsAt(achievement, end + 1, end + 1)).toBe(false);
  });

  test('counting windows follow include-recorded and clip to the dates', () => {
    const base = parse({
      id: 'dated',
      name: 'Dated',
      kind: 'single',
      requirements: [{ id: 'aa', trigger: 'messages.sent' }],
      tiers: [{ id: 'single', targets: { aa: 1 } }],
      startsAt: '1970-01-01T00:00:00.100Z',
    });
    const periods = {
      module: [
        { start: 0, end: 50 },
        { start: 80, end: null },
      ],
      achievement: [{ start: 120, end: null }],
    };

    expect(countingWindows(base, periods)).toEqual([{ start: 120, end: null }]);
    expect(countingWindows({ ...base, includeRecorded: true }, periods)).toEqual([
      { start: 100, end: null },
    ]);
  });

  test('display status explains why an active achievement isn’t counting', () => {
    const achievement = parse({
      id: 'stars',
      name: 'Stars',
      kind: 'single',
      status: 'active',
      requirements: [
        { id: 'aa', trigger: 'starboard.messages' },
        { id: 'bb', trigger: 'leveling.level' },
      ],
      tiers: [{ id: 'single', targets: { aa: 1, bb: 5 } }],
    });
    const now = Date.parse('2026-09-19T12:00:00.000Z');
    const everything = { now, moduleEnabled: true, enabledModules: ['leveling', 'starboard'] };
    const nothing = { now, moduleEnabled: true, enabledModules: [] };
    const onlyLeveling = { now, moduleEnabled: true, enabledModules: new Set(['leveling']) };

    expect(displayStatus(achievement, everything)).toEqual({ status: 'active' });
    expect(displayStatus(achievement, { ...nothing, moduleEnabled: false })).toEqual({
      status: 'paused',
      reason: 'Achievements is off',
    });
    expect(displayStatus(achievement, onlyLeveling)).toEqual({
      status: 'paused',
      reason: 'Starboard is off in this server',
      blockedBy: ['starboard'],
    });
    expect(displayStatus(achievement, nothing).reason).toBe(
      'Leveling and Starboard are off in this server',
    );
    expect(displayStatus({ ...achievement, status: 'paused' }, nothing)).toEqual({
      status: 'paused',
      reason: 'Paused by an admin',
    });

    const later = { ...achievement, startsAt: '2026-10-01T00:00:00.000Z' };
    expect(displayStatus(later, everything).status).toBe('scheduled');

    const over = { ...achievement, endsAt: '2026-09-01T00:00:00.000Z' };
    expect(displayStatus(over, { ...nothing, moduleEnabled: false }).status).toBe('expired');
  });
});
