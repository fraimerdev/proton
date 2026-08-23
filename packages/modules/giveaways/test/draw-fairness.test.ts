import { describe, expect, test } from 'bun:test';
import fc from 'fast-check';
import { sampleWeighted, type WeightedEntrant } from '../src/draw.ts';
import { rngFromSeed, seedToHex, xoshiro128ss } from '../src/rng.ts';

const TRIALS = 100_000;

function seedAt(index: number): string {
  return seedToHex(
    Uint32Array.from([
      0x9e3779b9 ^ index,
      0x243f6a88 ^ (index * 2654435761),
      0xb7e15162 ^ (index * 40503),
      0x85ebca6b ^ (index * 2246822519),
    ]),
  );
}

function entrants(weights: Record<string, number>): WeightedEntrant[] {
  return Object.entries(weights).map(([userId, weight]) => ({ userId, weight }));
}

function frequencies(
  pool: WeightedEntrant[],
  k: number,
  pick: (winners: string[]) => string | undefined,
  trials = TRIALS,
): Map<string, number> {
  const counts = new Map<string, number>();

  for (let trial = 0; trial < trials; trial += 1) {
    const winner = pick(sampleWeighted(pool, k, rngFromSeed(seedAt(trial))));
    if (winner === undefined) continue;

    counts.set(winner, (counts.get(winner) ?? 0) + 1);
  }

  return new Map([...counts].map(([userId, count]) => [userId, count / trials]));
}

// A biased draw is the worst possible bug in this module, so the tolerance is set by the sampling
// error of 100k trials (~0.0016 at four sigma for p around 0.1), not by what happens to pass.
const TOLERANCE = 0.006;

describe('draw fairness', () => {
  const POOL = entrants({ a: 1, b: 2, c: 3, d: 4 });
  const TOTAL = 10;

  test('with one winner, each entrant wins at a rate of w / total', () => {
    const observed = frequencies(POOL, 1, (winners) => winners[0]);

    for (const entrant of POOL) {
      expect(observed.get(entrant.userId) ?? 0).toBeCloseTo(entrant.weight / TOTAL, 2);
      expect(Math.abs((observed.get(entrant.userId) ?? 0) - entrant.weight / TOTAL)).toBeLessThan(
        TOLERANCE,
      );
    }
  });

  // For k > 1 the marginal chance of appearing anywhere in the sample is NOT k*w/total — that is
  // the successive-sampling distribution, not a scaled proportion. What is exactly w/total is the
  // FIRST draw, and that is what this asserts.
  test('with several winners, the first winner is still drawn at w / total', () => {
    const observed = frequencies(POOL, 3, (winners) => winners[0]);

    for (const entrant of POOL) {
      expect(Math.abs((observed.get(entrant.userId) ?? 0) - entrant.weight / TOTAL)).toBeLessThan(
        TOLERANCE,
      );
    }
  });

  test('the second winner is drawn proportionally to the weights that are left', () => {
    const counts = new Map<string, { seen: number; second: Map<string, number> }>();

    for (let trial = 0; trial < TRIALS; trial += 1) {
      const winners = sampleWeighted(POOL, 2, rngFromSeed(seedAt(trial)));
      const [first, second] = winners;
      if (first === undefined || second === undefined) continue;

      const bucket = counts.get(first) ?? { seen: 0, second: new Map<string, number>() };
      bucket.seen += 1;
      bucket.second.set(second, (bucket.second.get(second) ?? 0) + 1);
      counts.set(first, bucket);
    }

    for (const [first, bucket] of counts) {
      const remaining = TOTAL - (POOL.find((e) => e.userId === first)?.weight ?? 0);

      for (const entrant of POOL) {
        if (entrant.userId === first) {
          expect(bucket.second.get(entrant.userId) ?? 0).toBe(0);
          continue;
        }

        const observed = (bucket.second.get(entrant.userId) ?? 0) / bucket.seen;
        expect(Math.abs(observed - entrant.weight / remaining)).toBeLessThan(0.02);
      }
    }
  });

  test('equal weights degenerate to a uniform draw', () => {
    const pool = entrants({ a: 1, b: 1, c: 1, d: 1, e: 1 });
    const observed = frequencies(pool, 1, (winners) => winners[0]);

    for (const entrant of pool) {
      expect(Math.abs((observed.get(entrant.userId) ?? 0) - 0.2)).toBeLessThan(TOLERANCE);
    }
  });

  test('a heavily weighted entrant does not swamp the rest beyond its share', () => {
    const pool = entrants({ whale: 999, minnow: 1 });
    const observed = frequencies(pool, 1, (winners) => winners[0], 20_000);

    expect(observed.get('minnow') ?? 0).toBeGreaterThan(0);
    expect(Math.abs((observed.get('whale') ?? 0) - 0.999)).toBeLessThan(0.005);
  });

  test('weight zero is never drawn', () => {
    const pool = entrants({ a: 5, ghost: 0 });

    for (let trial = 0; trial < 2_000; trial += 1) {
      expect(sampleWeighted(pool, 2, rngFromSeed(seedAt(trial)))).toEqual(['a']);
    }
  });
});

describe('draw invariants for every input', () => {
  const arbEntrants = fc
    .uniqueArray(
      fc.record({
        userId: fc.string({ minLength: 1, maxLength: 8 }),
        weight: fc.integer({ min: 0, max: 5_000 }),
      }),
      { minLength: 1, maxLength: 60, selector: (entrant) => entrant.userId },
    )
    .filter((pool) => pool.some((entrant) => entrant.weight > 0));

  test('winners are always distinct', () => {
    fc.assert(
      fc.property(arbEntrants, fc.integer({ min: 1, max: 20 }), fc.nat(), (pool, k, seed) => {
        const winners = sampleWeighted(pool, k, xoshiro128ss(Uint32Array.from([seed, 1, 2, 3])));
        return new Set(winners).size === winners.length;
      }),
      { numRuns: 400 },
    );
  });

  test('winners are always drawn from the pool, and never from its zero weights', () => {
    fc.assert(
      fc.property(arbEntrants, fc.integer({ min: 1, max: 20 }), fc.nat(), (pool, k, seed) => {
        const eligible = new Set(
          pool.filter((entrant) => entrant.weight > 0).map((entrant) => entrant.userId),
        );

        return sampleWeighted(pool, k, xoshiro128ss(Uint32Array.from([seed, 1, 2, 3]))).every(
          (userId) => eligible.has(userId),
        );
      }),
      { numRuns: 400 },
    );
  });

  test('the sample size is min(k, eligible entrants)', () => {
    fc.assert(
      fc.property(arbEntrants, fc.integer({ min: 1, max: 80 }), fc.nat(), (pool, k, seed) => {
        const eligible = pool.filter((entrant) => entrant.weight > 0).length;
        const winners = sampleWeighted(pool, k, xoshiro128ss(Uint32Array.from([seed, 1, 2, 3])));

        return winners.length === Math.min(k, eligible);
      }),
      { numRuns: 400 },
    );
  });

  test('asking for no winners draws nobody', () => {
    fc.assert(
      fc.property(arbEntrants, fc.nat(), (pool, seed) => {
        return (
          sampleWeighted(pool, 0, xoshiro128ss(Uint32Array.from([seed, 1, 2, 3]))).length === 0
        );
      }),
      { numRuns: 100 },
    );
  });
});
