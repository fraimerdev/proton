import { describe, expect, test } from 'bun:test';
import {
  type ConditionProvider,
  type MemberContext,
  type MultiplierProvider,
  ProviderRegistry,
  zodToDescriptors,
} from '@proton/core';
import { z } from 'zod';
import { COUNT_FLUSH_INTERVAL_MS } from '../src/config.ts';
import { flushCounts, MemoryDirtyCounts } from '../src/counter.ts';
import { AllowAllBucket, describeJoin, type EntryBucket, join } from '../src/entry.ts';
import { createGiveawayProviders } from '../src/providers.ts';
import type { CreateGiveawayInput, Giveaway } from '../src/store.ts';
import { MemoryGiveawayStore } from './memory-store.ts';

const GUILD = '100000000000000000';
const ROLE_A = '600000000000000000';
const ROLE_B = '600000000000000001';
const NOW = new Date('2026-08-14T12:00:00.000Z');

function userId(index: number): string {
  return String(400000000000000000n + BigInt(index));
}

function ctxFor(id: string, roleIds: string[] = [ROLE_A]): MemberContext {
  return {
    guildId: GUILD,
    userId: id,
    member: {
      joinedAt: new Date('2024-01-01T00:00:00.000Z'),
      roleIds,
      premiumSince: null,
      communicationDisabledUntil: null,
    },
    user: { createdAt: new Date('2020-01-01T00:00:00.000Z'), hasAvatar: true, bot: false },
    tier: 'free',
    now: NOW,
  };
}

const emptySchema = z.object({});

function gate(id: string, passes: (ctx: MemberContext) => boolean, failure: string) {
  const provider: ConditionProvider<typeof emptySchema> = {
    kind: 'condition',
    id,
    moduleId: 'leveling',
    label: id,
    description: id,
    configSchema: emptySchema,
    builder: [],
    cost: 'facts',
    async evaluate(ctx) {
      return { passed: passes(ctx), progress: { current: 3, required: 5, unit: 'levels' } };
    },
    describe() {
      return id;
    },
    describeFailure(_config, result) {
      return result.progress
        ? `${failure} (${result.progress.current}/${result.progress.required})`
        : failure;
    },
  };

  return provider as unknown as ConditionProvider;
}

const amountSchema = z.object({ amount: z.number().default(0) });

function bonus(id: string, amountFor: (ctx: MemberContext, amount: number) => number) {
  const provider: MultiplierProvider<typeof amountSchema> = {
    kind: 'multiplier',
    id,
    moduleId: 'leveling',
    label: id,
    description: id,
    configSchema: amountSchema,
    builder: zodToDescriptors(amountSchema),
    cost: 'facts',
    async evaluate(ctx, config) {
      return amountFor(ctx, config.amount);
    },
    describe(config) {
      return `${id}: ${config.amount}`;
    },
  };

  return provider as unknown as MultiplierProvider;
}

function registryWith(providers: (ConditionProvider | MultiplierProvider)[]): ProviderRegistry {
  const registry = new ProviderRegistry();
  registry.register({ id: 'leveling', providers });
  return registry;
}

async function makeGiveaway(
  store: MemoryGiveawayStore,
  overrides: Partial<CreateGiveawayInput> = {},
): Promise<Giveaway> {
  return store.create({
    id: 'g1',
    guildId: GUILD,
    channelId: '500000000000000000',
    messageId: '700000000000000000',
    hostId: userId(0),
    title: 'A prize',
    winnerCount: 1,
    endsAt: new Date(NOW.getTime() + 60_000),
    createdBy: userId(0),
    ...overrides,
  });
}

describe('requirement logic at the join', () => {
  const pass = gate('leveling.pass', () => true, 'never fails');
  const failA = gate('leveling.failA', () => false, 'you need A');
  const failB = gate('leveling.failB', () => false, 'you need B');

  test('all: every requirement has to pass', async () => {
    const store = new MemoryGiveawayStore();
    const giveaway = await makeGiveaway(store, {
      requirementLogic: 'all',
      requirements: [
        { providerId: 'leveling.pass', config: {}, position: 0 },
        { providerId: 'leveling.failA', config: {}, position: 1 },
      ],
    });

    const outcome = await join(
      { store, providers: registryWith([pass, failA]) },
      {
        giveaway,
        ctx: ctxFor(userId(1)),
        requirements: [
          { providerId: 'leveling.pass', config: {} },
          { providerId: 'leveling.failA', config: {} },
        ],
        multipliers: [],
        blacklist: [],
      },
    );

    expect(outcome.outcome).toBe('rejected');
  });

  test('any: one requirement passing is enough', async () => {
    const store = new MemoryGiveawayStore();
    const giveaway = await makeGiveaway(store, { requirementLogic: 'any' });

    const outcome = await join(
      { store, providers: registryWith([pass, failA]) },
      {
        giveaway,
        ctx: ctxFor(userId(1)),
        requirements: [
          { providerId: 'leveling.pass', config: {} },
          { providerId: 'leveling.failA', config: {} },
        ],
        multipliers: [],
        blacklist: [],
      },
    );

    expect(outcome.outcome).toBe('entered');
  });

  test('a member with no requirements to meet is entered', async () => {
    const store = new MemoryGiveawayStore();
    const giveaway = await makeGiveaway(store);

    const outcome = await join(
      { store, providers: new ProviderRegistry() },
      { giveaway, ctx: ctxFor(userId(1)), requirements: [], multipliers: [], blacklist: [] },
    );

    expect(outcome.outcome).toBe('entered');
  });

  // GIVEAWAYS.md §6.4: never a bare "you don't qualify".
  test('a rejected join lists every failed requirement with its progress', async () => {
    const store = new MemoryGiveawayStore();
    const giveaway = await makeGiveaway(store, { requirementLogic: 'all' });

    const outcome = await join(
      { store, providers: registryWith([failA, failB]) },
      {
        giveaway,
        ctx: ctxFor(userId(1)),
        requirements: [
          { providerId: 'leveling.failA', config: {} },
          { providerId: 'leveling.failB', config: {} },
        ],
        multipliers: [],
        blacklist: [],
      },
    );

    if (outcome.outcome !== 'rejected') throw new Error('expected a rejection');

    expect(outcome.failures).toHaveLength(2);
    expect(outcome.failures[0]).toContain('you need A');
    expect(outcome.failures[0]).toContain('3/5');
    expect(outcome.failures[1]).toContain('you need B');

    const message = describeJoin(outcome, 'A prize');
    expect(message).toContain('you need A');
    expect(message).toContain('you need B');
    expect(message).not.toBe('You do not qualify.');
  });
});

describe('blacklist and rate limiting', () => {
  test('a blacklisted user is refused before any requirement runs', async () => {
    const store = new MemoryGiveawayStore();
    const giveaway = await makeGiveaway(store);

    const outcome = await join(
      { store, providers: new ProviderRegistry() },
      {
        giveaway,
        ctx: ctxFor(userId(1)),
        requirements: [],
        multipliers: [],
        blacklist: [{ subjectType: 'user', subjectId: userId(1) }],
      },
    );

    expect(outcome.outcome).toBe('blacklisted');
    expect(store.entries).toHaveLength(0);
  });

  test('a blacklisted role keeps its holders out', async () => {
    const store = new MemoryGiveawayStore();
    const giveaway = await makeGiveaway(store);

    const outcome = await join(
      { store, providers: new ProviderRegistry() },
      {
        giveaway,
        ctx: ctxFor(userId(1), [ROLE_B]),
        requirements: [],
        multipliers: [],
        blacklist: [{ subjectType: 'role', subjectId: ROLE_B }],
      },
    );

    expect(outcome.outcome).toBe('blacklisted');
  });

  test('the bucket rejects button spam before any database work', async () => {
    const store = new MemoryGiveawayStore();
    const giveaway = await makeGiveaway(store);

    let allowed = true;
    const bucket: EntryBucket = {
      async allow() {
        const answer = allowed;
        allowed = false;
        return answer;
      },
    };

    const input = {
      giveaway,
      ctx: ctxFor(userId(1)),
      requirements: [],
      multipliers: [],
      blacklist: [],
    };

    const first = await join({ store, providers: new ProviderRegistry(), bucket }, input);
    const before = store.queries.length;
    const second = await join({ store, providers: new ProviderRegistry(), bucket }, input);

    expect(first.outcome).toBe('entered');
    expect(second.outcome).toBe('rate-limited');
    expect(store.queries.length).toBe(before);
  });

  test('a second press after the bucket clears is told they are already in', async () => {
    const store = new MemoryGiveawayStore();
    const giveaway = await makeGiveaway(store);

    const input = {
      giveaway,
      ctx: ctxFor(userId(1)),
      requirements: [],
      multipliers: [],
      blacklist: [],
    };

    await join({ store, providers: new ProviderRegistry(), bucket: new AllowAllBucket() }, input);
    const second = await join(
      { store, providers: new ProviderRegistry(), bucket: new AllowAllBucket() },
      input,
    );

    expect(second.outcome).toBe('already-entered');
    expect(store.entries).toHaveLength(1);
  });

  test('a giveaway that is not running takes no more entries', async () => {
    const store = new MemoryGiveawayStore();
    const giveaway = await makeGiveaway(store, { status: 'ended' });

    const outcome = await join(
      { store, providers: new ProviderRegistry() },
      { giveaway, ctx: ctxFor(userId(1)), requirements: [], multipliers: [], blacklist: [] },
    );

    expect(outcome.outcome).toBe('closed');
  });
});

describe('entry weight at the join', () => {
  test('the stored entry carries the full breakdown', async () => {
    const store = new MemoryGiveawayStore();
    const giveaway = await makeGiveaway(store);

    const outcome = await join(
      { store, providers: registryWith([bonus('leveling.role', (_ctx, amount) => amount)]) },
      {
        giveaway,
        ctx: ctxFor(userId(1)),
        requirements: [],
        multipliers: [{ providerId: 'leveling.role', config: { amount: 4 }, mode: 'add' }],
        blacklist: [],
      },
    );

    if (outcome.outcome !== 'entered') throw new Error('expected an entry');

    expect(outcome.totalEntries).toBe(5);
    expect(store.entries[0]?.totalEntries).toBe(5);
    expect(describeJoin(outcome, 'A prize')).toContain('5 entries');
  });

  test('maxEntriesPerUser clamps what is stored', async () => {
    const store = new MemoryGiveawayStore();
    const giveaway = await makeGiveaway(store, { maxEntriesPerUser: 3 });

    const outcome = await join(
      { store, providers: registryWith([bonus('leveling.role', (_ctx, amount) => amount)]) },
      {
        giveaway,
        ctx: ctxFor(userId(1)),
        requirements: [],
        multipliers: [{ providerId: 'leveling.role', config: { amount: 40 }, mode: 'add' }],
        blacklist: [],
      },
    );

    if (outcome.outcome !== 'entered') throw new Error('expected an entry');
    expect(outcome.totalEntries).toBe(3);
  });

  test('the member snapshot is stored so a draw can fall back to it', async () => {
    const store = new MemoryGiveawayStore();
    const giveaway = await makeGiveaway(store);

    await join(
      { store, providers: new ProviderRegistry() },
      { giveaway, ctx: ctxFor(userId(1)), requirements: [], multipliers: [], blacklist: [] },
    );

    expect(store.entries[0]?.memberSnapshot?.roleIds).toEqual([ROLE_A]);
  });
});

describe('debounced live count', () => {
  // GIVEAWAYS.md §7: 5,000 joins in 60 seconds must produce at most 12 message edits.
  test('5,000 joins across a minute produce at most 12 edits', async () => {
    let clock = 0;
    const dirty = new MemoryDirtyCounts(() => clock);

    let edits = 0;
    const edit = async () => {
      edits += 1;
      return true;
    };

    for (let second = 0; second < 60; second += 1) {
      clock = second * 1_000;

      for (let join = 0; join < 84; join += 1) {
        await dirty.mark('g1');
      }

      await flushCounts({ dirty, edit, intervalMs: COUNT_FLUSH_INTERVAL_MS });
    }

    expect(edits).toBeLessThanOrEqual(12);
    expect(edits).toBeGreaterThan(0);
  });

  test('a giveaway nobody joined produces no edits at all', async () => {
    const dirty = new MemoryDirtyCounts(() => 0);

    let edits = 0;
    const result = await flushCounts({
      dirty,
      edit: async () => {
        edits += 1;
        return true;
      },
    });

    expect(edits).toBe(0);
    expect(result.considered).toBe(0);
  });

  test('two workers sharing one dirty set still make one edit per window', async () => {
    const clock = 0;
    const dirty = new MemoryDirtyCounts(() => clock);
    await dirty.mark('g1');

    let edits = 0;
    const edit = async () => {
      edits += 1;
      return true;
    };

    // Both "workers" tick inside the same window; the lease is what decides.
    await flushCounts({ dirty, edit });
    await dirty.mark('g1');
    await flushCounts({ dirty, edit });

    expect(edits).toBe(1);
  });

  test('the flag survives a flush that finds no lease and is retried next window', async () => {
    let clock = 0;
    const dirty = new MemoryDirtyCounts(() => clock);
    await dirty.mark('g1');

    let edits = 0;
    const edit = async () => {
      edits += 1;
      return true;
    };

    await flushCounts({ dirty, edit });
    await dirty.mark('g1');
    await flushCounts({ dirty, edit });

    clock += COUNT_FLUSH_INTERVAL_MS + 1;
    await flushCounts({ dirty, edit });

    expect(edits).toBe(2);
  });

  // The flag lives in the shared store, never in a process, so a restart loses nothing.
  test('a worker restart mid-giveaway leaves the dirty flag intact', async () => {
    const dirty = new MemoryDirtyCounts(() => 0);
    await dirty.mark('g1');

    // "Restart": a brand new flusher over the same store.
    let edits = 0;
    await flushCounts({
      dirty,
      edit: async () => {
        edits += 1;
        return true;
      },
    });

    expect(edits).toBe(1);
  });

  test('the flag is cleared before the edit so a join during it stays dirty', async () => {
    const dirty = new MemoryDirtyCounts(() => 0);
    await dirty.mark('g1');

    await flushCounts({
      dirty,
      async edit() {
        await dirty.mark('g1');
        return true;
      },
    });

    expect(await dirty.pending(10)).toEqual(['g1']);
  });
});

describe('giveaways providers', () => {
  test('no_recent_wins keeps a recent winner out and lets everyone else in', async () => {
    const store = new MemoryGiveawayStore();
    await makeGiveaway(store);

    await store.recordDraw({
      id: 'g1:1',
      giveawayId: 'g1',
      drawNumber: 1,
      seed: 'a'.repeat(32),
      snapshotHash: 'b'.repeat(64),
      entrantCount: 1,
      totalEntries: 1,
      winnerIds: [userId(1)],
      degradedProviders: [],
      drawnBy: 'a',
    });

    const registry = new ProviderRegistry();
    registry.register({ id: 'giveaways', providers: createGiveawayProviders(store) });

    const provider = registry.condition('giveaways.no_recent_wins');
    if (!provider) throw new Error('provider not registered');

    const results = await provider.batchEvaluate?.([ctxFor(userId(1)), ctxFor(userId(2))], {
      days: 7,
      scope: 'guild',
    });

    expect(results?.get(userId(1))?.passed).toBe(false);
    expect(results?.get(userId(2))?.passed).toBe(true);
  });

  test('a forfeited win does not count against the next giveaway', async () => {
    const store = new MemoryGiveawayStore();
    await makeGiveaway(store);

    await store.recordDraw({
      id: 'g1:1',
      giveawayId: 'g1',
      drawNumber: 1,
      seed: 'a'.repeat(32),
      snapshotHash: 'b'.repeat(64),
      entrantCount: 1,
      totalEntries: 1,
      winnerIds: [userId(1)],
      degradedProviders: [],
      drawnBy: 'a',
    });

    await store.forfeit('g1:1', [userId(1)], NOW);

    const registry = new ProviderRegistry();
    registry.register({ id: 'giveaways', providers: createGiveawayProviders(store) });

    const results = await registry
      .condition('giveaways.no_recent_wins')
      ?.batchEvaluate?.([ctxFor(userId(1))], { days: 7 });

    expect(results?.get(userId(1))?.passed).toBe(true);
  });

  test('every giveaways provider fits one modal and declares its cost honestly', () => {
    const store = new MemoryGiveawayStore();

    for (const provider of createGiveawayProviders(store)) {
      expect(provider.builder.length).toBeLessThanOrEqual(5);
      if (provider.cost === 'query') expect(provider.batchEvaluate).toBeDefined();
    }
  });
});
