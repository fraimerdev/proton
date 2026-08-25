import { describe, expect, test } from 'bun:test';
import {
  type ConditionProvider,
  type MemberContext,
  ProviderRegistry,
  type RequirementNode,
  zodToDescriptors,
} from '@proton/core';
import { z } from 'zod';
import { drawGiveaway } from '../src/end.ts';
import { join } from '../src/entry.ts';
import { describeRules, requirementTreeOf } from '../src/rules.ts';
import type { CreateGiveawayInput, Giveaway } from '../src/store.ts';
import { MemoryGiveawayStore } from './memory-store.ts';

const GUILD = '100000000000000000';
const HOST = '400000000000000001';
const NOW = new Date('2026-08-25T12:00:00.000Z');
const BOOSTER = '600000000000000001';
const PREMIUM = '600000000000000002';

function userId(index: number): string {
  return String(400000000000004000n + BigInt(index));
}

const roleSchema = z.object({ roleId: z.string() });

function roleCondition(): { provider: ConditionProvider; calls: () => number } {
  let calls = 0;

  const provider: ConditionProvider<typeof roleSchema> = {
    kind: 'condition',
    id: 'leveling.holds_role',
    moduleId: 'leveling',
    label: 'Holds a role',
    description: 'test provider',
    configSchema: roleSchema,
    builder: zodToDescriptors(roleSchema),
    cost: 'facts',

    async evaluate(ctx, config) {
      return { passed: ctx.member?.roleIds?.includes(config.roleId) === true };
    },

    async batchEvaluate(ctxs, config) {
      calls += 1;
      return new Map(
        ctxs.map((ctx) => [
          ctx.userId,
          { passed: ctx.member?.roleIds?.includes(config.roleId) === true },
        ]),
      );
    },

    describe(config) {
      return `Hold <@&${config.roleId}>.`;
    },

    describeFailure(config) {
      return `You need <@&${config.roleId}>.`;
    },
  };

  return { provider: provider as unknown as ConditionProvider, calls: () => calls };
}

function memberWith(index: number, roleIds: string[]): MemberContext {
  return {
    guildId: GUILD,
    userId: userId(index),
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

// (booster OR premium) AND NOT bot-role — the example from the brief's §20.
const NESTED: RequirementNode = {
  kind: 'group',
  logic: 'all',
  children: [
    {
      kind: 'group',
      logic: 'any',
      children: [
        { kind: 'leaf', providerId: 'leveling.holds_role', config: { roleId: BOOSTER } },
        { kind: 'leaf', providerId: 'leveling.holds_role', config: { roleId: PREMIUM } },
      ],
    },
  ],
};

async function seeded(tree: unknown, over: Partial<CreateGiveawayInput> = {}) {
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
    requirementTree: tree,
    ...over,
  } satisfies CreateGiveawayInput);

  return store;
}

function registryOf() {
  const registry = new ProviderRegistry();
  const counted = roleCondition();

  registry.register({ id: 'leveling', providers: [counted.provider] });
  return { registry, calls: counted.calls };
}

describe('picking the rule set', () => {
  test('a stored tree wins over the flat rows', async () => {
    const giveaway = { requirementTree: NESTED, requirementLogic: 'all' } as Giveaway;

    // Parsed, so a validated copy rather than the same reference — the flat row is not consulted.
    expect(requirementTreeOf(giveaway, [{ providerId: 'other', config: {} }])).toEqual(NESTED);
  });

  test('no tree falls back to the flat rows as a one-level group', async () => {
    const giveaway = { requirementTree: null, requirementLogic: 'any' } as Giveaway;
    const tree = requirementTreeOf(giveaway, [{ providerId: 'a', config: {} }]);

    expect(tree).toEqual({
      kind: 'group',
      logic: 'any',
      children: [{ kind: 'leaf', providerId: 'a', config: {} }],
    });
  });

  test('no tree and no rows means no requirements at all', async () => {
    const giveaway = { requirementTree: null, requirementLogic: 'all' } as Giveaway;

    expect(requirementTreeOf(giveaway, [])).toBeNull();
  });

  // A hand-edited jsonb blob must not throw inside a button press.
  test('an unparseable stored tree falls back to the flat rows', async () => {
    const giveaway = { requirementTree: { kind: 'nonsense' }, requirementLogic: 'all' } as Giveaway;
    const tree = requirementTreeOf(giveaway, [{ providerId: 'a', config: {} }]);

    expect(tree?.kind).toBe('group');
  });
});

describe('a nested tree decides entry', () => {
  async function tryJoin(store: MemoryGiveawayStore, ctx: MemberContext) {
    const { registry } = registryOf();
    const giveaway = await store.get(GUILD, 'g1');
    if (!giveaway) throw new Error('seed failed');

    return join(
      { store, providers: registry },
      { giveaway, ctx, requirements: [], multipliers: [], blacklist: [] },
    );
  }

  test('a booster gets in through the OR branch', async () => {
    const store = await seeded(NESTED);

    expect((await tryJoin(store, memberWith(1, [BOOSTER]))).outcome).toBe('entered');
  });

  test('a premium member gets in through the other branch', async () => {
    const store = await seeded(NESTED);

    expect((await tryJoin(store, memberWith(2, [PREMIUM]))).outcome).toBe('entered');
  });

  test('somebody with neither is refused, and told which roles', async () => {
    const store = await seeded(NESTED);
    const outcome = await tryJoin(store, memberWith(3, []));

    expect(outcome.outcome).toBe('rejected');
    if (outcome.outcome !== 'rejected') return;

    expect(outcome.failures).toHaveLength(2);
    expect(outcome.failures.join(' ')).toContain(BOOSTER);
  });

  test('a NONE branch excludes rather than requires', async () => {
    const store = await seeded({
      kind: 'group',
      logic: 'none',
      children: [{ kind: 'leaf', providerId: 'leveling.holds_role', config: { roleId: BOOSTER } }],
    });

    expect((await tryJoin(store, memberWith(1, []))).outcome).toBe('entered');

    const excluded = await seeded({
      kind: 'group',
      logic: 'none',
      children: [{ kind: 'leaf', providerId: 'leveling.holds_role', config: { roleId: BOOSTER } }],
    });

    expect((await tryJoin(excluded, memberWith(1, [BOOSTER]))).outcome).toBe('rejected');
  });
});

describe('a nested tree decides the draw', () => {
  async function withEntrants() {
    const store = await seeded(NESTED, { verifyOn: 'draw' });

    for (let index = 1; index <= 6; index += 1) {
      await store.enter({
        giveawayId: 'g1',
        userId: userId(index),
        baseEntries: 1,
        totalEntries: 1,
        breakdown: [],
        memberSnapshot: {
          // Only the first two hold a qualifying role.
          roleIds: index <= 2 ? [BOOSTER] : [],
          joinedAt: null,
          premiumSince: null,
          hasAvatar: true,
        },
      });
    }

    return store;
  }

  test('draw-time revalidation disqualifies whoever no longer clears the tree', async () => {
    const store = await withEntrants();
    const { registry } = registryOf();

    const drawn = await drawGiveaway(
      { store, providers: registry, now: () => NOW.getTime(), seed: () => 'a'.repeat(32) },
      { guildId: GUILD, giveawayId: 'g1', drawnBy: HOST },
    );

    expect(drawn.outcome).toBe('drawn');
    if (drawn.outcome !== 'drawn') return;

    expect(drawn.summary.disqualified).toBe(4);
    expect(drawn.summary.entrantCount).toBe(2);
  });

  // The reason the tree is flattened before it is folded: a recursive per-entrant evaluator turns
  // this into one query per entrant per node.
  test('a two-leaf tree over six entrants is two provider calls, not twelve', async () => {
    const store = await withEntrants();
    const { registry, calls } = registryOf();

    await drawGiveaway(
      {
        store,
        providers: registry,
        now: () => NOW.getTime(),
        seed: () => 'a'.repeat(32),
        chunkSize: 500,
      },
      { guildId: GUILD, giveawayId: 'g1', drawnBy: HOST },
    );

    expect(calls()).toBe(2);
  });
});

describe('describing the rules', () => {
  test('a nested tree renders its logic', () => {
    const { registry } = registryOf();
    const lines = describeRules(registry, NESTED, []);

    expect(lines.join('\n')).toContain('any one of');
  });

  test('a flat set renders as a plain list', () => {
    const { registry } = registryOf();
    const lines = describeRules(registry, null, [
      { providerId: 'leveling.holds_role', config: { roleId: BOOSTER } },
    ]);

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(BOOSTER);
  });
});
