import { type DrawDeps, type DrawSummary, drawGiveaway } from './end.ts';
import type { Giveaway } from './store.ts';

export type RerollOutcome =
  | { outcome: 'rerolled'; giveaway: Giveaway; summary: DrawSummary; replaced: string[] }
  | { outcome: 'still-running'; giveaway: Giveaway }
  | { outcome: 'cancelled'; giveaway: Giveaway }
  | { outcome: 'nobody-left'; giveaway: Giveaway; summary: DrawSummary }
  | { outcome: 'missing' };

export interface RerollInput {
  guildId: string;
  giveawayId: string;
  drawnBy: string;
  count?: number;
  reason?: string;
  allowRepeat?: boolean;
}

export async function rerollGiveaway(deps: DrawDeps, input: RerollInput): Promise<RerollOutcome> {
  const now = new Date(deps.now?.() ?? Date.now());

  const giveaway = await deps.store.get(input.guildId, input.giveawayId);
  if (!giveaway) return { outcome: 'missing' };
  if (giveaway.status === 'cancelled') return { outcome: 'cancelled', giveaway };
  if (giveaway.status !== 'ended') return { outcome: 'still-running', giveaway };

  const standing = await deps.store.winners(giveaway.id);

  // Everyone who has ever won, not everyone whose win has not been rerolled: a replaced winner
  // has already had their draw, and rerolling them back in is the bug the exclusion prevents.
  const previous = input.allowRepeat ? [] : standing.map((win) => win.userId);

  // A reroll re-enters the same state machine rather than drawing straight from the table: a
  // second reroll firing at the same moment has to lose the same way a second end call does.
  const reopened = await deps.store.finishDraw(
    input.guildId,
    giveaway.id,
    ['ended'],
    'running',
    null,
  );

  if (!reopened) {
    const current = await deps.store.get(input.guildId, giveaway.id);
    if (!current) return { outcome: 'missing' };

    return current.status === 'cancelled'
      ? { outcome: 'cancelled', giveaway: current }
      : { outcome: 'still-running', giveaway: current };
  }

  const drawn = await drawGiveaway(deps, {
    guildId: input.guildId,
    giveawayId: input.giveawayId,
    drawnBy: input.drawnBy,
    reason: input.reason ?? 'reroll',
    exclude: previous,
    ...(input.count !== undefined ? { winnerCount: input.count } : {}),
  });

  if (drawn.outcome !== 'drawn') {
    return drawn.outcome === 'missing'
      ? { outcome: 'missing' }
      : { outcome: 'still-running', giveaway: drawn.giveaway };
  }

  if (drawn.summary.winnerIds.length === 0) {
    return { outcome: 'nobody-left', giveaway: drawn.giveaway, summary: drawn.summary };
  }

  // Stamped only once a replacement actually exists, so the history says which win was superseded
  // and by which draw rather than marking one away on a reroll that found nobody.
  const superseded = standing.filter((win) => win.rerolledAt === null);
  for (const drawId of new Set(superseded.map((win) => win.drawId))) {
    await deps.store.markRerolled(
      drawId,
      superseded.filter((win) => win.drawId === drawId).map((win) => win.userId),
      now,
    );
  }

  return {
    outcome: 'rerolled',
    giveaway: drawn.giveaway,
    summary: drawn.summary,
    replaced: superseded.map((win) => win.userId),
  };
}
