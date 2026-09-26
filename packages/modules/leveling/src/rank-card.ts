import {
  type CardBadge,
  type CardDeps,
  type CardPreset,
  discordAvatarUrl,
  RANK_CARD_BADGES_MAX,
  renderCard,
  toHexColour,
} from '@proton/cards';
import type { Attachment, CommandContext } from '@proton/core';
import type { LevelingConfig } from './config.ts';
import type { LevelingDeps } from './deps.ts';
import { MODULE_ID } from './perform.ts';

export interface RankCardInput {
  userId: string;
  preset: CardPreset;
  level: number;
  rank: number;
  totalXp: number;
  into: number;
  span: number;
}

// Under 3 s because with no application id the card rides the only callback (I9).
const RENDER_BUDGET_MS = 2000;

export const BADGE_BUDGET_MS = 500;

interface EarnedBadges {
  badges: CardBadge[];
  count: number;
}

const NO_BADGES: EarnedBadges = { badges: [], count: 0 };

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([work, new Promise<null>((resolve) => setTimeout(() => resolve(null), ms))]);
}

async function badgesFor(
  ctx: CommandContext<LevelingConfig>,
  deps: LevelingDeps,
  userId: string,
): Promise<EarnedBadges> {
  if (!deps.badges || !ctx.config.cardShowBadges) return NO_BADGES;

  try {
    const earned = await withTimeout(deps.badges(ctx.guildId, userId), BADGE_BUDGET_MS);
    if (earned !== null) return earned;

    ctx.logger.warn('achievement badges took too long to read, so the rank card shows none', {
      guildId: ctx.guildId,
      moduleId: MODULE_ID,
    });
  } catch (error) {
    ctx.logger.warn(
      `achievement badges could not be read, so the rank card shows none: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { guildId: ctx.guildId, moduleId: MODULE_ID },
    );
  }

  return NO_BADGES;
}

export async function renderRankCard(
  ctx: CommandContext<LevelingConfig>,
  deps: LevelingDeps,
  input: RankCardInput,
): Promise<Attachment | null> {
  const render = deps.renderCard ?? renderCard;
  const cards: CardDeps = {
    ...(deps.cards ?? {}),
    onImageSkipped: (reason) =>
      ctx.logger.warn(`the rank card dropped an image: ${reason}`, {
        guildId: ctx.guildId,
        moduleId: MODULE_ID,
      }),
  };

  const [profile, earned] = await Promise.all([
    deps.userProfile?.(input.userId),
    badgesFor(ctx, deps, input.userId),
  ]);
  const badges = earned.badges.slice(0, RANK_CARD_BADGES_MAX);

  try {
    const data = await withTimeout(
      render(
        {
          kind: 'rank',
          preset: input.preset,
          accent: toHexColour(ctx.config.cardAccent),
          displayName: profile?.displayName ?? 'Member',
          level: input.level,
          rank: input.rank,
          totalXp: input.totalXp,
          xpIntoLevel: input.into,
          // At the ceiling the span is zero, which the descriptor refuses because a bar wider than
          // its track is a curve bug. One is the honest floor for "no next level".
          xpForNextLevel: Math.max(1, input.span),
          showRank: ctx.config.cardShowRank,
          showPercent: ctx.config.cardShowPercent,
          showTotalXp: ctx.config.cardShowTotalXp,
          ...(badges.length > 0 ? { badges } : {}),
          ...(earned.count > 0 ? { achievementCount: earned.count } : {}),
          ...(profile?.avatarHash
            ? { avatarUrl: discordAvatarUrl(input.userId, profile.avatarHash) }
            : {}),
          ...(ctx.config.cardBackgroundUrl ? { backgroundUrl: ctx.config.cardBackgroundUrl } : {}),
        },
        cards,
      ),
      RENDER_BUDGET_MS,
    );

    if (data === null) {
      ctx.logger.warn('the rank card took too long to render, so /rank answered without it', {
        guildId: ctx.guildId,
        moduleId: MODULE_ID,
      });
      return null;
    }

    return { filename: 'rank.png', contentType: 'image/png', data: new Uint8Array(data) };
  } catch (error) {
    ctx.logger.error(
      `the rank card could not be rendered, so /rank answered without it: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { guildId: ctx.guildId, moduleId: MODULE_ID },
    );
    return null;
  }
}
