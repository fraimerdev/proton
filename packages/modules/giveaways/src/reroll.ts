import { type DrawDeps, type DrawSummary, drawGiveaway } from './end.ts';
import type { Giveaway } from './store.ts';

export type RerollOutcome =
  | { outcome: 'rerolled'; giveaway: Giveaway; summary: DrawSummary }
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
  const giveaway = await deps.store.get(input.guildId, input.giveawayId);
  if (!giveaway) return { outcome: 'missing' };
  if (giveaway.status === 'running') return { outcome: 'still-running', giveaway };

  const previous = input.allowRepeat
    ? []
    : (await deps.store.winners(giveaway.id))
        .filter((win) => win.rerolledAt === null)
        .map((win) => win.userId);

  // A reroll re-enters the same state machine rather than drawing straight from the table: a
  // second reroll firing at the same moment has to lose the same way a second end call does.
  await deps.store.finishDraw(input.guildId, giveaway.id, 'running', null);

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

  return drawn.summary.winnerIds.length === 0
    ? { outcome: 'nobody-left', giveaway: drawn.giveaway, summary: drawn.summary }
    : { outcome: 'rerolled', giveaway: drawn.giveaway, summary: drawn.summary };
}
