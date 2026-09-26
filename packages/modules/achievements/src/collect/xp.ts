import { type ProtonEvent, xpAwardedSchema, xpLevelGainedSchema } from '@proton/core';
import type { AchievementsDeps } from '../deps.ts';
import {
  activeUsing,
  activityRecord,
  type Chain,
  type CollectorEngine,
  type Ctx,
  continuedCausation,
  ENGINE,
  locate,
  mismatchedGuild,
  NO_CHANNEL,
  organicCausation,
  submit,
  unreadable,
} from './common.ts';

export const LEVELING_SOURCE = 'leveling';

export async function collectXpAwarded(
  ctx: Ctx,
  deps: AchievementsDeps,
  event: ProtonEvent,
  engine: CollectorEngine = ENGINE,
): Promise<void> {
  const parsed = xpAwardedSchema.safeParse(event.payload);
  if (!parsed.success) {
    unreadable(ctx, 'an XP award', event.id, parsed.error.message);
    return;
  }

  const award = parsed.data;
  if (mismatchedGuild(ctx, award.guildId, 'an XP award', event.id)) return;

  let chain: Chain = NO_CHANNEL;
  if (award.channelId !== undefined) {
    const located = await locate(ctx, deps, ctx.guildId, award.channelId);
    if (located === null) return;
    chain = located;
  }

  const record = activityRecord(ctx, {
    userId: award.userId,
    metric: 'activity_xp',
    sourceKey: event.id,
    occurredAt: award.activityAt,
    amount: award.amount,
    xpSource: award.source,
    sourceModule: LEVELING_SOURCE,
    causation: continuedCausation(award.causation),
    chain,
  });
  if (!record) return;

  await submit(ctx, deps, engine, {
    records: [record],
    originChannelId: award.source === 'message' ? (award.channelId ?? null) : null,
  });
}

export async function collectLevelGained(
  ctx: Ctx,
  deps: AchievementsDeps,
  event: ProtonEvent,
  engine: CollectorEngine = ENGINE,
): Promise<void> {
  const parsed = xpLevelGainedSchema.safeParse(event.payload);
  if (!parsed.success) {
    unreadable(ctx, 'a level-up', event.id, parsed.error.message);
    return;
  }

  const gained = parsed.data;
  if (mismatchedGuild(ctx, gained.guildId, 'a level-up', event.id)) return;

  const achievementIds = activeUsing(
    ctx.config,
    (requirement) => requirement.trigger === 'leveling.level',
  );
  if (achievementIds.length === 0) return;

  await engine.evaluateMember(ctx, deps, {
    userId: gained.userId,
    achievementIds,
    stateValues: { level: gained.level },
    originChannelId: gained.channelId ?? null,
    occurredAt: event.occurredAt,
    causation: gained.causation ? continuedCausation(gained.causation) : organicCausation(event.id),
  });
}
