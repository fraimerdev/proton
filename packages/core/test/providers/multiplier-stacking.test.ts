import { describe, expect, test } from 'bun:test';
import fc from 'fast-check';
import {
  evaluateWeight,
  type MultiplierMode,
  type MultiplierSpec,
} from '../../src/providers/evaluate.ts';
import { ProviderRegistry } from '../../src/providers/registry.ts';
import { fixedMultiplier, memberContext } from './harness.ts';

const MODES: MultiplierMode[] = ['add', 'multiply', 'max'];

/**
 * One provider per mode. Stacking is a property of the evaluator, not of any provider, so the
 * providers here do nothing but return the amount they were configured with.
 */
function registryOf(): ProviderRegistry {
  const registry = new ProviderRegistry();

  registry.register({
    id: 'leveling',
    providers: MODES.map((mode) => fixedMultiplier(`leveling.stack_${mode}`, 'leveling')),
  });

  return registry;
}

function spec(mode: MultiplierMode, amount: number): MultiplierSpec {
  return { providerId: `leveling.stack_${mode}`, config: { amount }, mode };
}

async function weigh(
  specs: readonly MultiplierSpec[],
  options: { base?: number; maxEntriesPerUser?: number | null } = {},
) {
  return evaluateWeight(registryOf(), memberContext(), specs, options);
}

describe('the stacking contract', () => {
  // total = (base + Σadd + max(max-group)) × Πmultiply, floored, then capped.
  test('add sums onto the base', async () => {
    expect((await weigh([spec('add', 3), spec('add', 4)])).total).toBe(8);
  });

  test('multiply applies to the whole sum, not to each term', async () => {
    expect((await weigh([spec('add', 3), spec('multiply', 2)])).total).toBe(8);
  });

  // The tier-ladder case: five overlapping tiers must award the highest, not all five.
  test('max collapses its own group to the single largest', async () => {
    expect((await weigh([spec('max', 2), spec('max', 5), spec('max', 3)])).total).toBe(6);
  });

  test('max contributes once alongside add rather than replacing it', async () => {
    expect((await weigh([spec('add', 3), spec('max', 5)])).total).toBe(9);
  });

  test('the three modes compose in the documented order', async () => {
    const weight = await weigh([
      spec('add', 3),
      spec('max', 5),
      spec('max', 2),
      spec('multiply', 2),
    ]);

    expect(weight.total).toBe((1 + 3 + 5) * 2);
  });

  test('a zero amount is skipped rather than recorded as a bonus', async () => {
    const weight = await weigh([spec('add', 0), spec('add', 4)]);

    expect(weight.total).toBe(5);
    expect(weight.breakdown).toHaveLength(1);
  });

  test('the breakdown names every multiplier that actually applied', async () => {
    const weight = await weigh([spec('add', 3), spec('multiply', 2)]);

    expect(weight.breakdown.map((row) => row.mode).sort()).toEqual(['add', 'multiply']);
    expect(weight.breakdown.every((row) => row.label.length > 0)).toBe(true);
  });
});

describe('the guards', () => {
  test.each([
    ['negative', -5],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['-Infinity', Number.NEGATIVE_INFINITY],
  ] as const)(
    'a %s multiply amount cannot drag the total below the base',
    async (_label, amount) => {
      expect((await weigh([spec('multiply', amount)])).total).toBeGreaterThanOrEqual(1);
    },
  );

  test('a fractional total is floored, never rounded up', async () => {
    expect((await weigh([spec('multiply', 1.9)], { base: 3 })).total).toBe(5);
  });

  test('the cap is the last thing applied', async () => {
    const weight = await weigh([spec('add', 500), spec('multiply', 10)], {
      maxEntriesPerUser: 100,
    });

    expect(weight.total).toBe(100);
  });

  // A member who cleared every requirement has earned their entry; a multiply below one must not
  // silently remove them from the draw they just qualified for.
  test('a qualifying member never falls out of the draw', async () => {
    expect((await weigh([spec('multiply', 0.01)])).total).toBe(1);
  });
});

describe('stacking properties', () => {
  const arbSpecs = fc.array(
    fc.record({
      mode: fc.constantFrom<MultiplierMode>('add', 'multiply', 'max'),
      amount: fc.integer({ min: 1, max: 20 }),
    }),
    { maxLength: 8 },
  );

  test('the total never drops below the base', async () => {
    await fc.assert(
      fc.asyncProperty(arbSpecs, async (rows) => {
        const weight = await weigh(rows.map((row) => spec(row.mode, row.amount)));
        return weight.total >= 1;
      }),
      { numRuns: 200 },
    );
  });

  test('the cap is never exceeded, whatever the combination', async () => {
    await fc.assert(
      fc.asyncProperty(arbSpecs, fc.integer({ min: 1, max: 50 }), async (rows, cap) => {
        const weight = await weigh(
          rows.map((row) => spec(row.mode, row.amount)),
          {
            maxEntriesPerUser: cap,
          },
        );
        return weight.total <= cap;
      }),
      { numRuns: 200 },
    );
  });

  // Two hosts who add the same multipliers in a different order must get the same draw weights,
  // or the giveaway's odds depend on the order somebody clicked through a builder.
  test('reordering the specs does not change the total', async () => {
    await fc.assert(
      fc.asyncProperty(arbSpecs, async (rows) => {
        const specs = rows.map((row) => spec(row.mode, row.amount));
        const forwards = await weigh(specs);
        const backwards = await weigh([...specs].reverse());

        return forwards.total === backwards.total;
      }),
      { numRuns: 200 },
    );
  });

  test('adding a smaller max than one already present changes nothing', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 2, max: 20 }),
        fc.integer({ min: 1, max: 1 }),
        async (big, small) => {
          const alone = await weigh([spec('max', big)]);
          const withSmaller = await weigh([spec('max', big), spec('max', small)]);

          return alone.total === withSmaller.total;
        },
      ),
      { numRuns: 100 },
    );
  });
});
