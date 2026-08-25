import { describe, expect, test } from 'bun:test';
import type { ModuleContext } from '@proton/core';
import { type GiveawaysConfig, giveawaysConfigSchema } from '../src/config.ts';
import {
  describePrizes,
  nextRun,
  parsePrizes,
  parseRecurrence,
  prizeListSchema,
  prizesForWinners,
  recurrenceSchema,
  totalPrizeCount,
} from '../src/prizes.ts';
import { scheduleNextRun } from '../src/recurrence.ts';
import type { CreateGiveawayInput } from '../src/store.ts';
import { MemoryGiveawayStore } from './memory-store.ts';

const GUILD = '100000000000000000';
const HOST = '400000000000000001';
const NOW = new Date('2026-08-25T12:00:00.000Z');
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

describe('the prize list', () => {
  test('one prize per winner, in order', () => {
    const prizes = [
      { label: 'Nitro', count: 1 },
      { label: 'Gift card', count: 2 },
    ];

    expect(prizesForWinners(prizes, 3, 'fallback')).toEqual(['Nitro', 'Gift card', 'Gift card']);
  });

  test('no prize list means everybody wins the titled prize', () => {
    expect(prizesForWinners(null, 2, 'A prize')).toEqual(['A prize', 'A prize']);
  });

  // The winner count is what the host promised in public; it wins over a short prize list.
  test('fewer prizes than winners falls back rather than handing somebody undefined', () => {
    const prizes = [{ label: 'Nitro', count: 1 }];

    expect(prizesForWinners(prizes, 3, 'A prize')).toEqual(['Nitro', 'A prize', 'A prize']);
  });

  test('more prizes than winners simply goes unused', () => {
    const prizes = [{ label: 'Nitro', count: 5 }];

    expect(prizesForWinners(prizes, 2, 'A prize')).toEqual(['Nitro', 'Nitro']);
  });

  test('a single single-count prize reads as itself', () => {
    expect(describePrizes([{ label: 'Nitro', count: 1 }], 'x')).toBe('Nitro');
  });

  test('a mixed list reads with counts', () => {
    const prizes = [
      { label: 'Nitro', count: 1 },
      { label: 'Gift card', count: 2 },
    ];

    expect(describePrizes(prizes, 'x')).toBe('1× Nitro, 2× Gift card');
  });

  test('an absent list falls back to the title', () => {
    expect(describePrizes(null, 'A prize')).toBe('A prize');
  });

  test('counts total across the list', () => {
    expect(
      totalPrizeCount([
        { label: 'a', count: 2 },
        { label: 'b', count: 3 },
      ]),
    ).toBe(5);
    expect(totalPrizeCount(null)).toBe(0);
  });

  test('an empty list is refused by the schema', () => {
    expect(prizeListSchema.safeParse([]).success).toBe(false);
  });

  test('a malformed stored list parses to null rather than throwing', () => {
    expect(parsePrizes({ nonsense: true })).toBeNull();
    expect(parsePrizes(null)).toBeNull();
  });
});

describe('the recurrence schema', () => {
  test('an interval with a run count is valid', () => {
    expect(recurrenceSchema.safeParse({ everyMs: DAY, runs: 4 }).success).toBe(true);
  });

  test('an interval with an end date is valid', () => {
    expect(recurrenceSchema.safeParse({ everyMs: DAY, until: NOW.getTime() }).success).toBe(true);
  });

  // A recurrence with neither bound runs forever, which is exactly what §87 warns against.
  test('an unbounded recurrence is refused', () => {
    expect(recurrenceSchema.safeParse({ everyMs: DAY }).success).toBe(false);
  });

  test('an interval under an hour is refused', () => {
    expect(recurrenceSchema.safeParse({ everyMs: 60_000, runs: 2 }).success).toBe(false);
  });

  test('a malformed stored recurrence parses to null', () => {
    expect(parseRecurrence({ everyMs: 'soon' })).toBeNull();
  });
});

describe('working out the next run', () => {
  test('the next run starts one interval after this one ended', () => {
    const next = nextRun({ everyMs: DAY, runs: 3 }, 3, NOW, 2 * HOUR);

    expect(next?.startsAt.getTime()).toBe(NOW.getTime() + DAY);
    expect(next?.endsAt.getTime()).toBe(NOW.getTime() + DAY + 2 * HOUR);
  });

  test('the run count decrements', () => {
    expect(nextRun({ everyMs: DAY, runs: 3 }, 3, NOW, HOUR)?.runsLeft).toBe(2);
  });

  test('the last run schedules nothing', () => {
    expect(nextRun({ everyMs: DAY, runs: 3 }, 1, NOW, HOUR)).toBeNull();
  });

  test('a run past the end date schedules nothing', () => {
    const until = NOW.getTime() + HOUR;

    expect(nextRun({ everyMs: DAY, until }, null, NOW, HOUR)).toBeNull();
  });

  test('a run inside the end date still schedules', () => {
    const until = NOW.getTime() + 10 * DAY;

    expect(nextRun({ everyMs: DAY, until }, null, NOW, HOUR)).not.toBeNull();
  });
});

describe('chaining the next instance', () => {
  function harness() {
    const scheduled: { jobId: string; runAt: Date }[] = [];

    const ctx = {
      guildId: GUILD,
      config: { ...giveawaysConfigSchema.parse({}), enabled: true },
      tier: 'free',
      executor: {
        async execute() {
          return { status: 'executed' };
        },
      },
      logger: { info() {}, warn() {}, error() {} },
      async schedule(jobId: string, runAt: Date) {
        scheduled.push({ jobId, runAt });
        return { scheduled: true, replaced: false };
      },
    } as unknown as ModuleContext<GiveawaysConfig>;

    return { ctx, scheduled };
  }

  async function ended(over: Partial<CreateGiveawayInput> = {}) {
    const store = new MemoryGiveawayStore();

    await store.create({
      id: 'g1',
      guildId: GUILD,
      channelId: '500000000000000000',
      messageId: '700000000000000000',
      hostId: HOST,
      title: 'Weekly Nitro',
      winnerCount: 2,
      startsAt: new Date(NOW.getTime() - 2 * HOUR),
      endsAt: NOW,
      createdBy: HOST,
      ...over,
    } satisfies CreateGiveawayInput);

    await store.finishDraw(GUILD, 'g1', ['running'], 'ended', NOW);

    const giveaway = await store.get(GUILD, 'g1');
    if (!giveaway) throw new Error('seed failed');

    return { store, giveaway };
  }

  test('a non-recurring giveaway chains nothing', async () => {
    const { store, giveaway } = await ended();
    const h = harness();

    expect((await scheduleNextRun(h.ctx, store, giveaway, 'start', NOW)).outcome).toBe(
      'not-recurring',
    );
    expect(h.scheduled).toHaveLength(0);
  });

  test('a recurring giveaway creates exactly one successor', async () => {
    const { store, giveaway } = await ended({
      recurrenceConfig: { everyMs: DAY, runs: 3 },
      recurrenceLeft: 3,
    });
    const h = harness();

    const outcome = await scheduleNextRun(h.ctx, store, giveaway, 'start', NOW);

    expect(outcome.outcome).toBe('scheduled');
    expect(store.giveaways.size).toBe(2);
    expect(h.scheduled).toHaveLength(1);
  });

  test('the successor is scheduled, not running, so nobody enters early', async () => {
    const { store, giveaway } = await ended({
      recurrenceConfig: { everyMs: DAY, runs: 3 },
      recurrenceLeft: 3,
    });

    const outcome = await scheduleNextRun(harness().ctx, store, giveaway, 'start', NOW);
    if (outcome.outcome !== 'scheduled') throw new Error('expected a successor');

    expect(outcome.giveaway.status).toBe('scheduled');
    expect(outcome.giveaway.startsAt?.getTime()).toBe(NOW.getTime() + DAY);
  });

  test('the successor carries the rules and prizes forward', async () => {
    const tree = { kind: 'group', logic: 'all', children: [] };

    const { store, giveaway } = await ended({
      recurrenceConfig: { everyMs: DAY, runs: 3 },
      recurrenceLeft: 3,
      requirementTree: tree,
      prizes: [{ label: 'Nitro', count: 2 }],
      rewardRoleId: '600000000000000001',
    });

    const outcome = await scheduleNextRun(harness().ctx, store, giveaway, 'start', NOW);
    if (outcome.outcome !== 'scheduled') throw new Error('expected a successor');

    expect(outcome.giveaway.requirementTree).toEqual(tree);
    expect(outcome.giveaway.prizes).toEqual([{ label: 'Nitro', count: 2 }]);
    expect(outcome.giveaway.rewardRoleId).toBe('600000000000000001');
    expect(outcome.giveaway.winnerCount).toBe(2);
  });

  // The chain stops on its own rather than relying on anything remembering to stop it.
  test('the run count decrements down the chain and then stops', async () => {
    const store = new MemoryGiveawayStore();
    const h = harness();

    let current = await store.create({
      id: 'g1',
      guildId: GUILD,
      channelId: '500000000000000000',
      messageId: null,
      hostId: HOST,
      title: 'Weekly',
      winnerCount: 1,
      startsAt: new Date(NOW.getTime() - HOUR),
      endsAt: NOW,
      createdBy: HOST,
      recurrenceConfig: { everyMs: DAY, runs: 3 },
      recurrenceLeft: 3,
    });

    const seen: (number | null)[] = [];

    for (let round = 0; round < 5; round += 1) {
      await store.finishDraw(GUILD, current.id, ['running', 'scheduled'], 'ended', NOW);
      const row = await store.get(GUILD, current.id);
      if (!row) break;

      const outcome = await scheduleNextRun(h.ctx, store, row, 'start', NOW);
      if (outcome.outcome !== 'scheduled') break;

      seen.push(outcome.giveaway.recurrenceLeft);
      current = outcome.giveaway;
    }

    expect(seen).toEqual([2, 1]);
    expect(store.giveaways.size).toBe(3);
  });

  test('a chain bounded by a date stops once it passes', async () => {
    const { store, giveaway } = await ended({
      recurrenceConfig: { everyMs: DAY, until: NOW.getTime() + HOUR },
    });

    expect((await scheduleNextRun(harness().ctx, store, giveaway, 'start', NOW)).outcome).toBe(
      'finished',
    );
  });
});
