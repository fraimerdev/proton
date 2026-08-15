import { describe, expect, test } from 'bun:test';
import fc from 'fast-check';
import {
  levelForXp,
  levelProgress,
  MAX_LEVEL,
  MAX_XP,
  STEP_BASE,
  STEP_GROWTH,
  xpForLevel,
  xpForStep,
} from '../src/curve.ts';

describe('xpForLevel', () => {
  test('level 0 costs nothing, so a member’s first message announces nothing', () => {
    expect(xpForLevel(0)).toBe(0);
  });

  test('the first level costs the base step', () => {
    expect(xpForLevel(1)).toBe(STEP_BASE);
  });

  test('each step costs growth more than the one before it', () => {
    expect(xpForStep(1)).toBe(STEP_BASE);
    expect(xpForStep(2)).toBe(STEP_BASE + STEP_GROWTH);
    expect(xpForStep(3)).toBe(STEP_BASE + 2 * STEP_GROWTH);
  });

  test('there is no step into level 0', () => {
    expect(xpForStep(0)).toBe(0);
    expect(xpForStep(-5)).toBe(0);
  });

  test('a negative level reads as 0 rather than a negative cost', () => {
    expect(xpForLevel(-3)).toBe(0);
  });

  test('the ceiling leaves int4 headroom', () => {
    expect(MAX_XP).toBe(xpForLevel(MAX_LEVEL));
    expect(MAX_XP).toBeLessThan(2_147_483_647 / 10);
  });
});

describe('levelForXp', () => {
  test('below the first step is level 0', () => {
    expect(levelForXp(0)).toBe(0);
    expect(levelForXp(STEP_BASE - 1)).toBe(0);
  });

  test('exactly the threshold is the new level, not one below it', () => {
    expect(levelForXp(xpForLevel(5))).toBe(5);
    expect(levelForXp(xpForLevel(5) - 1)).toBe(4);
  });

  test('clamps at the ceiling rather than growing forever', () => {
    expect(levelForXp(MAX_XP)).toBe(MAX_LEVEL);
    expect(levelForXp(MAX_XP * 2)).toBe(MAX_LEVEL);
  });

  test('nonsense input reads as level 0 instead of NaN', () => {
    expect(levelForXp(Number.NaN)).toBe(0);
    expect(levelForXp(Number.POSITIVE_INFINITY)).toBe(0);
    expect(levelForXp(-100)).toBe(0);
  });
});

describe('curve properties', () => {
  test('levelForXp is the exact inverse of xpForLevel', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: MAX_LEVEL }), (level) => {
        expect(levelForXp(xpForLevel(level))).toBe(level);
      }),
    );
  });

  test('one XP below a threshold is the previous level', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: MAX_LEVEL }), (level) => {
        expect(levelForXp(xpForLevel(level) - 1)).toBe(level - 1);
      }),
    );
  });

  test('more XP never means a lower level', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: MAX_XP }),
        fc.integer({ min: 0, max: 10_000 }),
        (xp, extra) => {
          expect(levelForXp(xp + extra)).toBeGreaterThanOrEqual(levelForXp(xp));
        },
      ),
    );
  });

  test('the computed level’s floor is never above the XP that produced it', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: MAX_XP }), (xp) => {
        expect(xpForLevel(levelForXp(xp))).toBeLessThanOrEqual(xp);
      }),
    );
  });

  test('every level is strictly more expensive than the last', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: MAX_LEVEL }), (level) => {
        expect(xpForLevel(level)).toBeGreaterThan(xpForLevel(level - 1));
      }),
    );
  });

  test('every value is an integer, so nothing rounds differently in two processes', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: MAX_LEVEL }), (level) => {
        expect(Number.isInteger(xpForLevel(level))).toBe(true);
      }),
    );
  });
});

describe('levelProgress', () => {
  test('reports the position inside the current level', () => {
    const progress = levelProgress(xpForLevel(3) + 10);

    expect(progress.level).toBe(3);
    expect(progress.into).toBe(10);
    expect(progress.span).toBe(xpForStep(4));
    expect(progress.remaining).toBe(xpForStep(4) - 10);
  });

  test('a member exactly on a threshold has made no progress into it', () => {
    const progress = levelProgress(xpForLevel(7));

    expect(progress.into).toBe(0);
    expect(progress.remaining).toBe(progress.span);
  });

  test('at the ceiling there is no next step to report', () => {
    const progress = levelProgress(MAX_XP + 5_000);

    expect(progress.level).toBe(MAX_LEVEL);
    expect(progress.span).toBe(0);
    expect(progress.remaining).toBe(0);
  });

  test('into and remaining always account for exactly one step', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: MAX_XP - 1 }), (xp) => {
        const progress = levelProgress(xp);
        expect(progress.into + progress.remaining).toBe(progress.span);
      }),
    );
  });
});
