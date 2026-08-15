import { describe, expect, test } from 'bun:test';
import {
  MAX_JOIN_SCORE,
  MAX_SINGLE_SIGNAL_WEIGHT,
  MIN_ACTIONABLE_SCORE,
  type ScoreSettings,
  SIGNAL_WEIGHTS,
  scoreJoin,
} from '../src/score.ts';

const DAY = 24 * 60 * 60 * 1000;

const SETTINGS: ScoreSettings = {
  joinThreshold: 10,
  joinWindow: '10s',
  newAccountMs: 7 * DAY,
  brandNewAccountMs: DAY,
};

function ordinary() {
  return { joinsInWindow: 1, accountAgeMs: 365 * DAY, avatarless: false };
}

describe('signal weights', () => {
  test('no single signal reaches the lowest threshold a guild may configure', () => {
    expect(MIN_ACTIONABLE_SCORE).toBeGreaterThan(MAX_SINGLE_SIGNAL_WEIGHT);
    for (const weight of Object.values(SIGNAL_WEIGHTS)) {
      expect(weight).toBeLessThan(MIN_ACTIONABLE_SCORE);
    }
  });

  test('every reachable combination scoring high enough has at least two signals', () => {
    const ages = [365 * DAY, 3 * DAY, 2 * 60 * 60 * 1000];
    let checked = 0;

    for (const joinsInWindow of [1, 10]) {
      for (const accountAgeMs of ages) {
        for (const avatarless of [false, true]) {
          const scored = scoreJoin({ joinsInWindow, accountAgeMs, avatarless }, SETTINGS);
          const signals =
            (joinsInWindow >= SETTINGS.joinThreshold ? 1 : 0) +
            (accountAgeMs < SETTINGS.newAccountMs ? 1 : 0) +
            (avatarless ? 1 : 0);

          if (scored.score >= MIN_ACTIONABLE_SCORE) expect(signals).toBeGreaterThanOrEqual(2);
          checked++;
        }
      }
    }

    expect(checked).toBe(12);
  });
});

describe('scoreJoin', () => {
  test('an ordinary join scores nothing and says nothing', () => {
    const scored = scoreJoin(ordinary(), SETTINGS);
    expect(scored).toEqual({ score: 0, burst: false, reasons: [] });
  });

  test('a brand-new account with no avatar scores higher than either signal alone', () => {
    const brandNew = scoreJoin({ ...ordinary(), accountAgeMs: 2 * 60 * 60 * 1000 }, SETTINGS);
    const avatarless = scoreJoin({ ...ordinary(), avatarless: true }, SETTINGS);
    const both = scoreJoin(
      { joinsInWindow: 1, accountAgeMs: 2 * 60 * 60 * 1000, avatarless: true },
      SETTINGS,
    );

    expect(both.score).toBeGreaterThan(brandNew.score);
    expect(both.score).toBeGreaterThan(avatarless.score);
    expect(both.score).toBe(brandNew.score + avatarless.score);

    expect(both.score).toBeGreaterThanOrEqual(MIN_ACTIONABLE_SCORE);
  });

  test('brand new replaces new rather than stacking with it', () => {
    const brandNew = scoreJoin({ ...ordinary(), accountAgeMs: 60 * 60 * 1000 }, SETTINGS);

    expect(brandNew.score).toBe(SIGNAL_WEIGHTS.brandNewAccount);
    expect(brandNew.score).toBeLessThan(MIN_ACTIONABLE_SCORE);
    expect(brandNew.reasons).toHaveLength(1);
  });

  test('an account between the two cutoffs scores the lighter weight', () => {
    const scored = scoreJoin({ ...ordinary(), accountAgeMs: 3 * DAY }, SETTINGS);
    expect(scored.score).toBe(SIGNAL_WEIGHTS.newAccount);
    expect(scored.reasons[0]).toContain('this server treats as new');
  });

  test('the burst signal turns on at the threshold, not one past it', () => {
    expect(scoreJoin({ ...ordinary(), joinsInWindow: 9 }, SETTINGS).burst).toBe(false);
    const at = scoreJoin({ ...ordinary(), joinsInWindow: 10 }, SETTINGS);
    expect(at.burst).toBe(true);
    expect(at.score).toBe(SIGNAL_WEIGHTS.joinBurst);
    expect(at.reasons[0]).toContain('10 accounts joined within 10s');
  });

  test('everything at once is the documented ceiling', () => {
    const scored = scoreJoin(
      { joinsInWindow: 40, accountAgeMs: 60_000, avatarless: true },
      SETTINGS,
    );
    expect(scored.score).toBe(MAX_JOIN_SCORE);
    expect(scored.reasons).toHaveLength(3);
  });

  test('facts that could not be read score nothing and say so', () => {
    const scored = scoreJoin({ joinsInWindow: 1, accountAgeMs: null, avatarless: null }, SETTINGS);

    expect(scored.score).toBe(0);
    expect(scored.reasons).toEqual([
      'The account age could not be read from the user id, so it was not weighed.',
      'The join carried no user object, so the avatar was not weighed.',
    ]);
  });
});
