import { describe, expect, test } from 'bun:test';
import { ProviderRegistry } from '@proton/core';
import { cancelGiveaway, type DrawDeps, drawGiveaway } from '../src/end.ts';
import { rerollGiveaway } from '../src/reroll.ts';
import type { CreateGiveawayInput } from '../src/store.ts';
import { MemoryGiveawayStore } from './memory-store.ts';

const GUILD = '100000000000000000';
const OTHER = '900000000000000000';
const NOW = new Date('2026-08-25T12:00:00.000Z');
const SEED = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';

function userId(index: number): string {
  return String(400000000000000000n + BigInt(index));
}

async function seeded(options: { entrants: number; winnerCount?: number } = { entrants: 4 }) {
  const store = new MemoryGiveawayStore();

  const giveaway = await store.create({
    id: 'g1',
    guildId: GUILD,
    channelId: '500000000000000000',
    messageId: '700000000000000000',
    hostId: userId(0),
    title: 'A prize',
    winnerCount: options.winnerCount ?? 1,
    endsAt: new Date(NOW.getTime() + 60_000),
    createdBy: userId(0),
    verifyOn: 'join',
  } satisfies CreateGiveawayInput);

  for (let index = 1; index <= options.entrants; index += 1) {
    await store.enter({
      giveawayId: giveaway.id,
      userId: userId(index),
      baseEntries: 1,
      totalEntries: 1,
      breakdown: [],
      memberSnapshot: null,
    });
  }

  return { store, giveaway };
}

function deps(store: MemoryGiveawayStore, extra: Partial<DrawDeps> = {}): DrawDeps {
  return {
    store,
    providers: new ProviderRegistry(),
    now: () => NOW.getTime(),
    seed: () => SEED,
    ...extra,
  };
}

describe('cancel is not end', () => {
  test('cancelling a running giveaway draws nobody', async () => {
    const { store } = await seeded();

    const outcome = await cancelGiveaway(deps(store), GUILD, 'g1');

    expect(outcome.outcome).toBe('cancelled');
    expect((await store.get(GUILD, 'g1'))?.status).toBe('cancelled');
    expect(store.drawRows).toHaveLength(0);
  });

  // The read-then-write version told the host "nobody was drawn" while the draw it lost to was
  // announcing winners.
  test('a cancel that loses to an in-flight draw reports the draw, not a cancellation', async () => {
    const { store } = await seeded();
    await store.beginDraw(GUILD, 'g1', NOW);

    const outcome = await cancelGiveaway(deps(store), GUILD, 'g1');

    expect(outcome.outcome).toBe('already-ended');
    expect((await store.get(GUILD, 'g1'))?.status).toBe('drawing');
  });

  test('cancelling twice is safe and the second is a no-op', async () => {
    const { store } = await seeded();

    await cancelGiveaway(deps(store), GUILD, 'g1');
    const second = await cancelGiveaway(deps(store), GUILD, 'g1');

    expect(second.outcome).toBe('already-ended');
  });

  test('a cancelled giveaway is never drawn by a scheduled end that fires afterwards', async () => {
    const { store } = await seeded();
    await cancelGiveaway(deps(store), GUILD, 'g1');

    const drawn = await drawGiveaway(deps(store), {
      guildId: GUILD,
      giveawayId: 'g1',
      drawnBy: 'proton:schedule',
    });

    expect(drawn.outcome).toBe('already-ended');
    expect(store.drawRows).toHaveLength(0);
  });

  test('a giveaway in another guild cannot be cancelled', async () => {
    const { store } = await seeded();

    expect((await cancelGiveaway(deps(store), OTHER, 'g1')).outcome).toBe('missing');
    expect((await store.get(GUILD, 'g1'))?.status).toBe('running');
  });
});

describe('reroll refuses anything that is not ended', () => {
  async function ended() {
    const seed = await seeded({ entrants: 4, winnerCount: 1 });
    await drawGiveaway(deps(seed.store), { guildId: GUILD, giveawayId: 'g1', drawnBy: 'host' });
    return seed;
  }

  // Without the `from` guard on finishDraw a reroll dragged a cancelled giveaway back to running
  // and awarded a prize the host had deliberately withdrawn.
  test('a cancelled giveaway cannot be rerolled back to life', async () => {
    const { store } = await seeded();
    await cancelGiveaway(deps(store), GUILD, 'g1');

    const outcome = await rerollGiveaway(deps(store), {
      guildId: GUILD,
      giveawayId: 'g1',
      drawnBy: 'host',
    });

    expect(outcome.outcome).toBe('cancelled');
    expect((await store.get(GUILD, 'g1'))?.status).toBe('cancelled');
    expect(store.drawRows).toHaveLength(0);
  });

  test('a giveaway still running cannot be rerolled', async () => {
    const { store } = await seeded();

    const outcome = await rerollGiveaway(deps(store), {
      guildId: GUILD,
      giveawayId: 'g1',
      drawnBy: 'host',
    });

    expect(outcome.outcome).toBe('still-running');
    expect((await store.get(GUILD, 'g1'))?.status).toBe('running');
  });

  // Yanking a giveaway out of `drawing` let a second draw run beside the first, and both wrote
  // winners for the same prize.
  test('a giveaway mid-draw cannot be yanked back to running', async () => {
    const { store } = await seeded();
    await store.beginDraw(GUILD, 'g1', NOW);

    const outcome = await rerollGiveaway(deps(store), {
      guildId: GUILD,
      giveawayId: 'g1',
      drawnBy: 'host',
    });

    expect(outcome.outcome).toBe('still-running');
    expect((await store.get(GUILD, 'g1'))?.status).toBe('drawing');
  });

  test('an ended giveaway rerolls, and lands back on ended', async () => {
    const { store } = await ended();

    const outcome = await rerollGiveaway(deps(store), {
      guildId: GUILD,
      giveawayId: 'g1',
      drawnBy: 'host',
    });

    expect(outcome.outcome).toBe('rerolled');
    expect((await store.get(GUILD, 'g1'))?.status).toBe('ended');
    expect(store.drawRows).toHaveLength(2);
  });
});

describe('reroll winner bookkeeping', () => {
  async function drawnOnce() {
    const seed = await seeded({ entrants: 4, winnerCount: 1 });
    await drawGiveaway(deps(seed.store), { guildId: GUILD, giveawayId: 'g1', drawnBy: 'host' });
    return seed;
  }

  test('a rerolled winner is never drawn again', async () => {
    const { store } = await drawnOnce();
    const first = store.drawRows[0]?.winnerIds ?? [];

    const outcome = await rerollGiveaway(deps(store), {
      guildId: GUILD,
      giveawayId: 'g1',
      drawnBy: 'host',
    });

    expect(outcome.outcome).toBe('rerolled');
    if (outcome.outcome !== 'rerolled') return;

    expect(outcome.summary.winnerIds).not.toEqual(first);
    for (const winner of first) expect(outcome.summary.winnerIds).not.toContain(winner);
  });

  // The exclusion used to filter on rerolled_at, which nothing ever wrote. Now that it is written,
  // a superseded winner must still stay excluded rather than becoming eligible again.
  test('every past winner stays excluded across repeated rerolls', async () => {
    const { store } = await drawnOnce();
    const seen = new Set(store.drawRows[0]?.winnerIds ?? []);

    for (let round = 0; round < 3; round += 1) {
      const outcome = await rerollGiveaway(deps(store), {
        guildId: GUILD,
        giveawayId: 'g1',
        drawnBy: 'host',
      });

      if (outcome.outcome !== 'rerolled') break;

      for (const winner of outcome.summary.winnerIds) {
        expect(seen.has(winner)).toBe(false);
        seen.add(winner);
      }
    }

    expect(seen.size).toBe(4);
  });

  test('a superseded win is stamped so the history shows who was replaced', async () => {
    const { store } = await drawnOnce();

    expect(store.winRows.every((win) => win.rerolledAt === null)).toBe(true);

    await rerollGiveaway(deps(store), { guildId: GUILD, giveawayId: 'g1', drawnBy: 'host' });

    const firstDraw = store.drawRows[0];
    const replaced = store.winRows.filter((win) => win.drawId === firstDraw?.id);
    const fresh = store.winRows.filter((win) => win.drawId !== firstDraw?.id);

    expect(replaced.every((win) => win.rerolledAt !== null)).toBe(true);
    expect(fresh.every((win) => win.rerolledAt === null)).toBe(true);
  });

  test('allow-repeat puts the previous winners back in the pool', async () => {
    const { store } = await drawnOnce();

    const outcome = await rerollGiveaway(deps(store), {
      guildId: GUILD,
      giveawayId: 'g1',
      drawnBy: 'host',
      allowRepeat: true,
    });

    expect(outcome.outcome).toBe('rerolled');
    if (outcome.outcome !== 'rerolled') return;

    expect(outcome.summary.entrantCount).toBe(4);
  });

  test('a reroll with nobody left reports it rather than stamping a replacement', async () => {
    const { store } = await seeded({ entrants: 1, winnerCount: 1 });
    await drawGiveaway(deps(store), { guildId: GUILD, giveawayId: 'g1', drawnBy: 'host' });

    const outcome = await rerollGiveaway(deps(store), {
      guildId: GUILD,
      giveawayId: 'g1',
      drawnBy: 'host',
    });

    expect(outcome.outcome).toBe('nobody-left');
    expect(store.winRows.every((win) => win.rerolledAt === null)).toBe(true);
  });
});

describe('entry is refused once a giveaway stops running', () => {
  test.each([
    ['cancelled', 'cancelled'],
    ['ended', 'ended'],
    ['paused', 'paused'],
    ['scheduled', 'scheduled'],
  ] as const)('a %s giveaway refuses the insert', async (_label, status) => {
    const { store } = await seeded({ entrants: 0 });
    await store.finishDraw(GUILD, 'g1', ['running'], status, null);

    const outcome = await store.enter({
      giveawayId: 'g1',
      userId: userId(99),
      baseEntries: 1,
      totalEntries: 1,
      breakdown: [],
      memberSnapshot: null,
    });

    expect(outcome).toBe('closed');
    expect(await store.entrantCount('g1')).toBe(0);
  });

  test('a running giveaway still accepts entries', async () => {
    const { store } = await seeded({ entrants: 0 });

    expect(
      await store.enter({
        giveawayId: 'g1',
        userId: userId(99),
        baseEntries: 1,
        totalEntries: 1,
        breakdown: [],
        memberSnapshot: null,
      }),
    ).toBe('entered');
  });
});

describe('claim deadlines', () => {
  async function withClaimWindow(seconds: number) {
    const store = new MemoryGiveawayStore();

    await store.create({
      id: 'g1',
      guildId: GUILD,
      channelId: '500000000000000000',
      messageId: '700000000000000000',
      hostId: userId(0),
      title: 'A prize',
      winnerCount: 1,
      endsAt: new Date(NOW.getTime() + 60_000),
      createdBy: userId(0),
      claimWindowSeconds: seconds,
      verifyOn: 'join',
    } satisfies CreateGiveawayInput);

    await store.enter({
      giveawayId: 'g1',
      userId: userId(1),
      baseEntries: 1,
      totalEntries: 1,
      breakdown: [],
      memberSnapshot: null,
    });

    const drawn = await drawGiveaway(deps(store), {
      guildId: GUILD,
      giveawayId: 'g1',
      drawnBy: 'host',
    });

    if (drawn.outcome !== 'drawn') throw new Error('expected a draw');
    return { store, drawId: drawn.summary.drawId, winner: drawn.summary.winnerIds[0] as string };
  }

  test('a winner inside the window claims', async () => {
    const { store, drawId, winner } = await withClaimWindow(3600);

    expect(await store.claim(drawId, winner, new Date(NOW.getTime() + 60_000))).toBe(true);
  });

  // The expiry sweep runs on an interval, so without the predicate a winner could still claim in
  // the gap after their window closed.
  test('a winner past the deadline is refused even before the sweep runs', async () => {
    const { store, drawId, winner } = await withClaimWindow(3600);

    const late = new Date(NOW.getTime() + 3600 * 1000 + 1);

    expect(await store.claim(drawId, winner, late)).toBe(false);
    expect(store.winRows[0]?.claimedAt).toBeNull();
  });

  test('a forfeited win cannot be claimed afterwards', async () => {
    const { store, drawId, winner } = await withClaimWindow(3600);
    await store.forfeit(drawId, [winner], new Date(NOW.getTime() + 10_000));

    expect(await store.claim(drawId, winner, new Date(NOW.getTime() + 20_000))).toBe(false);
  });

  test('claiming twice does not double count', async () => {
    const { store, drawId, winner } = await withClaimWindow(3600);
    const at = new Date(NOW.getTime() + 60_000);

    expect(await store.claim(drawId, winner, at)).toBe(true);
    expect(await store.claim(drawId, winner, at)).toBe(false);
  });
});
