import { newId } from '@proton/core';
import { MODULE_ID } from './config.ts';
import type { Ctx } from './perform.ts';
import { nextRun, parseRecurrence } from './prizes.ts';
import type { Giveaway, GiveawayStore } from './store.ts';

export type RecurrenceOutcome =
  | { outcome: 'scheduled'; giveaway: Giveaway }
  | { outcome: 'not-recurring' }
  | { outcome: 'finished' };

/**
 * Creates the *one* next instance when a recurring giveaway ends, and nothing more. §87 warns
 * against an endless recursive scheduler: each run schedules only its successor, and the successor
 * carries a decremented `recurrence_left`, so the chain stops on its own rather than relying on
 * anything remembering to stop it.
 *
 * The successor is created `scheduled`, not `running` — the start job posts and opens it, which is
 * the same path a manually scheduled giveaway takes.
 */
export async function scheduleNextRun(
  ctx: Ctx,
  store: GiveawayStore,
  giveaway: Giveaway,
  startJobId: string,
  now: Date = new Date(),
): Promise<RecurrenceOutcome> {
  const recurrence = parseRecurrence(giveaway.recurrenceConfig);
  if (recurrence === null) return { outcome: 'not-recurring' };

  const durationMs = Math.max(
    60_000,
    giveaway.endsAt.getTime() - (giveaway.startsAt ?? giveaway.createdAt).getTime(),
  );

  const next = nextRun(recurrence, giveaway.recurrenceLeft, giveaway.endedAt ?? now, durationMs);
  if (next === null) return { outcome: 'finished' };

  const id = newId();

  const created = await store.create({
    id,
    guildId: giveaway.guildId,
    channelId: giveaway.channelId,
    messageId: null,
    hostId: giveaway.hostId,
    title: giveaway.title,
    description: giveaway.description,
    bannerUrl: giveaway.bannerUrl,
    color: giveaway.color,
    emoji: giveaway.emoji,
    buttonStyle: giveaway.buttonStyle,
    winnerCount: giveaway.winnerCount,
    requirementLogic: giveaway.requirementLogic,
    requirementTree: giveaway.requirementTree,
    maxEntriesPerUser: giveaway.maxEntriesPerUser,
    verifyOn: giveaway.verifyOn,
    startsAt: next.startsAt,
    endsAt: next.endsAt,
    status: 'scheduled',
    entryMethod: giveaway.entryMethod,
    claimWindowSeconds: giveaway.claimWindowSeconds,
    dmWinners: giveaway.dmWinners,
    winMessage: giveaway.winMessage,
    prizes: giveaway.prizes,
    rewardRoleId: giveaway.rewardRoleId,
    templateId: giveaway.templateId,
    recurrenceConfig: giveaway.recurrenceConfig,
    recurrenceLeft: next.runsLeft,
    createdBy: giveaway.createdBy,
  });

  await ctx.schedule?.(startJobId, next.startsAt, `${MODULE_ID}:${id}:start`, { giveawayId: id });

  return { outcome: 'scheduled', giveaway: created };
}
