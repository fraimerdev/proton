import { BadgeArt, TIER_COLOURS, toHexColour } from '@proton/cards/design';
import type { TierId } from '@proton/core';
import type { Achievement, Badge } from '@proton/module-achievements/config';
import { tierRank } from '@proton/module-achievements/evaluate';
import type { ReactElement } from 'react';

export const GLYPH_SIZE = 22;

export function badgeSource(guildId: string, assetId: string): string {
  return `/api/guilds/${guildId}/achievement-badges/${assetId}`;
}

export function badgeColour(badge: Badge, tier: TierId): string {
  return toHexColour(badge.colour === 'tier' ? TIER_COLOURS[tier] : badge.colour);
}

export function topTier(achievement: Pick<Achievement, 'tiers'>): TierId {
  return achievement.tiers.reduce<TierId>(
    (top, tier) => (tierRank(tier.id) > tierRank(top) ? tier.id : top),
    achievement.tiers[0]?.id ?? 'single',
  );
}

export function AchievementBadge({
  guildId,
  badge,
  tier,
  size,
  label,
}: {
  guildId: string;
  badge: Badge;
  tier: TierId;
  size: number;
  label?: string | undefined;
}): ReactElement {
  return (
    <BadgeArt
      shape={badge.shape}
      colour={badgeColour(badge, tier)}
      icon={badge.icon}
      image={badge.assetId === undefined ? undefined : badgeSource(guildId, badge.assetId)}
      size={size}
      label={label}
    />
  );
}

export function BadgeGlyph({
  guildId,
  achievement,
  size = GLYPH_SIZE,
}: {
  guildId: string;
  achievement: Pick<Achievement, 'badge' | 'tiers'>;
  size?: number | undefined;
}): ReactElement {
  return (
    <span className="achievements-glyph">
      <AchievementBadge
        guildId={guildId}
        badge={achievement.badge}
        tier={topTier(achievement)}
        size={size}
      />
    </span>
  );
}
