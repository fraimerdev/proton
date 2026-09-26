import type { ProtonEvent } from '@proton/core';
import type { AchievementsDeps } from '../deps.ts';
import { collectBoost } from './boosts.ts';
import {
  type CollectorEngine,
  type Ctx,
  ENGINE,
  forgetFacts,
  type MemberPayload,
  objectAt,
  own,
  readMember,
  rememberFacts,
  storeOf,
  text,
} from './common.ts';

interface MemberEvent {
  userId: string;
  isBot: boolean;
  member: MemberPayload;
}

function readMemberEvent(payload: unknown): MemberEvent | null {
  const user = objectAt(payload, 'user');
  const userId = text(user, 'id');
  if (userId === null) return null;

  return { userId, isBot: own(user, 'bot') === true, member: readMember(payload) };
}

export async function collectMemberJoined(
  ctx: Ctx,
  deps: AchievementsDeps,
  event: ProtonEvent,
): Promise<void> {
  if (event.guildId === null) return;

  const joined = readMemberEvent(event.payload);
  if (joined === null || joined.isBot) return;

  const store = storeOf(ctx, deps, 'membership tracking');
  if (!store) return;

  await rememberFacts(deps, store, ctx.guildId, joined.userId, joined.member);
}

export async function collectMemberUpdated(
  ctx: Ctx,
  deps: AchievementsDeps,
  event: ProtonEvent,
  engine: CollectorEngine = ENGINE,
): Promise<void> {
  if (event.guildId === null) return;

  const updated = readMemberEvent(event.payload);
  if (updated === null || updated.isBot) return;

  const store = storeOf(ctx, deps, 'membership tracking');
  if (!store) return;

  await rememberFacts(deps, store, ctx.guildId, updated.userId, updated.member);
  await collectBoost(
    ctx,
    deps,
    event,
    { userId: updated.userId, member: updated.member, originChannelId: null },
    engine,
  );
}

export async function collectMemberLeft(
  ctx: Ctx,
  deps: AchievementsDeps,
  event: ProtonEvent,
): Promise<void> {
  if (event.guildId === null) return;

  const left = readMemberEvent(event.payload);
  if (left === null || left.isBot) return;

  const store = storeOf(ctx, deps, 'membership tracking');
  if (!store) return;

  await store.upsertFacts(ctx.guildId, left.userId, { leftAt: event.occurredAt, joinedAt: null });
  forgetFacts(deps, ctx.guildId, left.userId);
}
