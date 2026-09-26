import { badgeImageSchema } from '@proton/cards';
import { type BadgeCard, toHexColour } from '@proton/cards/design';
import type { TierId } from '@proton/core';
import type { Achievement } from './config.ts';
import type { AchievementsDeps } from './deps.ts';
import { badgeColour } from './simulation.ts';

export function badgeCardFor(
  achievement: Achievement,
  tierId: TierId,
  image?: string | null,
): BadgeCard {
  const { badge } = achievement;

  return {
    kind: 'badge',
    shape: badge.shape,
    colour: toHexColour(badgeColour(badge, tierId)),
    ...(image ? { image } : { icon: badge.icon }),
  };
}

async function drawBadge(
  deps: AchievementsDeps,
  render: NonNullable<AchievementsDeps['renderBadge']>,
  guildId: string,
  achievement: Achievement,
  tierId: TierId,
): Promise<Uint8Array | null> {
  const { assetId } = achievement.badge;
  const asset =
    assetId !== undefined && deps.store ? await deps.store.badge(guildId, assetId) : null;
  const stored = asset ? `data:${asset.contentType};base64,${asset.base64}` : null;
  // A stored image the renderer would refuse shows the icon instead of losing the badge entirely.
  const image = stored !== null && badgeImageSchema.safeParse(stored).success ? stored : null;

  return render(badgeCardFor(achievement, tierId, image));
}

export async function renderBadgePng(
  deps: AchievementsDeps,
  guildId: string,
  achievement: Achievement,
  tierId: TierId,
  budgetMs: number,
): Promise<Uint8Array | null> {
  const render = deps.renderBadge;
  if (!render) return null;

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), Math.max(0, budgetMs));
  });

  try {
    return await Promise.race([drawBadge(deps, render, guildId, achievement, tierId), timeout]);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
