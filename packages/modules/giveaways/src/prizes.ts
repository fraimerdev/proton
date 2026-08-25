import { snowflakeSchema } from '@proton/core';
import { z } from 'zod';
import { DAY_MS, TITLE_MAX } from './config.ts';

export const PRIZE_LIST_MAX = 25;

/**
 * An ordered prize list. Winner *i* takes prize *i*, so the order is the meaning — §54's
 * "1× Nitro, 2× gift card, 5× role" is three entries with counts, flattened at draw time.
 */
export const prizeSchema = z.object({
  label: z.string().min(1).max(TITLE_MAX),
  count: z.number().int().min(1).max(50).default(1),
});

export const prizeListSchema = z.array(prizeSchema).min(1).max(PRIZE_LIST_MAX);

export type Prize = z.infer<typeof prizeSchema>;

export const RECURRENCE_MIN_MS = 60 * 60 * 1000;
export const RECURRENCE_MAX_MS = 56 * DAY_MS;
export const RECURRENCE_MAX_RUNS = 52;

/**
 * Deliberately not a cron expression: `ScheduledJob` cron is guild-agnostic in this repo, so a
 * recurring giveaway has to chain through the per-guild `ctx.schedule` row mechanism instead. An
 * interval plus a bound is what that can express, and a bound is what stops it running forever.
 */
export const recurrenceSchema = z
  .object({
    everyMs: z.number().int().min(RECURRENCE_MIN_MS).max(RECURRENCE_MAX_MS),
    runs: z.number().int().min(1).max(RECURRENCE_MAX_RUNS).optional(),
    until: z.number().int().positive().optional(),
  })
  .refine((value) => value.runs !== undefined || value.until !== undefined, {
    message: 'A recurring giveaway needs either a number of runs or a date to stop on.',
  });

export type Recurrence = z.infer<typeof recurrenceSchema>;

/** Expands the prize list to one entry per winner, so winner *i* can be told what they won. */
export function prizesForWinners(
  prizes: readonly Prize[] | null,
  winnerCount: number,
  fallback: string,
): string[] {
  if (prizes === null || prizes.length === 0) {
    return Array.from({ length: winnerCount }, () => fallback);
  }

  const flattened: string[] = [];
  for (const prize of prizes) {
    for (let index = 0; index < prize.count; index += 1) flattened.push(prize.label);
  }

  // Fewer prizes than winners falls back for the remainder rather than handing somebody
  // `undefined` — the winner count is what the host promised, and it wins.
  return Array.from({ length: winnerCount }, (_, index) => flattened[index] ?? fallback);
}

export function describePrizes(prizes: readonly Prize[] | null, fallback: string): string {
  if (prizes === null || prizes.length === 0) return fallback;
  if (prizes.length === 1 && prizes[0]?.count === 1) return prizes[0].label;

  return prizes.map((prize) => `${prize.count}× ${prize.label}`).join(', ');
}

export function totalPrizeCount(prizes: readonly Prize[] | null): number {
  if (prizes === null) return 0;
  return prizes.reduce((sum, prize) => sum + prize.count, 0);
}

export interface NextRun {
  startsAt: Date;
  endsAt: Date;
  runsLeft: number | null;
}

/**
 * The next instance, or null when the recurrence has run out. Called once when a giveaway ends —
 * never a scheduler that reschedules itself indefinitely, which is what §87 warns against.
 */
export function nextRun(
  recurrence: Recurrence,
  runsLeft: number | null,
  endedAt: Date,
  durationMs: number,
): NextRun | null {
  const remaining = runsLeft ?? recurrence.runs ?? null;
  if (remaining !== null && remaining <= 1) return null;

  const startsAt = new Date(endedAt.getTime() + recurrence.everyMs);
  if (recurrence.until !== undefined && startsAt.getTime() > recurrence.until) return null;

  return {
    startsAt,
    endsAt: new Date(startsAt.getTime() + durationMs),
    runsLeft: remaining === null ? null : remaining - 1,
  };
}

export function parsePrizes(raw: unknown): Prize[] | null {
  if (raw === null || raw === undefined) return null;

  const parsed = prizeListSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

export function parseRecurrence(raw: unknown): Recurrence | null {
  if (raw === null || raw === undefined) return null;

  const parsed = recurrenceSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

export const rewardRoleSchema = snowflakeSchema;
