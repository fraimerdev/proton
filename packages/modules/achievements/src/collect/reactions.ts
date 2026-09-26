import type { ProtonEvent } from '@proton/core';
import type { ActivityRecord } from '../activity.ts';
import { MODULE_ID } from '../config.ts';
import {
  REACTION_MAX_AGE_MS,
  REACTIONS_GIVEN_DAILY_CAP,
  REACTIONS_PAIR_DAILY_CAP,
} from '../constants.ts';
import { type AchievementsDeps, bindLimits, clockOf, describeUnbound } from '../deps.ts';
import {
  activityRecord,
  type CollectorEngine,
  type Ctx,
  cachesOf,
  DISCORD_SOURCE,
  dayKey,
  ENGINE,
  excludedByRole,
  isProton,
  locate,
  type MemberPayload,
  objectAt,
  organicCausation,
  own,
  readMember,
  rememberFacts,
  snowflakeTime,
  storeOf,
  subjectOf,
  submit,
  text,
} from './common.ts';

export const REACTIONS_GIVEN_PREFIX = 'proton:achievements:reactions-given';
export const REACTIONS_PAIR_PREFIX = 'proton:achievements:reactions-pair';

const CAP_WINDOW_MS = 2 * 24 * 60 * 60 * 1000;

export interface SeenReaction {
  reactorId: string;
  channelId: string;
  messageId: string;
  authorId: string | null;
  reactorBot: boolean | null;
  member: MemberPayload;
}

export function readReaction(payload: unknown): SeenReaction | null {
  const reactorId = text(payload, 'user_id');
  const channelId = text(payload, 'channel_id');
  const messageId = text(payload, 'message_id');
  if (reactorId === null || channelId === null || messageId === null) return null;

  const member = objectAt(payload, 'member');
  const bot = own(objectAt(member, 'user'), 'bot');

  return {
    reactorId,
    channelId,
    messageId,
    authorId: text(payload, 'message_author_id'),
    reactorBot: typeof bot === 'boolean' ? bot : null,
    member: readMember(member),
  };
}

export async function collectReaction(
  ctx: Ctx,
  deps: AchievementsDeps,
  event: ProtonEvent,
  engine: CollectorEngine = ENGINE,
): Promise<void> {
  if (event.guildId === null) return;

  const reaction = readReaction(event.payload);
  if (reaction === null || reaction.reactorBot === true) return;

  const authorId = reaction.authorId;
  if (authorId === null || authorId === reaction.reactorId || isProton(deps, authorId)) return;

  const sentAt = snowflakeTime(reaction.messageId);
  if (sentAt === null || event.occurredAt - sentAt > REACTION_MAX_AGE_MS) return;

  const caches = cachesOf(deps);
  const pairKey = `${ctx.guildId}:${reaction.messageId}:${reaction.reactorId}`;
  const earlier = caches.reactions.get(pairKey, clockOf(deps)());
  if (earlier && earlier.value !== event.id) return;

  const store = storeOf(ctx, deps, 'reaction counting');
  if (!store) return;

  await rememberFacts(deps, store, ctx.guildId, reaction.reactorId, reaction.member);

  const chain = await locate(ctx, deps, ctx.guildId, reaction.channelId);
  if (chain === null) return;

  const bound = bindLimits(deps);
  if ('unbound' in bound) {
    ctx.logger.error(describeUnbound('reaction counting', bound.unbound), {
      guildId: ctx.guildId,
      moduleId: MODULE_ID,
    });
    return;
  }

  const day = dayKey(event.occurredAt, ctx.config.timezone);
  const shared = {
    sourceKey: `${reaction.messageId}:${reaction.reactorId}`,
    occurredAt: event.occurredAt,
    sourceModule: DISCORD_SOURCE,
    causation: organicCausation(event.id),
    chain,
  };
  const records: ActivityRecord[] = [];

  if (!excludedByRole(ctx.config, reaction.member.roleIds)) {
    const given = await bound.limits.count(
      `${REACTIONS_GIVEN_PREFIX}:${ctx.guildId}:${reaction.reactorId}:${day}`,
      CAP_WINDOW_MS,
    );
    if (given <= REACTIONS_GIVEN_DAILY_CAP) {
      const record = activityRecord(ctx, {
        ...shared,
        userId: reaction.reactorId,
        metric: 'reactions_given',
      });
      if (record) records.push(record);
    }
  }

  const fromReactor = await bound.limits.count(
    `${REACTIONS_PAIR_PREFIX}:${ctx.guildId}:${reaction.reactorId}:${authorId}:${day}`,
    CAP_WINDOW_MS,
  );
  if (fromReactor <= REACTIONS_PAIR_DAILY_CAP) {
    const record = activityRecord(ctx, {
      ...shared,
      userId: authorId,
      metric: 'reactions_received',
    });
    if (record) records.push(record);
  }

  await submit(ctx, deps, engine, {
    records,
    subjects: new Map([[reaction.reactorId, subjectOf(reaction.member, reaction.reactorBot)]]),
    originChannelId: reaction.channelId,
  });

  caches.reactions.set(pairKey, event.id, clockOf(deps)());
}
