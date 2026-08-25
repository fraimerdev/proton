import { describe, expect, test } from 'bun:test';
import { ProviderRegistry } from '@proton/core';
import { renderCard } from '../src/embed.ts';
import { drawGiveaway } from '../src/end.ts';
import { viewOf } from '../src/message.ts';
import type { CreateGiveawayInput } from '../src/store.ts';
import { MemoryGiveawayStore } from './memory-store.ts';

const GUILD = '100000000000000000';
const OTHER = '900000000000000000';
const HOST = '400000000000000001';
const NOW = new Date('2026-08-25T12:00:00.000Z');

function userId(index: number): string {
  return String(400000000000003000n + BigInt(index));
}

async function dropped(over: Partial<CreateGiveawayInput> = {}) {
  const store = new MemoryGiveawayStore();

  await store.create({
    id: 'd1',
    guildId: GUILD,
    channelId: '500000000000000000',
    messageId: '700000000000000000',
    hostId: HOST,
    title: 'A gift card',
    winnerCount: 1,
    entryMethod: 'drop',
    endsAt: new Date(NOW.getTime() + 24 * 60 * 60 * 1000),
    createdBy: HOST,
    ...over,
  } satisfies CreateGiveawayInput);

  return store;
}

describe('claiming a drop', () => {
  test('the first presser wins it outright', async () => {
    const store = await dropped();

    const outcome = await store.claimDrop(GUILD, 'd1', userId(1), NOW);

    expect(outcome.outcome).toBe('won');
    expect((await store.get(GUILD, 'd1'))?.status).toBe('ended');
  });

  test('the win is recorded like any other result', async () => {
    const store = await dropped();
    await store.claimDrop(GUILD, 'd1', userId(1), NOW);

    expect(store.drawRows).toHaveLength(1);
    expect(store.drawRows[0]?.winnerIds).toEqual([userId(1)]);
    expect(store.winRows[0]?.userId).toBe(userId(1));
  });

  // The status flip is the race. Two hundred presses land here and exactly one may win.
  test('two hundred simultaneous presses produce exactly one winner', async () => {
    const store = await dropped();

    const results = await Promise.all(
      Array.from({ length: 200 }, (_, index) => store.claimDrop(GUILD, 'd1', userId(index), NOW)),
    );

    expect(results.filter((row) => row.outcome === 'won')).toHaveLength(1);
    expect(results.filter((row) => row.outcome === 'taken')).toHaveLength(199);
    expect(store.winRows).toHaveLength(1);
  });

  test('a second press after the win is told somebody was faster', async () => {
    const store = await dropped();
    await store.claimDrop(GUILD, 'd1', userId(1), NOW);

    expect((await store.claimDrop(GUILD, 'd1', userId(2), NOW)).outcome).toBe('taken');
  });

  test('a drop in another guild cannot be claimed', async () => {
    const store = await dropped();

    expect((await store.claimDrop(OTHER, 'd1', userId(1), NOW)).outcome).toBe('closed');
    expect((await store.get(GUILD, 'd1'))?.status).toBe('running');
  });

  test('a giveaway that is not a drop refuses the drop path', async () => {
    const store = await dropped({ entryMethod: 'button' });

    expect((await store.claimDrop(GUILD, 'd1', userId(1), NOW)).outcome).toBe('taken');
    expect(store.winRows).toHaveLength(0);
  });

  test('a paused drop cannot be claimed', async () => {
    const store = await dropped();
    await store.pause(GUILD, 'd1', HOST, null, NOW);

    expect((await store.claimDrop(GUILD, 'd1', userId(1), NOW)).outcome).toBe('taken');
  });

  test('a cancelled drop cannot be claimed', async () => {
    const store = await dropped();
    await store.finishDraw(GUILD, 'd1', ['running'], 'cancelled', NOW);

    expect((await store.claimDrop(GUILD, 'd1', userId(1), NOW)).outcome).toBe('taken');
  });
});

describe('an unclaimed drop', () => {
  // ends_at is not a countdown anybody watches — it is when an unclaimed drop gives up, and the
  // ordinary end job is what collects it.
  test('is drawn with nobody, because nobody ever entered', async () => {
    const store = await dropped();

    const drawn = await drawGiveaway(
      { store, providers: new ProviderRegistry(), now: () => NOW.getTime() },
      { guildId: GUILD, giveawayId: 'd1', drawnBy: 'proton:schedule' },
    );

    expect(drawn.outcome).toBe('drawn');
    if (drawn.outcome !== 'drawn') return;

    expect(drawn.summary.winnerIds).toEqual([]);
    expect(drawn.summary.entrantCount).toBe(0);
  });

  test('a claimed drop is already ended, so the end job draws nothing more', async () => {
    const store = await dropped();
    await store.claimDrop(GUILD, 'd1', userId(1), NOW);

    const drawn = await drawGiveaway(
      { store, providers: new ProviderRegistry(), now: () => NOW.getTime() },
      { guildId: GUILD, giveawayId: 'd1', drawnBy: 'proton:schedule' },
    );

    expect(drawn.outcome).toBe('already-ended');
    expect(store.drawRows).toHaveLength(1);
  });
});

describe('the drop card', () => {
  async function card() {
    const store = await dropped();
    const giveaway = await store.get(GUILD, 'd1');
    if (!giveaway) throw new Error('seed failed');

    const rendered = renderCard('drop', {
      view: viewOf(giveaway),
      entrantCount: 0,
      requirements: ['Account older than 30 days'],
      multipliers: [],
      accentColor: 0x5865f2,
    });

    if (!rendered.ok) throw new Error(rendered.humanReason);
    return JSON.stringify(rendered.components);
  }

  test('says it is a drop and how it is won', async () => {
    const text = await card();

    expect(text).toContain('DROP');
    expect(text).toContain('First eligible member');
  });

  // A drop has no deadline anybody counts down to and nobody is entered, so showing either would
  // be inventing information.
  test('shows no countdown and no entry count', async () => {
    const text = await card();

    expect(text).not.toContain(':R>');
    expect(text).not.toContain('Entries');
  });

  test('still shows the requirements, because they decide who may press it', async () => {
    expect(await card()).toContain('Account older than 30 days');
  });
});
