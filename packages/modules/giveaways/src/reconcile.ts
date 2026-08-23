import type { DirtyCounts } from './counter.ts';
import type { Giveaway, GiveawayStore, WinRecord } from './store.ts';

// A worker that dies mid-draw leaves a row in `drawing` that nothing else will touch. Long enough
// that a slow legitimate draw is never stolen; short enough that a crash is not a stuck giveaway.
export const STALE_DRAW_AFTER_MS = 10 * 60_000;

export interface ReconcileDeps {
  store: GiveawayStore;
  dirty?: DirtyCounts;
  now?: () => number;
  staleAfterMs?: number;
  limit?: number;
}

export interface ReconcileResult {
  overdue: Giveaway[];
  released: string[];
  finished: string[];
  expiredClaims: WinRecord[];
  remarked: number;
}

/**
 * Runs at boot and then on a slow schedule. The table is the source of truth about what should
 * have happened; the durable schedule is only a reminder, and a reminder can be lost.
 *
 * Every branch is a conditional update, so running this on every worker at once is safe.
 */
export async function reconcile(deps: ReconcileDeps): Promise<ReconcileResult> {
  const now = new Date(deps.now?.() ?? Date.now());
  const limit = deps.limit ?? 100;
  const staleBefore = new Date(now.getTime() - (deps.staleAfterMs ?? STALE_DRAW_AFTER_MS));

  const released: string[] = [];
  const finished: string[] = [];

  for (const stalled of await deps.store.stalledDraws(staleBefore, limit)) {
    // The asymmetry that matters: a draw row means winners already exist, so the recovery
    // finishes forward. Re-drawing would hand the prize to somebody else.
    if (stalled.drawn) {
      await deps.store.finishDraw(stalled.giveaway.guildId, stalled.giveaway.id, 'ended', now);
      finished.push(stalled.giveaway.id);
      continue;
    }

    if (await deps.store.releaseDraw(stalled.giveaway.guildId, stalled.giveaway.id)) {
      released.push(stalled.giveaway.id);
    }
  }

  const overdue = await deps.store.overdue(now, limit);
  const expiredClaims = await deps.store.expiredClaims(now, limit);

  let remarked = 0;
  if (deps.dirty) {
    // A count that went stale during a total outage self-heals on the next flush rather than
    // sitting wrong until somebody else joins.
    for (const giveaway of await deps.store.running(limit)) {
      await deps.dirty.mark(giveaway.id);
      remarked += 1;
    }
  }

  return { overdue, released, finished, expiredClaims, remarked };
}
