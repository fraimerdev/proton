import { describe, expect, test } from 'bun:test';
import fc from 'fast-check';
import { drawWinners, sampleWeighted, type WeightedEntrant } from '../src/draw.ts';
import { newSeed, rngFromSeed, seedFromHex, seedToHex, xoshiro128ss } from '../src/rng.ts';
import {
  canonicalise,
  canonicalOrder,
  isCanonicallyOrdered,
  snapshotHash,
  totalEntriesOf,
} from '../src/snapshot.ts';

const SEED = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';

function pool(count: number): WeightedEntrant[] {
  return Array.from({ length: count }, (_unused, index) => ({
    userId: `4000000000000000${String(index).padStart(2, '0')}`,
    weight: (index % 9) + 1,
  }));
}

describe('seeds', () => {
  test('a seed round-trips through hex', () => {
    const seed = seedFromHex(SEED);

    expect(seedToHex(seed)).toBe(SEED);
    expect(seed).toHaveLength(4);
  });

  test('a generated seed is 32 hex characters and readable back', () => {
    const generated = newSeed();

    expect(generated).toMatch(/^[0-9a-f]{32}$/);
    expect(seedToHex(seedFromHex(generated))).toBe(generated);
  });

  test('anything that is not a seed is refused by name', () => {
    expect(() => seedFromHex('nope')).toThrow(/is not a draw seed/);
    expect(() => seedFromHex(SEED.slice(1))).toThrow(/32 hexadecimal/);
  });

  // Zero state is a fixed point for xoshiro: it would emit zero forever, and every draw would
  // pick whichever entrant the sampler happened to reach first.
  test('an all-zero seed still produces a varying stream', () => {
    const rng = xoshiro128ss(new Uint32Array(4));
    const values = new Set(Array.from({ length: 20 }, () => rng()));

    expect(values.size).toBeGreaterThan(1);
  });

  test('the stream stays inside [0, 1)', () => {
    const rng = rngFromSeed(SEED);

    for (let index = 0; index < 10_000; index += 1) {
      const value = rng();
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });

  test('two seeds that differ by one bit produce different draws', () => {
    const other = `${SEED.slice(0, 31)}1`;

    expect(sampleWeighted(pool(50), 5, rngFromSeed(SEED))).not.toEqual(
      sampleWeighted(pool(50), 5, rngFromSeed(other)),
    );
  });
});

describe('determinism', () => {
  test('the same seed and the same snapshot give identical winners', () => {
    const entrants = pool(500);

    expect(sampleWeighted(entrants, 10, rngFromSeed(SEED))).toEqual(
      sampleWeighted(entrants, 10, rngFromSeed(SEED)),
    );
  });

  test('a stored draw can be reproduced from its seed and snapshot alone', () => {
    const snapshot = canonicalOrder(
      pool(200).map((entrant) => ({ userId: entrant.userId, totalEntries: entrant.weight })),
    );

    const stored = { seed: newSeed(), snapshotHash: snapshotHash(snapshot) };

    const drawn = sampleWeighted(
      snapshot.map((entrant) => ({ userId: entrant.userId, weight: entrant.totalEntries })),
      3,
      rngFromSeed(stored.seed),
    );

    // Everything an auditor has: the seed, and the entrants in whatever order they read them.
    const asAudited = [...snapshot].reverse();
    const replayed = canonicalOrder(asAudited);

    expect(snapshotHash(replayed)).toBe(stored.snapshotHash);
    expect(
      sampleWeighted(
        replayed.map((entrant) => ({ userId: entrant.userId, weight: entrant.totalEntries })),
        3,
        rngFromSeed(stored.seed),
      ),
    ).toEqual(drawn);
  });

  // The failure this guards is silent: the draw still returns winners, they are just not the
  // winners the stored seed says it produced.
  test('drawing out of canonical order produces different winners', () => {
    const snapshot = canonicalOrder(
      pool(200).map((entrant) => ({ userId: entrant.userId, totalEntries: entrant.weight })),
    );
    const seed = newSeed();

    const inOrder = sampleWeighted(
      snapshot.map((entrant) => ({ userId: entrant.userId, weight: entrant.totalEntries })),
      3,
      rngFromSeed(seed),
    );
    const shuffled = sampleWeighted(
      [...snapshot]
        .reverse()
        .map((entrant) => ({ userId: entrant.userId, weight: entrant.totalEntries })),
      3,
      rngFromSeed(seed),
    );

    expect(shuffled).not.toEqual(inOrder);
  });

  test('canonicalOrder is what the store contract has to produce', () => {
    // Ids of different lengths: '4000000000000000199' sorts before '400000000000000024', which
    // is exactly the trap an entrant list built in insertion order walks into.
    const snapshot = pool(200).map((entrant) => ({
      userId: entrant.userId,
      totalEntries: entrant.weight,
    }));

    expect(isCanonicallyOrdered(snapshot)).toBe(false);
    expect(isCanonicallyOrdered(canonicalOrder(snapshot))).toBe(true);
  });

  test('determinism holds for arbitrary pools and seeds', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(
          fc.record({
            userId: fc.string({ minLength: 1, maxLength: 6 }),
            weight: fc.integer({ min: 1, max: 100 }),
          }),
          { minLength: 1, maxLength: 40, selector: (entrant) => entrant.userId },
        ),
        fc.integer({ min: 1, max: 10 }),
        fc.nat(),
        (entrants, k, seed) => {
          const words = () => Uint32Array.from([seed, seed ^ 0x9e3779b9, 7, 11]);

          const first = sampleWeighted(entrants, k, xoshiro128ss(words()));
          const second = sampleWeighted(entrants, k, xoshiro128ss(words()));

          return JSON.stringify(first) === JSON.stringify(second);
        },
      ),
      { numRuns: 300 },
    );
  });
});

describe('snapshots', () => {
  const entrants = [
    { userId: '400000000000000002', totalEntries: 3 },
    { userId: '400000000000000001', totalEntries: 5 },
  ];

  test('canonical order is by user id, whatever order the rows arrived in', () => {
    expect(canonicalise(entrants)).toBe('400000000000000001:5\n400000000000000002:3');
    expect(canonicalise([...entrants].reverse())).toBe(canonicalise(entrants));
  });

  test('the hash is stable across row order', () => {
    expect(snapshotHash([...entrants].reverse())).toBe(snapshotHash(entrants));
  });

  // The draw consumes the random stream once per entrant, so a changed weight changes the
  // winners. The hash has to notice, or "reproduce this draw" proves nothing.
  test('changing one entrant weight changes the hash', () => {
    const altered = entrants.map((entrant, index) =>
      index === 1 ? { ...entrant, totalEntries: 6 } : entrant,
    );

    expect(snapshotHash(altered)).not.toBe(snapshotHash(entrants));
  });

  test('adding an entrant changes the hash', () => {
    expect(snapshotHash([...entrants, { userId: '400000000000000003', totalEntries: 1 }])).not.toBe(
      snapshotHash(entrants),
    );
  });

  test('the hash is a sha256 digest', () => {
    expect(snapshotHash(entrants)).toMatch(/^[0-9a-f]{64}$/);
  });

  test('total entries is the sum of the snapshot', () => {
    expect(totalEntriesOf(entrants)).toBe(8);
    expect(totalEntriesOf([])).toBe(0);
  });
});

describe('distinct winners and exclusions', () => {
  test('N winners are always distinct', () => {
    const winners = sampleWeighted(pool(1_000), 25, rngFromSeed(SEED));

    expect(new Set(winners).size).toBe(25);
  });

  test('asking for more winners than entrants returns each entrant once', () => {
    const winners = sampleWeighted(pool(4), 50, rngFromSeed(SEED));

    expect(winners).toHaveLength(4);
    expect(new Set(winners).size).toBe(4);
  });

  test('a reroll excludes the previous winners', () => {
    const entrants = pool(20);
    const first = drawWinners(entrants, 3, rngFromSeed(SEED));
    const second = drawWinners(entrants, 3, rngFromSeed(SEED), { exclude: first });

    expect(second.some((userId) => first.includes(userId))).toBe(false);
    expect(second).toHaveLength(3);
  });

  test('excluding everybody draws nobody', () => {
    const entrants = pool(5);

    expect(
      drawWinners(entrants, 3, rngFromSeed(SEED), {
        exclude: entrants.map((entrant) => entrant.userId),
      }),
    ).toEqual([]);
  });
});

describe('streaming', () => {
  // Never expanding weights into an array is a locked decision: a giveaway where ten thousand
  // people each hold fifty entries would otherwise build a five hundred thousand element array.
  test('the pool is walked exactly once and never expanded by weight', () => {
    let reads = 0;

    function* counted(): Generator<WeightedEntrant> {
      for (const entrant of pool(5_000)) {
        reads += 1;
        yield { ...entrant, weight: entrant.weight * 1_000 };
      }
    }

    const winners = sampleWeighted(counted(), 10, rngFromSeed(SEED));

    expect(reads).toBe(5_000);
    expect(winners).toHaveLength(10);
  });

  test('it accepts an iterable that can only be consumed once', () => {
    const entrants = pool(100);
    const once = entrants[Symbol.iterator]();

    expect(sampleWeighted({ [Symbol.iterator]: () => once }, 5, rngFromSeed(SEED))).toHaveLength(5);
  });
});
