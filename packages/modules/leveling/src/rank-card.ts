import {
  type CardDeps,
  type CardDescriptorInput,
  discordAvatarUrl,
  renderCard,
  toHexColour,
} from '@proton/cards';
import type { Attachment, CommandContext } from '@proton/core';
import type { LevelingConfig } from './config.ts';
import type { LevelingDeps } from './deps.ts';
import { MODULE_ID } from './perform.ts';

export interface RankCardInput {
  userId: string;
  preset: CardDescriptorInput['preset'];
  level: number;
  rank: number;
  totalXp: number;
  into: number;
  span: number;
}

// An interaction must be answered within 3s (I9), and a card is decoration. Rendering is raced
// against a budget well inside that so a slow CDN costs the picture, never the reply.
const RENDER_BUDGET_MS = 2000;

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([work, new Promise<null>((resolve) => setTimeout(() => resolve(null), ms))]);
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

  const profile = await deps.userProfile?.(input.userId);

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
