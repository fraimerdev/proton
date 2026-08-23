import { describe, expect, test } from 'bun:test';
import {
  type ConditionProvider,
  type MemberContext,
  type MemberContextLoader,
  ProviderRegistry,
  zodToDescriptors,
} from '@proton/core';
import { z } from 'zod';
import { type DrawDeps, drawGiveaway } from '../src/end.ts';
import { reconcile, STALE_DRAW_AFTER_MS } from '../src/reconcile.ts';
import { rerollGiveaway } from '../src/reroll.ts';
import type { CreateGiveawayInput } from '../src/store.ts';
import { MemoryGiveawayStore } from './memory-store.ts';

const GUILD = '100000000000000000';
const NOW = new Date('2026-08-14T12:00:00.000Z');
const ROLE = '600000000000000000';
const SEED = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';

function userId(index: number): string {
  return String(400000000000000000n + BigInt(index));
}

function memberContext(id: string, overrides: Partial<MemberContext> = {}): MemberContext {
  return {
    guildId: GUILD,
    userId: id,
    member: {
      joinedAt: new Date('2024-01-01T00:00:00.000Z'),
      roleIds: [ROLE],
      premiumSince: null,
      communicationDisabledUntil: null,
    },
    user: { createdAt: new Date('2020-01-01T00:00:00.000Z'), hasAvatar: true, bot: false },
    tier: 'free',
    now: NOW,
    ...overrides,
  };
}

function loader(contexts: Map<string, MemberContext>): MemberContextLoader {
  return {
    async load(_guildId, userIds) {
      const loaded = new Map<string, MemberContext>();
      for (const id of userIds) {
        const ctx = contexts.get(id);
        if (ctx) loaded.set(id, ctx);
      }
      return loaded;
    },
  };
}

const countedSchema = z.object({ min: z.number().int().default(0) });

interface Counted {
  provider: ConditionProvider;
  batchCalls: number;
}

function roleCondition(id: string, moduleId: string, requiredRole: string): Counted {
  const state = { batchCalls: 0 };

  const provider: ConditionProvider<typeof countedSchema> = {
    kind: 'condition',
    id,
    moduleId,
    label: id,
    description: id,
    configSchema: countedSchema,
    builder: zodToDescriptors(countedSchema),
    cost: 'query',

    async evaluate(ctx) {
      return { passed: ctx.member?.roleIds?.includes(requiredRole) === true };
    },

    async batchEvaluate(ctxs) {
      state.batchCalls += 1;
      return new Map(
        ctxs.map(
          (ctx) =>
            [ctx.userId, { passed: ctx.member?.roleIds?.includes(requiredRole) === true }] as const,
        ),
      );
    },

    describe() {
      return `hold ${requiredRole}`;
    },

    describeFailure() {
      return `you no longer hold the required role`;
    },
  };

  return {
    provider: provider as unknown as ConditionProvider,
    get batchCalls() {
      return state.batchCalls;
    },
  } as Counted;
}

async function seeded(options: {
  entrants: number;
  winnerCount?: number;
  requirements?: CreateGiveawayInput['requirements'];
  verifyOn?: 'join' | 'draw' | 'both';
  claimWindowSeconds?: number | null;
}) {
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
    verifyOn: options.verifyOn ?? 'both',
    claimWindowSeconds: options.claimWindowSeconds ?? null,
    ...(options.requirements ? { requirements: options.requirements } : {}),
  });

  for (let index = 1; index <= options.entrants; index += 1) {
    await store.enter({
      giveawayId: giveaway.id,
      userId: userId(index),
      baseEntries: 1,
      totalEntries: 1,
      breakdown: [],
      memberSnapshot: { roleIds: [ROLE], joinedAt: null, premiumSince: null, hasAvatar: true },
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

describe('exactly-once drawing', () => {
  test('two concurrent end calls produce exactly one draw row', async () => {
    const { store } = await seeded({ entrants: 20 });
    const drawDeps = deps(store);

    const [first, second] = await Promise.all([
      drawGiveaway(drawDeps, { guildId: GUILD, giveawayId: 'g1', drawnBy: 'a' }),
      drawGiveaway(drawDeps, { guildId: GUILD, giveawayId: 'g1', drawnBy: 'b' }),
    ]);

    expect(store.drawRows).toHaveLength(1);

    const outcomes = [first.outcome, second.outcome].sort();
    expect(outcomes).toEqual(['already-drawing', 'drawn']);
  });

  test('a manual end and the deadline job between them draw once', async () => {
    const { store } = await seeded({ entrants: 20 });
    const drawDeps = deps(store);

    await drawGiveaway(drawDeps, { guildId: GUILD, giveawayId: 'g1', drawnBy: 'human' });
    const job = await drawGiveaway(drawDeps, {
      guildId: GUILD,
      giveawayId: 'g1',
      drawnBy: 'proton:schedule',
    });

    expect(job.outcome).toBe('already-ended');
    expect(store.drawRows).toHaveLength(1);
  });

  test('a redelivered draw finds the giveaway already ended and does nothing', async () => {
    const { store } = await seeded({ entrants: 5 });
    const drawDeps = deps(store);

    await drawGiveaway(drawDeps, { guildId: GUILD, giveawayId: 'g1', drawnBy: 'a' });
    const again = await drawGiveaway(drawDeps, { guildId: GUILD, giveawayId: 'g1', drawnBy: 'a' });

    expect(again.outcome).toBe('already-ended');
    expect(store.drawRows).toHaveLength(1);
  });

  test('five concurrent calls still produce one draw row', async () => {
    const { store } = await seeded({ entrants: 50, winnerCount: 3 });
    const drawDeps = deps(store);

    const results = await Promise.all(
      Array.from({ length: 5 }, (_unused, index) =>
        drawGiveaway(drawDeps, { guildId: GUILD, giveawayId: 'g1', drawnBy: `caller-${index}` }),
      ),
    );

    expect(store.drawRows).toHaveLength(1);
    expect(results.filter((result) => result.outcome === 'drawn')).toHaveLength(1);
  });

  test('the draw row records the seed and snapshot hash it actually used', async () => {
    const { store } = await seeded({ entrants: 10 });
    const drawn = await drawGiveaway(deps(store), {
      guildId: GUILD,
      giveawayId: 'g1',
      drawnBy: 'a',
    });

    if (drawn.outcome !== 'drawn') throw new Error('expected a draw');

    const row = store.drawRows[0];
    expect(row?.seed).toBe(SEED);
    expect(row?.snapshotHash).toBe(drawn.summary.snapshotHash);
    expect(row?.snapshotHash).toMatch(/^[0-9a-f]{64}$/);
    expect(row?.entrantCount).toBe(10);
  });

  test('winners are distinct and drawn from the entrants', async () => {
    const { store } = await seeded({ entrants: 40, winnerCount: 5 });
    const drawn = await drawGiveaway(deps(store), {
      guildId: GUILD,
      giveawayId: 'g1',
      drawnBy: 'a',
    });

    if (drawn.outcome !== 'drawn') throw new Error('expected a draw');

    expect(new Set(drawn.summary.winnerIds).size).toBe(5);
    for (const winner of drawn.summary.winnerIds) {
      expect(Number(BigInt(winner) - 400000000000000000n)).toBeGreaterThan(0);
    }
  });
});

describe('draw-time revalidation', () => {
  test('an entrant who left the guild is disqualified with that reason', async () => {
    const { store } = await seeded({ entrants: 3, winnerCount: 3 });

    const contexts = new Map<string, MemberContext>([
      [userId(1), memberContext(userId(1))],
      [userId(2), { ...memberContext(userId(2)), member: null }],
      [userId(3), memberContext(userId(3))],
    ]);

    const drawn = await drawGiveaway(deps(store, { members: loader(contexts) }), {
      guildId: GUILD,
      giveawayId: 'g1',
      drawnBy: 'a',
    });

    if (drawn.outcome !== 'drawn') throw new Error('expected a draw');

    expect(drawn.summary.winnerIds).not.toContain(userId(2));
    expect(drawn.summary.disqualified).toBe(1);

    const dropped = store.entries.find((row) => row.userId === userId(2));
    expect(dropped?.disqualifyReason).toBe('left the server before the draw');
  });

  test('an entrant who lost the required role is disqualified with the provider wording', async () => {
    const counted = roleCondition('leveling.role', 'leveling', ROLE);
    const providers = new ProviderRegistry();
    providers.register({ id: 'leveling', providers: [counted.provider] });

    const { store } = await seeded({
      entrants: 3,
      winnerCount: 3,
      requirements: [{ providerId: 'leveling.role', config: {}, position: 0 }],
    });

    const contexts = new Map<string, MemberContext>([
      [userId(1), memberContext(userId(1))],
      [
        userId(2),
        memberContext(userId(2), {
          member: {
            joinedAt: null,
            roleIds: [],
            premiumSince: null,
            communicationDisabledUntil: null,
          },
        }),
      ],
      [userId(3), memberContext(userId(3))],
    ]);

    const drawn = await drawGiveaway(deps(store, { providers, members: loader(contexts) }), {
      guildId: GUILD,
      giveawayId: 'g1',
      drawnBy: 'a',
    });

    if (drawn.outcome !== 'drawn') throw new Error('expected a draw');

    expect(drawn.summary.winnerIds).not.toContain(userId(2));
    expect(store.entries.find((row) => row.userId === userId(2))?.disqualifyReason).toBe(
      'you no longer hold the required role',
    );
  });

  test('verify_on join skips revalidation entirely', async () => {
    const counted = roleCondition('leveling.role', 'leveling', ROLE);
    const providers = new ProviderRegistry();
    providers.register({ id: 'leveling', providers: [counted.provider] });

    const { store } = await seeded({
      entrants: 5,
      verifyOn: 'join',
      requirements: [{ providerId: 'leveling.role', config: {}, position: 0 }],
    });

    await drawGiveaway(deps(store, { providers }), {
      guildId: GUILD,
      giveawayId: 'g1',
      drawnBy: 'a',
    });

    expect(counted.batchCalls).toBe(0);
  });
});

describe('batch evaluation', () => {
  // GIVEAWAYS.md §7: revalidating ten thousand entrants must be O(distinct requirements) queries.
  test('revalidating 10,000 entrants issues O(requirements) provider calls, not O(entrants)', async () => {
    const a = roleCondition('leveling.a', 'leveling', ROLE);
    const b = roleCondition('leveling.b', 'leveling', ROLE);
    const c = roleCondition('leveling.c', 'leveling', ROLE);

    const providers = new ProviderRegistry();
    providers.register({ id: 'leveling', providers: [a.provider, b.provider, c.provider] });

    const { store } = await seeded({
      entrants: 10_000,
      winnerCount: 5,
      requirements: [
        { providerId: 'leveling.a', config: {}, position: 0 },
        { providerId: 'leveling.b', config: {}, position: 1 },
        { providerId: 'leveling.c', config: {}, position: 2 },
      ],
    });

    const drawn = await drawGiveaway(deps(store, { providers, chunkSize: 10_000 }), {
      guildId: GUILD,
      giveawayId: 'g1',
      drawnBy: 'a',
    });

    if (drawn.outcome !== 'drawn') throw new Error('expected a draw');

    expect(a.batchCalls + b.batchCalls + c.batchCalls).toBe(3);
    expect(drawn.summary.entrantCount).toBe(10_000);
    expect(drawn.summary.winnerIds).toHaveLength(5);
  }, 30_000);

  test('chunking keeps provider calls proportional to chunks, never to entrants', async () => {
    const counted = roleCondition('leveling.a', 'leveling', ROLE);
    const providers = new ProviderRegistry();
    providers.register({ id: 'leveling', providers: [counted.provider] });

    const { store } = await seeded({
      entrants: 2_000,
      requirements: [{ providerId: 'leveling.a', config: {}, position: 0 }],
    });

    await drawGiveaway(deps(store, { providers, chunkSize: 500 }), {
      guildId: GUILD,
      giveawayId: 'g1',
      drawnBy: 'a',
    });

    expect(counted.batchCalls).toBe(4);
  }, 20_000);
});

describe('degraded providers', () => {
  test('a requirement whose module is switched off completes the draw and is recorded', async () => {
    const { store } = await seeded({
      entrants: 10,
      requirements: [{ providerId: 'leveling.level', config: { min: 5 }, position: 0 }],
    });

    const drawn = await drawGiveaway(deps(store), {
      guildId: GUILD,
      giveawayId: 'g1',
      drawnBy: 'a',
    });

    if (drawn.outcome !== 'drawn') throw new Error('expected a draw');

    expect(drawn.summary.degraded).toEqual(['leveling.level']);
    expect(store.drawRows[0]?.degradedProviders).toEqual(['leveling.level']);

    // Skipped, not failed open or closed: everybody who entered is still in the draw.
    expect(drawn.summary.disqualified).toBe(0);
    expect(drawn.summary.winnerIds).toHaveLength(1);
  });

  test('a healthy requirement still decides while another is degraded', async () => {
    const counted = roleCondition('leveling.role', 'leveling', 'a-role-nobody-has');
    const providers = new ProviderRegistry();
    providers.register({ id: 'leveling', providers: [counted.provider] });

    const { store } = await seeded({
      entrants: 4,
      requirements: [
        { providerId: 'leveling.role', config: {}, position: 0 },
        { providerId: 'cases.no_active_case', config: {}, position: 1 },
      ],
    });

    const contexts = new Map(
      [1, 2, 3, 4].map((index) => [userId(index), memberContext(userId(index))] as const),
    );

    const drawn = await drawGiveaway(deps(store, { providers, members: loader(contexts) }), {
      guildId: GUILD,
      giveawayId: 'g1',
      drawnBy: 'a',
    });

    if (drawn.outcome !== 'drawn') throw new Error('expected a draw');

    expect(drawn.summary.degraded).toEqual(['cases.no_active_case']);
    expect(drawn.summary.disqualified).toBe(4);
    expect(drawn.summary.winnerIds).toEqual([]);
  });
});

describe('reroll', () => {
  test('a reroll excludes the previous winners and writes a second draw row', async () => {
    const { store } = await seeded({ entrants: 20, winnerCount: 2 });
    const drawDeps = deps(store);

    const first = await drawGiveaway(drawDeps, { guildId: GUILD, giveawayId: 'g1', drawnBy: 'a' });
    if (first.outcome !== 'drawn') throw new Error('expected a draw');

    const rerolled = await rerollGiveaway(
      { ...drawDeps, seed: () => 'b1b2c3d4e5f60718293a4b5c6d7e8f90' },
      { guildId: GUILD, giveawayId: 'g1', drawnBy: 'a' },
    );

    if (rerolled.outcome !== 'rerolled') throw new Error(`expected a reroll: ${rerolled.outcome}`);

    expect(store.drawRows).toHaveLength(2);
    expect(store.drawRows[1]?.drawNumber).toBe(2);

    for (const winner of rerolled.summary.winnerIds) {
      expect(first.summary.winnerIds).not.toContain(winner);
    }
  });

  test('a reroll on a running giveaway refuses', async () => {
    const { store } = await seeded({ entrants: 5 });

    const outcome = await rerollGiveaway(deps(store), {
      guildId: GUILD,
      giveawayId: 'g1',
      drawnBy: 'a',
    });

    expect(outcome.outcome).toBe('still-running');
  });
});

describe('boot reconciliation', () => {
  test('a giveaway whose deadline passed while the worker was down comes back as overdue', async () => {
    const { store } = await seeded({ entrants: 5 });

    const later = new Date(NOW.getTime() + 120_000);
    const result = await reconcile({ store, now: () => later.getTime() });

    expect(result.overdue.map((giveaway) => giveaway.id)).toEqual(['g1']);
  });

  // The asymmetry that matters: re-drawing one that already produced winners hands the prize to
  // somebody else.
  test('a giveaway stuck in drawing with no draw row is released to be drawn again', async () => {
    const { store } = await seeded({ entrants: 5 });
    await store.beginDraw(GUILD, 'g1', NOW);

    const later = new Date(NOW.getTime() + STALE_DRAW_AFTER_MS + 1_000);
    const result = await reconcile({ store, now: () => later.getTime() });

    expect(result.released).toEqual(['g1']);
    expect((await store.get(GUILD, 'g1'))?.status).toBe('running');
  });

  test('a giveaway stuck in drawing WITH a draw row is finished forward, never re-drawn', async () => {
    const { store } = await seeded({ entrants: 5 });
    await store.beginDraw(GUILD, 'g1', NOW);

    await store.recordDraw({
      id: 'g1:1',
      giveawayId: 'g1',
      drawNumber: 1,
      seed: SEED,
      snapshotHash: 'x'.repeat(64),
      entrantCount: 5,
      totalEntries: 5,
      winnerIds: [userId(1)],
      degradedProviders: [],
      drawnBy: 'a',
    });

    const later = new Date(NOW.getTime() + STALE_DRAW_AFTER_MS + 1_000);
    const result = await reconcile({ store, now: () => later.getTime() });

    expect(result.released).toEqual([]);
    expect(result.finished).toEqual(['g1']);
    expect((await store.get(GUILD, 'g1'))?.status).toBe('ended');
    expect(store.drawRows).toHaveLength(1);
  });

  test('a draw still inside the stale window is left alone', async () => {
    const { store } = await seeded({ entrants: 5 });
    await store.beginDraw(GUILD, 'g1', NOW);

    const result = await reconcile({ store, now: () => NOW.getTime() + 1_000 });

    expect(result.released).toEqual([]);
    expect((await store.get(GUILD, 'g1'))?.status).toBe('drawing');
  });

  test('running giveaways are marked dirty so a stale count self-heals', async () => {
    const { store } = await seeded({ entrants: 5 });

    const marked: string[] = [];
    await reconcile({
      store,
      now: () => NOW.getTime(),
      dirty: {
        async mark(id) {
          marked.push(id);
        },
        async pending() {
          return [];
        },
        async lease() {
          return true;
        },
        async clear() {},
      },
    });

    expect(marked).toEqual(['g1']);
  });
});
