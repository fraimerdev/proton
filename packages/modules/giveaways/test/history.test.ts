import { describe, expect, test } from 'bun:test';
import { type ModuleContext, ProviderRegistry } from '@proton/core';
import { publishResult } from '../src/announce.ts';
import { handleMessageDeleted } from '../src/cleanup.ts';
import { type GiveawaysConfig, giveawaysConfigSchema } from '../src/config.ts';
import { drawGiveaway } from '../src/end.ts';
import { publishBonus, publishCancelled, publishCreated } from '../src/events.ts';
import {
  editGiveawayFields,
  type ManageDeps,
  pauseGiveaway,
  resumeGiveaway,
  shiftDeadline,
} from '../src/manage.ts';
import { rerollGiveaway } from '../src/reroll.ts';
import type { CreateGiveawayInput } from '../src/store.ts';
import { MemoryGiveawayStore } from './memory-store.ts';

const GUILD = '100000000000000000';
const HOST = '400000000000000001';
const NOW = new Date('2026-08-25T12:00:00.000Z');
const HOUR = 60 * 60 * 1000;

function userId(index: number): string {
  return String(400000000000002000n + BigInt(index));
}

function harness(clock: { now: number }) {
  const published: { type: string; key: string }[] = [];

  const ctx = {
    guildId: GUILD,
    config: { ...giveawaysConfigSchema.parse({}), enabled: true, announceInChannel: false },
    tier: 'free',
    executor: {
      async execute() {
        return { status: 'executed' };
      },
    },
    logger: { info() {}, warn() {}, error() {} },
    async publish(type: string, key: string) {
      published.push({ type, key });
    },
    async schedule() {
      return { scheduled: true, replaced: false };
    },
  } as unknown as ModuleContext<GiveawaysConfig>;

  return { ctx, published, clock };
}

async function seeded(
  clock: { now: number },
  entrants = 3,
  over: Partial<CreateGiveawayInput> = {},
) {
  const store = new MemoryGiveawayStore();

  await store.create({
    id: 'g1',
    guildId: GUILD,
    channelId: '500000000000000000',
    messageId: '700000000000000000',
    hostId: HOST,
    title: 'A prize',
    winnerCount: 1,
    endsAt: new Date(clock.now + 4 * HOUR),
    createdBy: HOST,
    verifyOn: 'join',
    ...over,
  } satisfies CreateGiveawayInput);

  for (let index = 1; index <= entrants; index += 1) {
    await store.enter({
      giveawayId: 'g1',
      userId: userId(index),
      baseEntries: 1,
      totalEntries: 1,
      breakdown: [],
      memberSnapshot: null,
    });
  }

  const deps: ManageDeps = { store, providers: new ProviderRegistry(), now: () => clock.now };
  return { store, deps };
}

async function kinds(store: MemoryGiveawayStore): Promise<string[]> {
  return (await store.history('g1', 100)).map((event) => event.kind);
}

describe('the giveaway timeline', () => {
  test('a lifecycle writes one line per transition, in order', async () => {
    const clock = { now: NOW.getTime() };
    const { store, deps } = await seeded(clock);
    const h = harness(clock);

    const giveaway = await store.get(GUILD, 'g1');
    if (!giveaway) throw new Error('seed failed');

    await publishCreated(h.ctx, store, giveaway, { requirements: 0, multipliers: 0 });
    await pauseGiveaway(h.ctx, deps, { giveawayId: 'g1', by: HOST });

    clock.now += HOUR;
    await resumeGiveaway(h.ctx, deps, { giveawayId: 'g1', by: HOST });
    await shiftDeadline(h.ctx, deps, { giveawayId: 'g1', byMs: HOUR, by: HOST });

    expect(await kinds(store)).toEqual(['created', 'paused', 'resumed', 'extended']);
  });

  test('extend and shorten are distinguishable in the history', async () => {
    const clock = { now: NOW.getTime() };
    const { store, deps } = await seeded(clock);
    const h = harness(clock);

    await shiftDeadline(h.ctx, deps, { giveawayId: 'g1', byMs: HOUR, by: HOST });
    await shiftDeadline(h.ctx, deps, { giveawayId: 'g1', byMs: -HOUR, by: HOST });

    expect(await kinds(store)).toEqual(['extended', 'shortened']);
  });

  test('an edit records who did it', async () => {
    const clock = { now: NOW.getTime() };
    const { store, deps } = await seeded(clock);
    const h = harness(clock);

    await editGiveawayFields(h.ctx, deps, {
      giveawayId: 'g1',
      patch: { title: 'Better prize' },
      by: userId(9),
    });

    const [event] = await store.history('g1', 10);

    expect(event?.kind).toBe('edited');
    expect(event?.actorId).toBe(userId(9));
  });

  test('a draw records the seed so the result stays reproducible from the timeline', async () => {
    const clock = { now: NOW.getTime() };
    const { store } = await seeded(clock);
    const h = harness(clock);

    const drawn = await drawGiveaway(
      {
        store,
        providers: new ProviderRegistry(),
        now: () => clock.now,
        seed: () => 'a'.repeat(32),
      },
      { guildId: GUILD, giveawayId: 'g1', drawnBy: HOST },
    );

    if (drawn.outcome !== 'drawn') throw new Error('expected a draw');

    await publishResult(
      h.ctx,
      { store, providers: new ProviderRegistry() },
      {
        giveaway: drawn.giveaway,
        summary: drawn.summary,
      },
    );

    const [event] = await store.history('g1', 10);

    expect(event?.kind).toBe('drawn');
    expect((event?.detail as { seed?: string })?.seed).toBe('a'.repeat(32));
  });

  test('a reroll is a distinct line from the draw it replaced', async () => {
    const clock = { now: NOW.getTime() };
    const { store } = await seeded(clock);
    const h = harness(clock);
    const deps = {
      store,
      providers: new ProviderRegistry(),
      now: () => clock.now,
      seed: () => 'a'.repeat(32),
    };

    const drawn = await drawGiveaway(deps, { guildId: GUILD, giveawayId: 'g1', drawnBy: HOST });
    if (drawn.outcome !== 'drawn') throw new Error('expected a draw');

    await publishResult(h.ctx, deps, { giveaway: drawn.giveaway, summary: drawn.summary });

    const rerolled = await rerollGiveaway(deps, {
      guildId: GUILD,
      giveawayId: 'g1',
      drawnBy: HOST,
    });
    if (rerolled.outcome !== 'rerolled') throw new Error('expected a reroll');

    await publishResult(h.ctx, deps, {
      giveaway: rerolled.giveaway,
      summary: rerolled.summary,
      reroll: true,
      replacedIds: rerolled.replaced,
    });

    expect(await kinds(store)).toEqual(['drawn', 'rerolled']);
  });

  test('bonus grants and revocations are separate lines', async () => {
    const clock = { now: NOW.getTime() };
    const { store } = await seeded(clock);
    const h = harness(clock);

    const giveaway = await store.get(GUILD, 'g1');
    if (!giveaway) throw new Error('seed failed');

    await publishBonus(h.ctx, store, giveaway, {
      actorId: HOST,
      subjectId: userId(1),
      amount: 5,
      reason: 'event',
      revoked: false,
    });
    await publishBonus(h.ctx, store, giveaway, {
      actorId: HOST,
      subjectId: userId(1),
      amount: 5,
      reason: null,
      revoked: true,
    });

    expect(await kinds(store)).toEqual(['bonus-granted', 'bonus-revoked']);
  });

  test('losing the message is recorded rather than passing silently', async () => {
    const clock = { now: NOW.getTime() };
    const { store } = await seeded(clock);
    const h = harness(clock);

    await handleMessageDeleted(
      {
        id: 'e',
        type: 'message.deleted',
        guildId: GUILD,
        payload: { id: '700000000000000000' },
      } as never,
      h.ctx,
      { store, providers: new ProviderRegistry() },
    );

    expect(await kinds(store)).toEqual(['orphaned']);
  });
});

describe('the timeline is idempotent', () => {
  // A redelivered gateway event must not double a line in the history a host is reading to settle
  // a dispute.
  test('the same transition recorded twice appends once', async () => {
    const clock = { now: NOW.getTime() };
    const { store } = await seeded(clock);
    const h = harness(clock);

    const giveaway = await store.get(GUILD, 'g1');
    if (!giveaway) throw new Error('seed failed');

    await publishCreated(h.ctx, store, giveaway, { requirements: 0, multipliers: 0 });
    await publishCreated(h.ctx, store, giveaway, { requirements: 0, multipliers: 0 });

    expect(await kinds(store)).toEqual(['created']);
  });

  test('a redelivered draw appends once', async () => {
    const clock = { now: NOW.getTime() };
    const { store } = await seeded(clock);
    const h = harness(clock);
    const deps = {
      store,
      providers: new ProviderRegistry(),
      now: () => clock.now,
      seed: () => 'a'.repeat(32),
    };

    const drawn = await drawGiveaway(deps, { guildId: GUILD, giveawayId: 'g1', drawnBy: HOST });
    if (drawn.outcome !== 'drawn') throw new Error('expected a draw');

    await publishResult(h.ctx, deps, { giveaway: drawn.giveaway, summary: drawn.summary });
    await publishResult(h.ctx, deps, { giveaway: drawn.giveaway, summary: drawn.summary });

    expect(await kinds(store)).toEqual(['drawn']);
  });

  test('two different giveaways keep separate timelines', async () => {
    const clock = { now: NOW.getTime() };
    const { store } = await seeded(clock);
    const h = harness(clock);

    await store.create({
      id: 'g2',
      guildId: GUILD,
      channelId: '500000000000000000',
      messageId: null,
      hostId: HOST,
      title: 'Second',
      winnerCount: 1,
      endsAt: new Date(clock.now + HOUR),
      createdBy: HOST,
    });

    const first = await store.get(GUILD, 'g1');
    const second = await store.get(GUILD, 'g2');
    if (!first || !second) throw new Error('seed failed');

    await publishCreated(h.ctx, store, first, { requirements: 0, multipliers: 0 });
    await publishCancelled(h.ctx, store, second, { actorId: HOST, entrantCount: 0 });

    expect(await kinds(store)).toEqual(['created']);
    expect((await store.history('g2', 10)).map((event) => event.kind)).toEqual(['cancelled']);
  });
});

describe('the timeline survives the giveaway', () => {
  // Deliberately no foreign key: an audit trail that cascades away with the thing it audits is not
  // an audit trail.
  test('history rows are not tied to the giveaway row by a cascade', async () => {
    const clock = { now: NOW.getTime() };
    const { store } = await seeded(clock);
    const h = harness(clock);

    const giveaway = await store.get(GUILD, 'g1');
    if (!giveaway) throw new Error('seed failed');

    await publishCreated(h.ctx, store, giveaway, { requirements: 0, multipliers: 0 });
    store.giveaways.delete('g1');

    expect((await store.history('g1', 10)).map((event) => event.kind)).toEqual(['created']);
  });
});
