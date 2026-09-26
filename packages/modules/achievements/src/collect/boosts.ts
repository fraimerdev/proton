import type { ProtonEvent } from '@proton/core';
import type { ActivityRecord } from '../activity.ts';
import type { AchievementsDeps } from '../deps.ts';
import {
  activityRecord,
  type CollectorEngine,
  type Ctx,
  DISCORD_SOURCE,
  excludedByRole,
  type MemberPayload,
  organicCausation,
  rememberFacts,
  storeOf,
  subjectOf,
  submit,
} from './common.ts';

export interface BoostSighting {
  userId: string;
  member: MemberPayload;
  originChannelId: string | null;
}

export function boostRecord(
  ctx: Ctx,
  userId: string,
  premiumSince: number,
  eventId: string,
): ActivityRecord | null {
  return activityRecord(ctx, {
    userId,
    metric: 'boosts',
    sourceKey: `${userId}:${premiumSince}`,
    occurredAt: premiumSince,
    sourceModule: DISCORD_SOURCE,
    causation: organicCausation(eventId),
  });
}

export async function collectBoost(
  ctx: Ctx,
  deps: AchievementsDeps,
  event: ProtonEvent,
  sighting: BoostSighting,
  engine: CollectorEngine,
): Promise<void> {
  const premiumSince = sighting.member.premiumSince;
  if (premiumSince === undefined || premiumSince === null) return;
  if (excludedByRole(ctx.config, sighting.member.roleIds)) return;

  const record = boostRecord(ctx, sighting.userId, premiumSince, event.id);
  if (!record) return;

  await submit(ctx, deps, engine, {
    records: [record],
    subjects: new Map([[sighting.userId, subjectOf(sighting.member, false)]]),
    originChannelId: sighting.originChannelId,
  });
}

export async function collectBoostNotice(
  ctx: Ctx,
  deps: AchievementsDeps,
  event: ProtonEvent,
  notice: { authorId: string; channelId: string; member: MemberPayload },
  engine: CollectorEngine,
): Promise<void> {
  const store = storeOf(ctx, deps, 'boost counting');
  if (!store) return;

  await rememberFacts(deps, store, ctx.guildId, notice.authorId, notice.member);
  await collectBoost(
    ctx,
    deps,
    event,
    { userId: notice.authorId, member: notice.member, originChannelId: notice.channelId },
    engine,
  );
}
