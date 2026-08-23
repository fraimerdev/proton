import { describe, expect, test } from 'bun:test';
import {
  describeMultipliers,
  describeRequirements,
  evaluateMultipliers,
  evaluateRequirement,
  evaluateRequirements,
  evaluateWeight,
  type MultiplierSpec,
  type RequirementSpec,
} from '../../src/providers/evaluate.ts';
import { ProviderRegistry } from '../../src/providers/registry.ts';
import type { MemberContext } from '../../src/providers/types.ts';
import { countingCondition, fixedMultiplier, memberContext, USER_A, USER_B } from './harness.ts';

function always(id: string, passing: boolean) {
  return countingCondition(id, 'leveling', { passes: () => passing }).provider;
}

function registryWith(providers: ReturnType<typeof always>[]): ProviderRegistry {
  const registry = new ProviderRegistry();
  registry.register({ id: 'leveling', providers });
  return registry;
}

const CTX = memberContext();

function spec(providerId: string, config: Record<string, unknown> = {}): RequirementSpec {
  return { providerId, config };
}

describe('requirement logic', () => {
  test('all passes only when every requirement passes', async () => {
    const registry = registryWith([always('leveling.a', true), always('leveling.b', true)]);
    const verdict = await evaluateRequirement(
      registry,
      CTX,
      [spec('leveling.a'), spec('leveling.b')],
      'all',
    );

    expect(verdict.passed).toBe(true);
    expect(verdict.failures).toEqual([]);
  });

  test('all fails when one requirement fails', async () => {
    const registry = registryWith([always('leveling.a', true), always('leveling.b', false)]);
    const verdict = await evaluateRequirement(
      registry,
      CTX,
      [spec('leveling.a'), spec('leveling.b')],
      'all',
    );

    expect(verdict.passed).toBe(false);
    expect(verdict.failures.map((failure) => failure.providerId)).toEqual(['leveling.b']);
  });

  test('any passes when one of several passes', async () => {
    const registry = registryWith([always('leveling.a', false), always('leveling.b', true)]);
    const verdict = await evaluateRequirement(
      registry,
      CTX,
      [spec('leveling.a'), spec('leveling.b')],
      'any',
    );

    expect(verdict.passed).toBe(true);
  });

  test('any fails when every one fails', async () => {
    const registry = registryWith([always('leveling.a', false), always('leveling.b', false)]);
    const verdict = await evaluateRequirement(
      registry,
      CTX,
      [spec('leveling.a'), spec('leveling.b')],
      'any',
    );

    expect(verdict.passed).toBe(false);
  });

  test('an empty requirement set admits everyone', async () => {
    const registry = new ProviderRegistry();

    expect((await evaluateRequirement(registry, CTX, [], 'all')).passed).toBe(true);
    expect((await evaluateRequirement(registry, CTX, [], 'any')).passed).toBe(true);
  });

  test('every failure is returned, not just the first', async () => {
    const registry = registryWith([
      always('leveling.a', false),
      always('leveling.b', false),
      always('leveling.c', false),
    ]);

    const verdict = await evaluateRequirement(
      registry,
      CTX,
      [spec('leveling.a'), spec('leveling.b'), spec('leveling.c')],
      'all',
    );

    expect(verdict.failures.map((failure) => failure.providerId)).toEqual([
      'leveling.a',
      'leveling.b',
      'leveling.c',
    ]);
  });

  test('a failure carries the progress the provider reported', async () => {
    const registry = new ProviderRegistry();
    const verdict = await evaluateRequirement(
      registry,
      memberContext({ user: { createdAt: new Date('2026-08-01'), hasAvatar: true, bot: false } }),
      [spec('core.account_age', { operator: 'older-than', duration: '365d' })],
      'all',
    );

    expect(verdict.passed).toBe(false);
    expect(verdict.failures[0]?.progress?.unit).toBe('ms');
  });
});

describe('degraded providers', () => {
  test('an unloaded requirement is skipped and recorded, not thrown', async () => {
    const registry = new ProviderRegistry();
    const verdict = await evaluateRequirement(registry, CTX, [spec('leveling.level')], 'all');

    expect(verdict.passed).toBe(true);
    expect(verdict.degraded.map((entry) => entry.providerId)).toEqual(['leveling.level']);
    expect(verdict.failures).toEqual([]);
  });

  test('a requirement with unreadable settings is degraded, not failed', async () => {
    const registry = new ProviderRegistry();
    const verdict = await evaluateRequirement(
      registry,
      CTX,
      [spec('core.has_role', { roleIds: [] })],
      'all',
    );

    expect(verdict.passed).toBe(true);
    expect(verdict.degraded).toHaveLength(1);
  });

  test('a loaded requirement still decides when another one is degraded', async () => {
    const registry = registryWith([always('leveling.a', false)]);
    const verdict = await evaluateRequirement(
      registry,
      CTX,
      [spec('leveling.a'), spec('cases.no_active_case')],
      'all',
    );

    expect(verdict.passed).toBe(false);
    expect(verdict.degraded.map((entry) => entry.providerId)).toEqual(['cases.no_active_case']);
  });
});

describe('batch fan-out', () => {
  function contexts(count: number): MemberContext[] {
    return Array.from({ length: count }, (_unused, index) =>
      memberContext({ userId: `9000000000000000${String(index).padStart(2, '0')}` }),
    );
  }

  test('a batch-capable provider is called once for the whole batch', async () => {
    const counted = countingCondition('leveling.level', 'leveling', { cost: 'query' });
    const registry = new ProviderRegistry();
    registry.register({ id: 'leveling', providers: [counted.provider] });

    await evaluateRequirements(registry, contexts(50), [spec('leveling.level')], 'all');

    expect(counted.calls.batch).toBe(1);
    expect(counted.calls.single).toBe(0);
    expect(counted.calls.sizes).toEqual([50]);
  });

  test('revalidating many entrants is O(distinct requirements), not O(entrants)', async () => {
    const a = countingCondition('leveling.level', 'leveling', { cost: 'query' });
    const b = countingCondition('leveling.xp', 'leveling', { cost: 'query' });
    const c = countingCondition('leveling.messages', 'leveling', { cost: 'query' });

    const registry = new ProviderRegistry();
    registry.register({ id: 'leveling', providers: [a.provider, b.provider, c.provider] });

    await evaluateRequirements(
      registry,
      contexts(400),
      [spec('leveling.level'), spec('leveling.xp'), spec('leveling.messages')],
      'all',
      { chunkSize: 1000 },
    );

    expect(a.calls.batch + b.calls.batch + c.calls.batch).toBe(3);
  });

  test('two identical requirements collapse to one call', async () => {
    const counted = countingCondition('leveling.level', 'leveling', { cost: 'query' });
    const registry = new ProviderRegistry();
    registry.register({ id: 'leveling', providers: [counted.provider] });

    await evaluateRequirements(
      registry,
      contexts(10),
      [spec('leveling.level', { min: 5 }), spec('leveling.level', { min: 5 })],
      'all',
    );

    expect(counted.calls.batch).toBe(1);
  });

  test('the same provider with different settings is two calls', async () => {
    const counted = countingCondition('leveling.level', 'leveling', { cost: 'query' });
    const registry = new ProviderRegistry();
    registry.register({ id: 'leveling', providers: [counted.provider] });

    await evaluateRequirements(
      registry,
      contexts(10),
      [spec('leveling.level', { min: 5 }), spec('leveling.level', { min: 10 })],
      'all',
    );

    expect(counted.calls.batch).toBe(2);
  });

  test('a provider without batchEvaluate is fanned out one context at a time', async () => {
    const counted = countingCondition('leveling.level', 'leveling', { batch: false });
    const registry = new ProviderRegistry();
    registry.register({ id: 'leveling', providers: [counted.provider] });

    await evaluateRequirements(registry, contexts(7), [spec('leveling.level')], 'all');

    expect(counted.calls.batch).toBe(0);
    expect(counted.calls.single).toBe(7);
  });

  test('chunking splits the batch but keeps every entrant judged', async () => {
    const counted = countingCondition('leveling.level', 'leveling', { cost: 'query' });
    const registry = new ProviderRegistry();
    registry.register({ id: 'leveling', providers: [counted.provider] });

    const verdicts = await evaluateRequirements(
      registry,
      contexts(25),
      [spec('leveling.level')],
      'all',
      { chunkSize: 10 },
    );

    expect(counted.calls.sizes).toEqual([10, 10, 5]);
    expect(verdicts.size).toBe(25);
  });
});

describe('multiplier stacking', () => {
  function stackRegistry(): ProviderRegistry {
    const registry = new ProviderRegistry();
    registry.register({
      id: 'giveaways',
      providers: [
        fixedMultiplier('giveaways.one', 'giveaways'),
        fixedMultiplier('giveaways.two', 'giveaways'),
        fixedMultiplier('giveaways.three', 'giveaways'),
      ],
    });
    return registry;
  }

  function multiplier(id: string, amount: number, mode: MultiplierSpec['mode']): MultiplierSpec {
    return { providerId: id, config: { amount }, mode };
  }

  test('add mode sums onto the base entry', async () => {
    const weight = await evaluateWeight(stackRegistry(), CTX, [
      multiplier('giveaways.one', 5, 'add'),
      multiplier('giveaways.two', 3, 'add'),
    ]);

    expect(weight.total).toBe(9);
    expect(weight.base).toBe(1);
  });

  test('multiply mode applies after the additions', async () => {
    const weight = await evaluateWeight(stackRegistry(), CTX, [
      multiplier('giveaways.one', 4, 'add'),
      multiplier('giveaways.two', 2, 'multiply'),
    ]);

    expect(weight.total).toBe(10);
  });

  test('max mode takes the single highest within its group instead of stacking', async () => {
    const weight = await evaluateWeight(stackRegistry(), CTX, [
      multiplier('giveaways.one', 5, 'max'),
      multiplier('giveaways.two', 3, 'max'),
      multiplier('giveaways.three', 10, 'max'),
    ]);

    expect(weight.total).toBe(11);
  });

  test('add, multiply and max combine in that order', async () => {
    const weight = await evaluateWeight(stackRegistry(), CTX, [
      multiplier('giveaways.one', 4, 'add'),
      multiplier('giveaways.two', 5, 'max'),
      multiplier('giveaways.three', 2, 'multiply'),
    ]);

    expect(weight.total).toBe(20);
  });

  test('maxEntriesPerUser clamps last', async () => {
    const weight = await evaluateWeight(
      stackRegistry(),
      CTX,
      [multiplier('giveaways.one', 50, 'add'), multiplier('giveaways.two', 3, 'multiply')],
      { maxEntriesPerUser: 10 },
    );

    expect(weight.total).toBe(10);
  });

  test('a qualifying member never falls below one entry', async () => {
    const weight = await evaluateWeight(stackRegistry(), CTX, [
      multiplier('giveaways.one', 0.25, 'multiply'),
    ]);

    expect(weight.total).toBe(1);
  });

  test('the breakdown records every multiplier that applied and sums to the total', async () => {
    const weight = await evaluateWeight(stackRegistry(), CTX, [
      multiplier('giveaways.one', 5, 'add'),
      multiplier('giveaways.two', 3, 'add'),
    ]);

    expect(weight.breakdown).toHaveLength(2);
    const added = weight.breakdown.reduce((sum, entry) => sum + entry.amount, 0);
    expect(weight.base + added).toBe(weight.total);
  });

  test('a multiplier that does not apply leaves no breakdown line', async () => {
    const weight = await evaluateWeight(stackRegistry(), CTX, [
      multiplier('giveaways.one', 0, 'add'),
    ]);

    expect(weight.breakdown).toEqual([]);
    expect(weight.total).toBe(1);
  });

  test('an unloaded multiplier is degraded, and the rest still apply', async () => {
    const weight = await evaluateWeight(stackRegistry(), CTX, [
      multiplier('giveaways.one', 5, 'add'),
      multiplier('leveling.level_tier', 100, 'add'),
    ]);

    expect(weight.total).toBe(6);
    expect(weight.degraded.map((entry) => entry.providerId)).toEqual(['leveling.level_tier']);
  });

  test('weights are computed per member across a batch', async () => {
    const registry = new ProviderRegistry();
    registry.register({
      id: 'giveaways',
      providers: [
        fixedMultiplier('giveaways.byUser', 'giveaways', (ctx, amount) =>
          ctx.userId === USER_A ? amount : 0,
        ),
      ],
    });

    const weights = await evaluateMultipliers(
      registry,
      [memberContext({ userId: USER_A }), memberContext({ userId: USER_B })],
      [{ providerId: 'giveaways.byUser', config: { amount: 9 }, mode: 'add' }],
    );

    expect(weights.get(USER_A)?.total).toBe(10);
    expect(weights.get(USER_B)?.total).toBe(1);
  });
});

describe('rendering', () => {
  test('describeRequirements renders one public line per loaded requirement', () => {
    const registry = new ProviderRegistry();
    const lines = describeRequirements(registry, [
      spec('core.has_role', { roleIds: ['600000000000000000'], mode: 'any' }),
      spec('leveling.level', { min: 5 }),
    ]);

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('<@&600000000000000000>');
  });

  test('describeMultipliers skips what is not loaded', () => {
    const registry = new ProviderRegistry();
    registry.register({
      id: 'giveaways',
      providers: [fixedMultiplier('giveaways.role_bonus', 'giveaways')],
    });

    const lines = describeMultipliers(registry, [
      { providerId: 'giveaways.role_bonus', config: { amount: 5 }, mode: 'add' },
      { providerId: 'leveling.level_tier', config: {}, mode: 'add' },
    ]);

    expect(lines).toEqual(['giveaways.role_bonus gives 5.']);
  });
});
