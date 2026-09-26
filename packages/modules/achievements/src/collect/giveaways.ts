import {
  giveawayCancelledEventSchema,
  giveawayDropClaimedEventSchema,
  giveawayEndedEventSchema,
  giveawayEnteredEventSchema,
  giveawayRerolledEventSchema,
  type ProtonEvent,
} from '@proton/core';
import type { ActivityRecord } from '../activity.ts';
import type { AchievementsDeps } from '../deps.ts';
import {
  activityRecord,
  type Chain,
  type CollectorEngine,
  type Ctx,
  ENGINE,
  locate,
  mismatchedGuild,
  organicCausation,
  storeOf,
  submit,
  unreadable,
  validRecords,
} from './common.ts';

export const GIVEAWAYS_SOURCE = 'giveaways';

export function giveawayGroup(giveawayId: string): string {
  return `giveaway:${giveawayId}`;
}

function winRecord(
  ctx: Ctx,
  event: ProtonEvent,
  giveawayId: string,
  userId: string,
  occurredAt: number,
  chain: Chain,
): ActivityRecord | null {
  return activityRecord(ctx, {
    userId,
    metric: 'giveaways_won',
    sourceKey: `${giveawayId}:${userId}`,
    occurredAt,
    sourceModule: GIVEAWAYS_SOURCE,
    causation: organicCausation(event.id),
    chain,
  });
}

export async function collectGiveawayEntered(
  ctx: Ctx,
  deps: AchievementsDeps,
  event: ProtonEvent,
  engine: CollectorEngine = ENGINE,
): Promise<void> {
  const parsed = giveawayEnteredEventSchema.safeParse(event.payload);
  if (!parsed.success) {
    unreadable(ctx, 'a giveaway entry', event.id, parsed.error.message);
    return;
  }

  const entry = parsed.data;
  if (mismatchedGuild(ctx, entry.guildId, 'a giveaway entry', event.id)) return;

  const chain = await locate(ctx, deps, ctx.guildId, entry.channelId);
  if (chain === null) return;

  const record = activityRecord(ctx, {
    userId: entry.userId,
    metric: 'giveaways_entered',
    sourceKey: `${entry.giveawayId}:${entry.userId}`,
    occurredAt: entry.activityAt,
    sourceModule: GIVEAWAYS_SOURCE,
    causation: organicCausation(event.id),
    chain,
    groupKey: giveawayGroup(entry.giveawayId),
    pending: true,
  });
  if (!record) return;

  await submit(ctx, deps, engine, { records: [record], originChannelId: entry.channelId });
}

export async function collectGiveawayDrawn(
  ctx: Ctx,
  deps: AchievementsDeps,
  event: ProtonEvent,
  engine: CollectorEngine = ENGINE,
): Promise<void> {
  const schema =
    event.type === 'giveaways.rerolled' ? giveawayRerolledEventSchema : giveawayEndedEventSchema;
  const parsed = schema.safeParse(event.payload);
  if (!parsed.success) {
    unreadable(ctx, 'a giveaway draw', event.id, parsed.error.message);
    return;
  }

  const draw = parsed.data;
  if (mismatchedGuild(ctx, draw.guildId, 'a giveaway draw', event.id)) return;

  const store = storeOf(ctx, deps, 'giveaway counting');
  if (!store) return;

  const released = await store.releasePending(
    ctx.guildId,
    giveawayGroup(draw.giveawayId),
    'count',
    { sourceModule: GIVEAWAYS_SOURCE, causation: organicCausation(event.id) },
  );
  const records = validRecords(ctx, released);

  const chain = await locate(ctx, deps, ctx.guildId, draw.channelId);
  if (chain !== null) {
    for (const winnerId of new Set(draw.winnerIds)) {
      const won = winRecord(ctx, event, draw.giveawayId, winnerId, event.occurredAt, chain);
      if (won) records.push(won);
    }
  }

  await submit(ctx, deps, engine, { records, originChannelId: draw.channelId });
}

export async function collectDropClaimed(
  ctx: Ctx,
  deps: AchievementsDeps,
  event: ProtonEvent,
  engine: CollectorEngine = ENGINE,
): Promise<void> {
  const parsed = giveawayDropClaimedEventSchema.safeParse(event.payload);
  if (!parsed.success) {
    unreadable(ctx, 'a giveaway drop', event.id, parsed.error.message);
    return;
  }

  const drop = parsed.data;
  if (mismatchedGuild(ctx, drop.guildId, 'a giveaway drop', event.id)) return;

  const chain = await locate(ctx, deps, ctx.guildId, drop.channelId);
  if (chain === null) return;

  const won = winRecord(ctx, event, drop.giveawayId, drop.userId, drop.activityAt, chain);
  if (!won) return;

  await submit(ctx, deps, engine, { records: [won], originChannelId: drop.channelId });
}

export async function collectGiveawayCancelled(
  ctx: Ctx,
  deps: AchievementsDeps,
  event: ProtonEvent,
): Promise<void> {
  const parsed = giveawayCancelledEventSchema.safeParse(event.payload);
  if (!parsed.success) {
    unreadable(ctx, 'a giveaway cancellation', event.id, parsed.error.message);
    return;
  }

  const cancelled = parsed.data;
  if (mismatchedGuild(ctx, cancelled.guildId, 'a giveaway cancellation', event.id)) return;

  const store = storeOf(ctx, deps, 'giveaway counting');
  if (!store) return;

  await store.releasePending(ctx.guildId, giveawayGroup(cancelled.giveawayId), 'void', {
    sourceModule: GIVEAWAYS_SOURCE,
    causation: organicCausation(event.id),
  });
}
