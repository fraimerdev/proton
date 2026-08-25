import { describe, expect, test } from 'bun:test';
import { ProviderRegistry } from '@proton/core';
import { drawGiveaway } from '../src/end.ts';
import { ENTRANT_PAGE_SIZE, entrantPage, exportEntrants, renderStats } from '../src/reports.ts';
import type { CreateGiveawayInput } from '../src/store.ts';
import { MemoryGiveawayStore } from './memory-store.ts';

const GUILD = '100000000000000000';
const OTHER = '900000000000000000';
const HOST = '400000000000000001';
const NOW = new Date('2026-08-25T12:00:00.000Z');

function userId(index: number): string {
  return String(400000000000001000n + BigInt(index));
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
    verifyOn: 'join',
    ...over,
  } satisfies CreateGiveawayInput);

  for (let index = 1; index <= entrants; index += 1) {
    await store.enter({
      giveawayId: 'g1',
      userId: userId(index),
      baseEntries: 1,
      totalEntries: index,
      breakdown: [],
      memberSnapshot: null,
    });
  }

  return store;
}

describe('paging entrants', () => {
  test('the first page holds one page worth', async () => {
    const store = await seeded(50);
    const page = await entrantPage(store, 'g1', 1);

    expect(page.rows).toHaveLength(ENTRANT_PAGE_SIZE);
    expect(page.total).toBe(50);
    expect(page.pages).toBe(3);
  });

  test('the last page holds the remainder', async () => {
    const store = await seeded(50);
    const page = await entrantPage(store, 'g1', 3);

    expect(page.rows).toHaveLength(10);
    expect(page.page).toBe(3);
  });

  test('pages do not overlap', async () => {
    const store = await seeded(50);

    const first = await entrantPage(store, 'g1', 1);
    const second = await entrantPage(store, 'g1', 2);

    const overlap = first.rows.filter((row) =>
      second.rows.some((other) => other.userId === row.userId),
    );

    expect(overlap).toHaveLength(0);
  });

  test('a page past the end clamps to the last one rather than showing nothing', async () => {
    const store = await seeded(5);
    const page = await entrantPage(store, 'g1', 99);

    expect(page.page).toBe(1);
    expect(page.rows).toHaveLength(5);
  });

  test('page zero clamps to the first', async () => {
    const store = await seeded(5);

    expect((await entrantPage(store, 'g1', 0)).page).toBe(1);
  });

  test('an empty giveaway reports one empty page', async () => {
    const store = await seeded(0);
    const page = await entrantPage(store, 'g1', 1);

    expect(page.rows).toHaveLength(0);
    expect(page.total).toBe(0);
    expect(page.pages).toBe(1);
  });

  // The page a host is shown and the pool the draw reads must be the same list.
  test('a leaver is absent from the page and from the count', async () => {
    const store = await seeded(5);
    await store.leave('g1', userId(2), NOW);

    const page = await entrantPage(store, 'g1', 1);

    expect(page.total).toBe(4);
    expect(page.rows.some((row) => row.userId === userId(2))).toBe(false);
  });
});

describe('exporting entrants', () => {
  test('the CSV has a header and one row per entrant', async () => {
    const store = await seeded(3);
    const exported = await exportEntrants(store, 'g1');

    const lines = exported.csv.trim().split('\n');

    expect(lines[0]).toBe('user_id,effective_entries,joined_via_snapshot');
    expect(lines).toHaveLength(4);
    expect(exported.rows).toBe(3);
    expect(exported.truncated).toBe(false);
  });

  test('the effective weight is what is exported, not the base', async () => {
    const store = await seeded(3);
    const exported = await exportEntrants(store, 'g1');

    expect(exported.csv).toContain(`${userId(3)},3,`);
  });

  test('an empty giveaway exports a header and nothing else', async () => {
    const store = await seeded(0);
    const exported = await exportEntrants(store, 'g1');

    expect(exported.rows).toBe(0);
    expect(exported.csv.trim().split('\n')).toHaveLength(1);
  });

  test('a disqualified entrant is not exported', async () => {
    const store = await seeded(3);
    await store.disqualify('g1', [{ userId: userId(2), reason: 'left' }], NOW);

    const exported = await exportEntrants(store, 'g1');

    expect(exported.rows).toBe(2);
    expect(exported.csv).not.toContain(userId(2));
  });

  test('a value carrying a comma or quote is escaped rather than breaking the row', async () => {
    const store = await seeded(0);
    await store.enter({
      giveawayId: 'g1',
      userId: 'weird,"id',
      baseEntries: 1,
      totalEntries: 1,
      breakdown: [],
      memberSnapshot: null,
    });

    const exported = await exportEntrants(store, 'g1');

    expect(exported.csv).toContain('"weird,""id"');
  });
});

describe('guild statistics', () => {
  async function withHistory() {
    const store = await seeded(4);

    await store.create({
      id: 'g2',
      guildId: GUILD,
      channelId: '500000000000000000',
      messageId: null,
      hostId: HOST,
      title: 'Second',
      winnerCount: 1,
      endsAt: new Date(NOW.getTime() + 60_000),
      createdBy: HOST,
    });

    await store.create({
      id: 'other',
      guildId: OTHER,
      channelId: '500000000000000000',
      messageId: null,
      hostId: HOST,
      title: 'Elsewhere',
      winnerCount: 1,
      endsAt: new Date(NOW.getTime() + 60_000),
      createdBy: HOST,
    });

    await drawGiveaway(
      {
        store,
        providers: new ProviderRegistry(),
        now: () => NOW.getTime(),
        seed: () => 'a'.repeat(32),
      },
      { guildId: GUILD, giveawayId: 'g1', drawnBy: HOST },
    );

    return store;
  }

  test('counts are scoped to the guild that asked', async () => {
    const stats = await (await withHistory()).stats(GUILD);

    expect(stats.totalGiveaways).toBe(2);
  });

  test('statuses are broken out', async () => {
    const stats = await (await withHistory()).stats(GUILD);

    expect(stats.byStatus.ended).toBe(1);
    expect(stats.byStatus.running).toBe(1);
    expect(stats.byStatus.cancelled).toBe(0);
  });

  test('entries and entrants are counted separately', async () => {
    const stats = await (await withHistory()).stats(GUILD);

    expect(stats.uniqueEntrants).toBe(4);
    // Weights 1+2+3+4 — entries are not entrants.
    expect(stats.totalEntries).toBe(10);
  });

  test('winners and draws are counted', async () => {
    const stats = await (await withHistory()).stats(GUILD);

    expect(stats.draws).toBe(1);
    expect(stats.totalWinners).toBe(1);
  });

  test('a guild with no giveaways says so rather than printing zeroes', async () => {
    const store = new MemoryGiveawayStore();

    expect(renderStats(await store.stats(GUILD))).toContain('No giveaways');
  });

  test('the rendering names the totals', async () => {
    const rendered = renderStats(await (await withHistory()).stats(GUILD));

    expect(rendered).toContain('**2** giveaways');
    expect(rendered).toContain('**4** unique entrants');
  });
});
