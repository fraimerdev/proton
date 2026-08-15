export const STEP_BASE = 100;

export const STEP_GROWTH = 50;

export const MAX_LEVEL = 1000;

export const MAX_XP = xpForLevel(MAX_LEVEL);

export function xpForLevel(level: number): number {
  const n = Math.max(0, Math.trunc(level));

  return STEP_BASE * n + (STEP_GROWTH * n * (n - 1)) / 2;
}

export function xpForStep(level: number): number {
  const n = Math.trunc(level);
  return n <= 0 ? 0 : STEP_BASE + STEP_GROWTH * (n - 1);
}

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

export interface LevelProgress {
  level: number;

  into: number;

  span: number;

  remaining: number;
}

export function levelProgress(xp: number): LevelProgress {
  const total = Math.max(0, Math.trunc(xp));
  const level = levelForXp(total);

  if (level >= MAX_LEVEL) return { level, into: total - xpForLevel(level), span: 0, remaining: 0 };

  const floor = xpForLevel(level);
  const span = xpForLevel(level + 1) - floor;

  return { level, into: total - floor, span, remaining: floor + span - total };
}
