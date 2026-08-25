import { describe, expect, test } from 'bun:test';
import { ProviderRegistry } from '@proton/core';
import { type DrawDeps, drawGiveaway } from '../src/end.ts';
import { join } from '../src/entry.ts';
import type { CreateGiveawayInput } from '../src/store.ts';
import { MemoryGiveawayStore } from './memory-store.ts';

const GUILD = '100000000000000000';
const HOST = '400000000000000001';
const NOW = new Date('2026-08-25T12:00:00.000Z');
const SEED = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';

function userId(index: number): string {
  return String(400000000000000100n + BigInt(index));
}

function memberContext(id: string) {
  return {
    guildId: GUILD,
    userId: id,
    member: {
      joinedAt: new Date('2024-01-01T00:00:00.000Z'),
      roleIds: [],
      premiumSince: null,
      communicationDisabledUntil: null,
    },
    user: { createdAt: new Date('2020-01-01T00:00:00.000Z'), hasAvatar: true, bot: false },
    tier: 'free' as const,
    now: NOW,
  };
}

async function seeded(entrants: number, over: Partial<CreateGiveawayInput> = {}) {
  const store = new MemoryGiveawayStore();

  await store.create({
    id: 'g1',
    guildId: GUILD,
    channelId: '500000000000000000',
    messageId: '700000000000000000',
    hostId: HOST,
    title: 'A prize',
    winnerCount: 1,
    endsAt: new Date(NOW.getTime() + 60_000),
    createdBy: HOST,
    verifyOn: 'both',
    ...over,
  } satisfies CreateGiveawayInput);

  for (let index = 1; index <= entrants; index += 1) {
    await store.enter({
      giveawayId: 'g1',
      userId: userId(index),
      baseEntries: 1,
      totalEntries: 1,
      breakdown: [],
      memberSnapshot: { roleIds: [], joinedAt: null, premiumSince: null, hasAvatar: true },
    });
  }

  return store;
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

async function grant(store: MemoryGiveawayStore, user: string, amount: number, reason = 'event') {
  return store.grantBonus({
    id: `b-${user}-${amount}`,
    giveawayId: 'g1',
    userId: user,
    amount,
    reason,
    grantedBy: HOST,
  });
}

describe('granting extra entries', () => {
  test('a grant raises the member’s weight immediately', async () => {
    const store = await seeded(3);
    await grant(store, userId(1), 5);

    expect((await store.entry('g1', userId(1)))?.totalEntries).toBe(6);
    expect((await store.entry('g1', userId(2)))?.totalEntries).toBe(1);
  });

  test('the reason and the granter are kept on the record', async () => {
    const store = await seeded(1);
    await grant(store, userId(1), 3, 'ran the tournament');

    const [row] = await store.bonusGrants('g1', userId(1));

    expect(row?.amount).toBe(3);
    expect(row?.reason).toBe('ran the tournament');
    expect(row?.grantedBy).toBe(HOST);
    expect(row?.revokedAt).toBeNull();
  });

  test('two grants to one member stack', async () => {
    const store = await seeded(1);
    await grant(store, userId(1), 2);
    await grant(store, userId(1), 3);

    expect(await store.bonusFor('g1', userId(1))).toBe(5);
    expect((await store.entry('g1', userId(1)))?.totalEntries).toBe(6);
  });

  test('revoking takes the entries back and stamps who did it', async () => {
    const store = await seeded(1);
    await grant(store, userId(1), 4);

    expect(await store.revokeBonus('g1', userId(1), HOST, NOW)).toBe(4);
    expect((await store.entry('g1', userId(1)))?.totalEntries).toBe(1);
    expect(await store.bonusFor('g1', userId(1))).toBe(0);

    const [row] = await store.bonusGrants('g1', userId(1));
    expect(row?.revokedBy).toBe(HOST);
  });

  test('revoking twice takes nothing back the second time', async () => {
    const store = await seeded(1);
    await grant(store, userId(1), 4);

    await store.revokeBonus('g1', userId(1), HOST, NOW);

    expect(await store.revokeBonus('g1', userId(1), HOST, NOW)).toBe(0);
    expect((await store.entry('g1', userId(1)))?.totalEntries).toBe(1);
  });

  test('revoking never drops a qualifying member below one entry', async () => {
    const store = await seeded(1);
    await grant(store, userId(1), 50);
    await store.revokeBonus('g1', userId(1), HOST, NOW);

    expect((await store.entry('g1', userId(1)))?.totalEntries).toBe(1);
  });
});

describe('a bonus granted before the member enters', () => {
  test('is applied when they join', async () => {
    const store = await seeded(0);
    const newcomer = userId(50);

    await grant(store, newcomer, 7);

    const outcome = await join(
      { store, providers: new ProviderRegistry() },
      {
        giveaway: (await store.get(GUILD, 'g1')) as NonNullable<
          Awaited<ReturnType<typeof store.get>>
        >,
        ctx: memberContext(newcomer),
        requirements: [],
        multipliers: [],
        blacklist: [],
      },
    );

    expect(outcome.outcome).toBe('entered');
    if (outcome.outcome !== 'entered') return;

    expect(outcome.totalEntries).toBe(8);
    expect(outcome.breakdown.join(' ')).toContain('granted by staff');
  });

  test('does not silently enter somebody who never pressed the button', async () => {
    const store = await seeded(0);
    await grant(store, userId(50), 7);

    expect(await store.entrantCount('g1')).toBe(0);
  });
});

describe('a grant survives the draw', () => {
  // reweigh used to overwrite total_entries with the recomputed figure, erasing a manual grant at
  // the one moment it has to count.
  test('draw-time revalidation keeps the bonus', async () => {
    const store = await seeded(3);
    await grant(store, userId(1), 9);

    await drawGiveaway(deps(store), { guildId: GUILD, giveawayId: 'g1', drawnBy: HOST });

    expect((await store.entry('g1', userId(1)))?.totalEntries).toBe(10);
  });

  test('the drawn snapshot counts the bonus in its total', async () => {
    const store = await seeded(3);
    await grant(store, userId(1), 9);

    const drawn = await drawGiveaway(deps(store), {
      guildId: GUILD,
      giveawayId: 'g1',
      drawnBy: HOST,
    });

    expect(drawn.outcome).toBe('drawn');
    if (drawn.outcome !== 'drawn') return;

    // 3 entrants at 1 each, one of them carrying +9.
    expect(drawn.summary.totalEntries).toBe(12);
    expect(drawn.summary.entrantCount).toBe(3);
  });

  test('a revoked grant does not survive the draw', async () => {
    const store = await seeded(3);
    await grant(store, userId(1), 9);
    await store.revokeBonus('g1', userId(1), HOST, NOW);

    await drawGiveaway(deps(store), { guildId: GUILD, giveawayId: 'g1', drawnBy: HOST });

    expect((await store.entry('g1', userId(1)))?.totalEntries).toBe(1);
  });

  test('a heavy bonus makes that member overwhelmingly likely to win', async () => {
    const store = await seeded(3);
    await grant(store, userId(1), 500);

    const drawn = await drawGiveaway(deps(store), {
      guildId: GUILD,
      giveawayId: 'g1',
      drawnBy: HOST,
    });

    expect(drawn.outcome).toBe('drawn');
    if (drawn.outcome !== 'drawn') return;

    expect(drawn.summary.winnerIds).toEqual([userId(1)]);
  });
});

describe('leaving a giveaway', () => {
  test('a leaver drops out of the count and out of the draw', async () => {
    const store = await seeded(3);

    expect(await store.leave('g1', userId(2), NOW)).toBe(true);
    expect(await store.entrantCount('g1')).toBe(2);

    const drawn = await drawGiveaway(deps(store), {
      guildId: GUILD,
      giveawayId: 'g1',
      drawnBy: HOST,
      winnerCount: 3,
    });

    if (drawn.outcome !== 'drawn') return;
    expect(drawn.summary.winnerIds).not.toContain(userId(2));
  });

  test('leaving is soft, so the entry history stays honest', async () => {
    const store = await seeded(3);
    await store.leave('g1', userId(2), NOW);

    expect(store.entries.some((row) => row.userId === userId(2))).toBe(true);
  });

  test('leaving twice reports nothing left to do', async () => {
    const store = await seeded(3);

    expect(await store.leave('g1', userId(2), NOW)).toBe(true);
    expect(await store.leave('g1', userId(2), NOW)).toBe(false);
  });

  test('somebody who never entered cannot leave', async () => {
    const store = await seeded(3);

    expect(await store.leave('g1', userId(99), NOW)).toBe(false);
  });
});
