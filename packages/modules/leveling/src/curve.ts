/**
 * Proton's XP curve.
 *
 * Original arithmetic, per PLAN.md §1 — no other product's formula is
 * reproduced here, and none needs to be, because the shape is a design choice
 * rather than a discovery.
 *
 * **The shape.** Each level costs a little more than the one before it, by a
 * *constant* amount:
 *
 *     step(n)       = STEP_BASE + STEP_GROWTH · (n − 1)      // level n−1 → n
 *     xpForLevel(n) = STEP_BASE · n + STEP_GROWTH · n(n−1)/2 // total to reach n
 *
 * so the running total is a quadratic and the per-level cost is a straight line.
 * With the shipped constants that is 25n² + 75n: level 1 costs 100 XP, level 10
 * a cumulative 3 250, level 50 a cumulative 66 250.
 *
 * Two properties made this the choice over the cubic totals engagement bots
 * usually reach for:
 *
 *  - **It is exactly invertible in integers.** A quadratic total has a closed
 *    form inverse, so `levelForXp` is arithmetic rather than a search or a
 *    lookup table — and `packages/db`'s award statement can stay one statement
 *    with the level derived afterwards instead of a table join per message.
 *  - **It stays reachable.** A cubic total means the hundredth level costs
 *    roughly a hundred times the first, which reads as a ladder nobody finishes;
 *    linear step growth keeps late levels expensive without making them
 *    theoretical. `MAX_LEVEL` is where it stops being either.
 *
 * Everything here is pure and integer-valued: no clock, no config, no rounding
 * that depends on the order values arrive in. Two Proton processes computing a
 * member's level from the same XP always agree, which is what lets the level
 * column in Postgres be a cache rather than a source of truth.
 */

/** XP to go from level 0 to level 1. Every later step is this plus growth. */
export const STEP_BASE = 100;

/** How much more each level costs than the one before it. */
export const STEP_GROWTH = 50;

/**
 * The ceiling.
 *
 * Not an arbitrary round number: `xpForLevel(1000)` is 25 075 000, which leaves
 * `members.xp` (an int4, max 2 147 483 647) two orders of magnitude of headroom
 * for a member who keeps chatting past the cap. A curve with no ceiling would
 * eventually overflow that column, and an overflow on the hottest write path in
 * the system is a crash per message rather than a wrong number.
 *
 * Past the cap XP still accrues and the level simply stops moving, so nothing
 * breaks and nothing lies — `/rank` shows the XP it actually has.
 */
export const MAX_LEVEL = 1000;

/** XP at which the level stops moving. Also the ceiling `/xp set` accepts. */
export const MAX_XP = xpForLevel(MAX_LEVEL);

/**
 * Total XP required to have reached `level`.
 *
 * `xpForLevel(0)` is 0: a member with no XP is level 0, not level 1, so the
 * first message a guild ever sees does not announce a level-up.
 */
export function xpForLevel(level: number): number {
  const n = Math.max(0, Math.trunc(level));
  // n(n−1) is always even, so the halving is exact and the result is an integer
  // without a rounding step that could disagree with the inverse below.
  return STEP_BASE * n + (STEP_GROWTH * n * (n - 1)) / 2;
}

/** XP required to go from `level - 1` to `level`. Zero at level 0. */
export function xpForStep(level: number): number {
  const n = Math.trunc(level);
  return n <= 0 ? 0 : STEP_BASE + STEP_GROWTH * (n - 1);
}

/**
 * The highest level `xp` has reached — the exact inverse of `xpForLevel`,
 * clamped at `MAX_LEVEL`.
 *
 * Solving `a·n² + b·n = xp` with `a = STEP_GROWTH/2` and `b = STEP_BASE −
 * STEP_GROWTH/2` gives the candidate directly, but `Math.sqrt` is a float and
 * the answer must be exact at the boundaries — level 5 has to begin at exactly
 * `xpForLevel(5)`, not one XP either side of it, or a member watches their
 * level flicker. So the closed form only *seeds* the answer and the two `while`
 * loops settle it against `xpForLevel` itself, which is integer arithmetic. They
 * iterate at most once in practice; they exist so that "at most once" does not
 * have to be assumed.
 */
export function levelForXp(xp: number): number {
  const total = Math.trunc(xp);
  if (!Number.isFinite(total) || total < STEP_BASE) return 0;

  const a = STEP_GROWTH / 2;
  const b = STEP_BASE - STEP_GROWTH / 2;
  const seed = Math.floor((Math.sqrt(b * b + 4 * a * total) - b) / (2 * a));

  let level = Math.min(MAX_LEVEL, Math.max(0, seed));
  while (level > 0 && xpForLevel(level) > total) level--;
  while (level < MAX_LEVEL && xpForLevel(level + 1) <= total) level++;

  return level;
}

/** Where a member stands inside their current level — what `/rank` renders. */
export interface LevelProgress {
  level: number;
  /** XP earned since reaching `level`. */
  into: number;
  /** XP the whole step costs. Zero at `MAX_LEVEL`, where there is no next step. */
  span: number;
  /** XP still needed for the next level. Zero at `MAX_LEVEL`. */
  remaining: number;
}

export function levelProgress(xp: number): LevelProgress {
  const total = Math.max(0, Math.trunc(xp));
  const level = levelForXp(total);

  // At the ceiling there is no next level to be a fraction of the way towards,
  // and reporting `remaining: 0` out of `span: 0` is the honest answer rather
  // than a progress bar that sits at 100% forever pretending one exists.
  if (level >= MAX_LEVEL) return { level, into: total - xpForLevel(level), span: 0, remaining: 0 };

  const floor = xpForLevel(level);
  const span = xpForLevel(level + 1) - floor;

  return { level, into: total - floor, span, remaining: floor + span - total };
}
