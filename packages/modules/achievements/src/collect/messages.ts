import {
  isBoostMessageType,
  isHumanMessage,
  type ProtonEvent,
  tryParseDuration,
} from '@proton/core';
import type { ActivityRecord } from '../activity.ts';
import { MODULE_ID } from '../config.ts';
import { type AchievementsDeps, bindLimits, describeUnbound } from '../deps.ts';
import { collectBoostNotice } from './boosts.ts';
import {
  activeDayRecord,
  activityRecord,
  type CollectorEngine,
  type Ctx,
  DISCORD_SOURCE,
  ENGINE,
  excludedByRole,
  isProton,
  locate,
  type MemberPayload,
  markActiveDays,
  objectAt,
  organicCausation,
  own,
  readMember,
  rememberFacts,
  storeOf,
  subjectOf,
  submit,
  text,
} from './common.ts';

export const MESSAGE_COOLDOWN_PREFIX = 'proton:achievements:msgcd';

export interface SeenMessage {
  messageId: string;
  channelId: string;
  authorId: string;
  isBot: boolean;
  isWebhook: boolean;
  type: number;
  member: MemberPayload;
}

export function readMessage(payload: unknown): SeenMessage | null {
  const messageId = text(payload, 'id');
  const channelId = text(payload, 'channel_id');
  const author = objectAt(payload, 'author');
  const authorId = text(author, 'id');
  if (messageId === null || channelId === null || authorId === null) return null;

  const type = own(payload, 'type');
  return {
    messageId,
    channelId,
    authorId,
    isBot: own(author, 'bot') === true,
    isWebhook: typeof own(payload, 'webhook_id') === 'string',
    type: typeof type === 'number' ? type : 0,
    member: readMember(own(payload, 'member')),
  };
}

async function outsideCooldown(
  ctx: Ctx,
  deps: AchievementsDeps,
  message: SeenMessage,
): Promise<boolean> {
  const cooldownMs = tryParseDuration(ctx.config.messageCooldown) ?? 0;
  if (cooldownMs <= 0) return true;

  const bound = bindLimits(deps);
  if ('unbound' in bound) {
    ctx.logger.error(describeUnbound('message counting', bound.unbound), {
      guildId: ctx.guildId,
      moduleId: MODULE_ID,
    });
    return false;
  }

  return bound.limits.claim(
    `${MESSAGE_COOLDOWN_PREFIX}:${ctx.guildId}:${message.authorId}`,
    message.messageId,
    cooldownMs,
  );
}

export async function collectMessage(
  ctx: Ctx,
  deps: AchievementsDeps,
  event: ProtonEvent,
  engine: CollectorEngine = ENGINE,
): Promise<void> {
  if (event.guildId === null) return;

  const message = readMessage(event.payload);
  if (message === null) return;
  if (message.isBot || message.isWebhook || isProton(deps, message.authorId)) return;

  if (isBoostMessageType(message.type)) {
    await collectBoostNotice(ctx, deps, event, message, engine);
    return;
  }
  if (!isHumanMessage(message.type)) return;

  const store = storeOf(ctx, deps, 'message counting');
  if (!store) return;

  await rememberFacts(deps, store, ctx.guildId, message.authorId, message.member);

  if (excludedByRole(ctx.config, message.member.roleIds)) return;

  const chain = await locate(ctx, deps, ctx.guildId, message.channelId);
  if (chain === null) return;

  const causation = organicCausation(event.id);
  const records: ActivityRecord[] = [];

  if (await outsideCooldown(ctx, deps, message)) {
    const counted = activityRecord(ctx, {
      userId: message.authorId,
      metric: 'messages',
      sourceKey: message.messageId,
      occurredAt: event.occurredAt,
      sourceModule: DISCORD_SOURCE,
      causation,
      chain,
    });
    if (counted) records.push(counted);
  }

  const day = activeDayRecord(ctx, deps, {
    userId: message.authorId,
    occurredAt: event.occurredAt,
    sourceModule: DISCORD_SOURCE,
    causation,
    chain,
  });
  if (day) records.push(day.record);

  await submit(ctx, deps, engine, {
    records,
    subjects: new Map([[message.authorId, subjectOf(message.member, false)]]),
    originChannelId: message.channelId,
  });

  if (day) markActiveDays(deps, [day.mark]);
}
