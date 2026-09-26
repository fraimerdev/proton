import { type ProtonEvent, starboardMessagePostedSchema } from '@proton/core';
import type { AchievementsDeps } from '../deps.ts';
import {
  activityRecord,
  type CollectorEngine,
  type Ctx,
  ENGINE,
  isProton,
  locate,
  mismatchedGuild,
  organicCausation,
  submit,
  unreadable,
} from './common.ts';

export const STARBOARD_SOURCE = 'starboard';

export async function collectStarboardPost(
  ctx: Ctx,
  deps: AchievementsDeps,
  event: ProtonEvent,
  engine: CollectorEngine = ENGINE,
): Promise<void> {
  const parsed = starboardMessagePostedSchema.safeParse(event.payload);
  if (!parsed.success) {
    unreadable(ctx, 'a starboard post', event.id, parsed.error.message);
    return;
  }

  const post = parsed.data;
  if (mismatchedGuild(ctx, post.guildId, 'a starboard post', event.id)) return;
  if (post.authorBot || isProton(deps, post.authorId)) return;

  const chain = await locate(ctx, deps, ctx.guildId, post.sourceChannelId);
  if (chain === null) return;

  const record = activityRecord(ctx, {
    userId: post.authorId,
    metric: 'starboard_messages',
    sourceKey: post.sourceMessageId,
    occurredAt: post.activityAt,
    sourceModule: STARBOARD_SOURCE,
    causation: organicCausation(event.id),
    chain,
  });
  if (!record) return;

  await submit(ctx, deps, engine, { records: [record], originChannelId: post.sourceChannelId });
}
