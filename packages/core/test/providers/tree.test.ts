import { describe, expect, test } from 'bun:test';
import fc from 'fast-check';
import { ProviderRegistry } from '../../src/providers/registry.ts';
import {
  countLeaves,
  depthOf,
  describeTree,
  distinctLeaves,
  evaluateTree,
  type RequirementNode,
  requirementTreeSchema,
  TREE_MAX_DEPTH,
  treeFromFlat,
} from '../../src/providers/tree.ts';
import type { MemberContext } from '../../src/providers/types.ts';
import { countingCondition, memberContext } from './harness.ts';

const GUILD = '100000000000000000';

function userId(index: number): string {
  return String(400000000000000000n + BigInt(index));
}

function ctxs(count: number): MemberContext[] {
  return Array.from({ length: count }, (_, index) => ({
    ...memberContext(),
    guildId: GUILD,
    userId: userId(index),
  }));
}

/**
 * Passes when the member's index is at least `min`, which lets a test say exactly who should pass
 * a given leaf without writing a bespoke provider each time.
 */
function registryOf(): { registry: ProviderRegistry; calls: () => number } {
  const registry = new ProviderRegistry();

  const counted = countingCondition('leveling.threshold', 'leveling', {
    passes: (ctx, min) => indexOf(ctx.userId) >= min,
  });

  registry.register({ id: 'leveling', providers: [counted.provider] });

  return { registry, calls: () => counted.calls.batch + counted.calls.single };
}

function indexOf(id: string): number {
  return Number(BigInt(id) - 400000000000000000n);
}

function leaf(min: number): RequirementNode {
  return { kind: 'leaf', providerId: 'leveling.threshold', config: { min } };
}

function group(logic: 'all' | 'any' | 'none', ...children: RequirementNode[]): RequirementNode {
  return { kind: 'group', logic, children };
}

async function verdictFor(tree: RequirementNode, count = 4) {
  const { registry } = registryOf();
  return evaluateTree(registry, ctxs(count), tree);
}

describe('the tree schema', () => {
  test('a flat list becomes a one-level group', () => {
    const tree = treeFromFlat([{ providerId: 'a', config: {} }], 'all');

    expect(depthOf(tree)).toBe(1);
    expect(countLeaves(tree)).toBe(1);
  });

  test('a valid nested tree parses', () => {
    const tree = group('all', group('any', leaf(0), leaf(1)), leaf(2));

    expect(requirementTreeSchema.safeParse(tree).success).toBe(true);
  });

  test('a bare leaf is a valid tree', () => {
    expect(requirementTreeSchema.safeParse(leaf(0)).success).toBe(true);
  });

  // A hand-edited jsonb blob nesting a thousand groups must be refused by the parse, not walked.
  test('nesting past the depth limit is refused', () => {
    let tree: RequirementNode = leaf(0);
    for (let level = 0; level <= TREE_MAX_DEPTH + 1; level += 1) tree = group('all', tree);

    expect(requirementTreeSchema.safeParse(tree).success).toBe(false);
  });

  test('an empty group is refused', () => {
    expect(
      requirementTreeSchema.safeParse({ kind: 'group', logic: 'all', children: [] }).success,
    ).toBe(false);
  });

  test('an unknown logic is refused', () => {
    expect(
      requirementTreeSchema.safeParse({ kind: 'group', logic: 'maybe', children: [leaf(0)] })
        .success,
    ).toBe(false);
  });
});

describe('folding the tree', () => {
  // The member's index is their level, so leaf(2) passes for members 2 and 3 of four.
  test('ALL needs every child', async () => {
    const verdicts = await verdictFor(group('all', leaf(1), leaf(3)));

    expect(verdicts.get(userId(3))?.passed).toBe(true);
    expect(verdicts.get(userId(2))?.passed).toBe(false);
    expect(verdicts.get(userId(0))?.passed).toBe(false);
  });

  test('ANY needs one child', async () => {
    const verdicts = await verdictFor(group('any', leaf(1), leaf(3)));

    expect(verdicts.get(userId(1))?.passed).toBe(true);
    expect(verdicts.get(userId(0))?.passed).toBe(false);
  });

  test('NONE is the exact negation of ANY', async () => {
    const tree = group('any', leaf(1), leaf(3));
    const negated = group('none', leaf(1), leaf(3));

    const yes = await verdictFor(tree);
    const no = await verdictFor(negated);

    for (let index = 0; index < 4; index += 1) {
      expect(no.get(userId(index))?.passed).toBe(!yes.get(userId(index))?.passed);
    }
  });

  test('nested groups compose', async () => {
    // (level >= 3 OR level >= 2) AND level >= 1
    const tree = group('all', group('any', leaf(3), leaf(2)), leaf(1));
    const verdicts = await verdictFor(tree);

    expect(verdicts.get(userId(2))?.passed).toBe(true);
    expect(verdicts.get(userId(1))?.passed).toBe(false);
  });

  test('a failing leaf explains itself', async () => {
    const verdicts = await verdictFor(group('all', leaf(3)));

    expect(verdicts.get(userId(0))?.failures).toHaveLength(1);
    expect(verdicts.get(userId(0))?.failures[0]?.providerId).toBe('leveling.threshold');
  });

  // GIVEAWAYS.md §2: an unavailable provider is skipped and the draw marked degraded. Failing it
  // closed would disqualify every entrant because one module happened to be switched off.
  test('a leaf whose provider is missing is skipped, not failed closed', async () => {
    const registry = new ProviderRegistry();
    const verdicts = await evaluateTree(registry, ctxs(2), group('all', leaf(0)));

    expect(verdicts.get(userId(0))?.degraded).toHaveLength(1);
    expect(verdicts.get(userId(0))?.passed).toBe(true);
    expect(verdicts.get(userId(0))?.indeterminate).toBe(false);
  });

  test('a skipped leaf beside a live one leaves the live one deciding', async () => {
    const { registry } = registryOf();
    const tree = group('all', leaf(3), { kind: 'leaf', providerId: 'gone.away', config: {} });

    const verdicts = await evaluateTree(registry, ctxs(4), tree);

    expect(verdicts.get(userId(3))?.passed).toBe(true);
    expect(verdicts.get(userId(0))?.passed).toBe(false);
    expect(verdicts.get(userId(0))?.degraded).toHaveLength(1);
  });

  // "Ran and could not answer" is not the same as "could not run": an unanswerable rule holds the
  // verdict up, because the member might have passed it.
  test('a leaf that ran but could not answer leaves the tree undecided', async () => {
    const registry = new ProviderRegistry();

    registry.register({
      id: 'leveling',
      providers: [
        {
          ...countingCondition('leveling.threshold', 'leveling').provider,
          async evaluate() {
            return { passed: false, indeterminate: { humanReason: 'no intent' } };
          },
          async batchEvaluate(batch: readonly MemberContext[]) {
            return new Map(
              batch.map((ctx) => [
                ctx.userId,
                { passed: false, indeterminate: { humanReason: 'no intent' } },
              ]),
            );
          },
        },
      ],
    });

    const verdicts = await evaluateTree(registry, ctxs(2), group('all', leaf(0)));

    expect(verdicts.get(userId(0))?.passed).toBe(false);
    expect(verdicts.get(userId(0))?.indeterminate).toBe(true);
    expect(verdicts.get(userId(0))?.failures).toHaveLength(1);
  });
});

describe('the batching guarantee', () => {
  // The whole reason the tree is flattened before it is folded: a recursive per-entrant evaluator
  // turns a 10,000-entrant draw into 30,000 queries.
  test('10,000 entrants through a three-leaf tree is three provider calls', async () => {
    const { registry, calls } = registryOf();
    const tree = group('all', group('any', leaf(1), leaf(2)), leaf(3));

    await evaluateTree(registry, ctxs(10_000), tree, { chunkSize: 10_000 });

    expect(calls()).toBe(3);
  });

  test('chunking multiplies calls by chunks, not by entrants', async () => {
    const { registry, calls } = registryOf();

    await evaluateTree(registry, ctxs(1_000), group('all', leaf(1)), { chunkSize: 500 });

    expect(calls()).toBe(2);
  });

  // Two branches asking the same question are one evaluation.
  test('a duplicated leaf is evaluated once', async () => {
    const { registry, calls } = registryOf();
    const tree = group('all', leaf(1), group('any', leaf(1), leaf(1)));

    await evaluateTree(registry, ctxs(10), tree, { chunkSize: 10 });

    expect(distinctLeaves(tree)).toHaveLength(1);
    expect(calls()).toBe(1);
  });
});

describe('a flat tree matches the legacy flat path', () => {
  const arbLevels = fc.array(fc.integer({ min: 0, max: 5 }), { minLength: 1, maxLength: 5 });

  test('an ALL group agrees with requiring every rule', async () => {
    await fc.assert(
      fc.asyncProperty(arbLevels, async (levels) => {
        const verdicts = await verdictFor(group('all', ...levels.map(leaf)), 6);

        for (let index = 0; index < 6; index += 1) {
          const expected = levels.every((level) => index >= level);
          if (verdicts.get(userId(index))?.passed !== expected) return false;
        }

        return true;
      }),
      { numRuns: 100 },
    );
  });

  test('an ANY group agrees with requiring one rule', async () => {
    await fc.assert(
      fc.asyncProperty(arbLevels, async (levels) => {
        const verdicts = await verdictFor(group('any', ...levels.map(leaf)), 6);

        for (let index = 0; index < 6; index += 1) {
          const expected = levels.some((level) => index >= level);
          if (verdicts.get(userId(index))?.passed !== expected) return false;
        }

        return true;
      }),
      { numRuns: 100 },
    );
  });
});

describe('describing a tree', () => {
  function described(tree: RequirementNode): string[] {
    const { registry } = registryOf();
    return describeTree(registry, tree);
  }

  test('a flat ALL group reads as a plain list', () => {
    const lines = described(group('all', leaf(1), leaf(2)));

    expect(lines).toHaveLength(2);
    expect(lines.every((line) => line.startsWith('•'))).toBe(true);
  });

  test('a nested group names its logic', () => {
    const lines = described(group('all', group('any', leaf(1), leaf(2)), leaf(3)));

    expect(lines.join('\n')).toContain('any one of');
  });

  test('a NONE group says so', () => {
    expect(described(group('all', group('none', leaf(1)), leaf(2))).join('\n')).toContain(
      'none of',
    );
  });

  test('a single-child group is not given a line of its own', () => {
    const lines = described(group('all', group('any', leaf(1))));

    expect(lines.join('\n')).not.toContain('any one of');
  });

  test('a leaf whose provider is missing is left out rather than rendered blank', () => {
    const registry = new ProviderRegistry();

    expect(describeTree(registry, group('all', leaf(1)))).toEqual([]);
  });
});
