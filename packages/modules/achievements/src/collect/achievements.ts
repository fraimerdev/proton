import {
  type AchievementUnlocked,
  achievementUnlockedSchema,
  type ProtonEvent,
} from '@proton/core';
import type { AchievementsDeps } from '../deps.ts';
import type { UnlockRow } from '../store.ts';
import {
  activeUsing,
  type CollectorEngine,
  type Ctx,
  continuedCausation,
  ENGINE,
  mismatchedGuild,
  unreadable,
} from './common.ts';

// The event carries neither the announce status nor the time that earned it; the row holds both.
async function sourceRow(
  deps: AchievementsDeps,
  unlocked: AchievementUnlocked,
): Promise<UnlockRow | undefined> {
  const rows = (await deps.store?.unlocksOf(unlocked.guildId, unlocked.userId)) ?? [];
  return rows.find(
    (row) =>
      row.achievementId === unlocked.achievementId &&
      row.tierId === unlocked.tierId &&
      row.generation === unlocked.generation,
  );
}

export async function collectAchievementUnlocked(
  ctx: Ctx,
  deps: AchievementsDeps,
  event: ProtonEvent,
  engine: CollectorEngine = ENGINE,
): Promise<void> {
  const parsed = achievementUnlockedSchema.safeParse(event.payload);
  if (!parsed.success) {
    unreadable(ctx, 'an unlock', event.id, parsed.error.message);
    return;
  }

  const unlocked = parsed.data;
  if (mismatchedGuild(ctx, unlocked.guildId, 'an unlock', event.id)) return;

  const achievementIds = activeUsing(
    ctx.config,
    (requirement) =>
      requirement.trigger === 'achievements.earned' ||
      (requirement.trigger === 'achievements.unlocked' &&
        requirement.achievementId === unlocked.achievementId),
  ).filter((achievementId) => achievementId !== unlocked.achievementId);
  if (achievementIds.length === 0) return;

  const row = await sourceRow(deps, unlocked);

  await engine.evaluateMember(ctx, deps, {
    userId: unlocked.userId,
    achievementIds,
    originChannelId: unlocked.originChannelId ?? null,
    occurredAt: row?.cause.occurredAt ?? unlocked.unlockedAt,
    causation: continuedCausation(unlocked.causation),
    ...(row?.announceStatus === 'suppressed' ? { announce: 'suppressed' as const } : {}),
  });
}
