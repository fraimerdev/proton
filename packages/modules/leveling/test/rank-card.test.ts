import { describe, expect, test } from 'bun:test';
import type { CardDescriptorInput } from '@proton/cards';
import type { CommandContext, Logger } from '@proton/core';
import { type LevelingConfig, levelingDefaultConfig } from '../src/config.ts';
import type { LevelingDeps } from '../src/deps.ts';
import { type RankCardInput, renderRankCard } from '../src/rank-card.ts';

const GUILD = '900000000000000001';
const USER = '100000000000000001';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

function ctx(
  config: Partial<LevelingConfig> = {},
  log: string[] = [],
): CommandContext<LevelingConfig> {
  const logger: Logger = {
    info: () => {},
    warn: (message) => log.push(`warn: ${message}`),
    error: (message) => log.push(`error: ${message}`),
  };

  return {
    guildId: GUILD,
    channelId: '500000000000000001',
    userId: USER,
    config: { ...levelingDefaultConfig, ...config },
    executor: {} as CommandContext<LevelingConfig>['executor'],
    logger,
    options: {} as CommandContext<LevelingConfig>['options'],
    interaction: { id: '1', token: 't' },
    idempotencyKey: 'k',
  };
}

const input: RankCardInput = {
  userId: USER,
  preset: 'midnight',
  level: 12,
  rank: 3,
  totalXp: 48_210,
  into: 1_240,
  span: 2_000,
};

describe('renderRankCard', () => {
  test('hands the renderer the guild’s settings, not defaults of its own', async () => {
    const seen: CardDescriptorInput[] = [];
    const deps: LevelingDeps = {
      renderCard: async (descriptor) => {
        seen.push(descriptor);
        return PNG;
      },
      userProfile: async () => ({ displayName: 'Rin', avatarHash: 'a'.repeat(32) }),
    };

    const attachment = await renderRankCard(
      ctx({ cardAccent: 0x317ff5, cardShowRank: false }),
      deps,
      input,
    );

    expect(attachment).toEqual({ filename: 'rank.png', contentType: 'image/png', data: PNG });
    expect(seen[0]).toMatchObject({
      kind: 'rank',
      accent: '#317ff5',
      displayName: 'Rin',
      showRank: false,
      level: 12,
      rank: 3,
    });
    expect(seen[0]?.avatarUrl).toContain(USER);
  });

  test('a member with no profile is still drawn, under a name the card can render', async () => {
    const seen: CardDescriptorInput[] = [];
    const deps: LevelingDeps = {
      renderCard: async (descriptor) => {
        seen.push(descriptor);
        return PNG;
      },
    };

    await renderRankCard(ctx(), deps, input);

    expect(seen[0]).toMatchObject({ displayName: 'Member' });
    expect(seen[0]?.avatarUrl).toBeUndefined();
  });

  // At the level ceiling the span is zero, which the descriptor refuses because a bar wider than
  // its track is a curve bug. One is the honest floor, and it must survive the schema.
  test('the level ceiling renders rather than throwing on a zero-width level', async () => {
    const seen: CardDescriptorInput[] = [];
    const deps: LevelingDeps = {
      renderCard: async (descriptor) => {
        seen.push(descriptor);
        return PNG;
      },
    };

    await renderRankCard(ctx(), deps, { ...input, into: 0, span: 0 });

    expect(seen[0]).toMatchObject({ xpIntoLevel: 0, xpForNextLevel: 1 });
  });

  test('a renderer that throws costs the picture, not the reply', async () => {
    const log: string[] = [];
    const deps: LevelingDeps = {
      renderCard: async () => {
        throw new Error('resvg said no');
      },
    };

    expect(await renderRankCard(ctx({}, log), deps, input)).toBeNull();
    expect(log[0]).toContain('resvg said no');
  });

  // I9: the interaction has three seconds. A renderer that hangs must lose the race, not the reply.
  test('a renderer that never settles is abandoned and the command answers without a card', async () => {
    const log: string[] = [];
    const deps: LevelingDeps = { renderCard: () => new Promise<Uint8Array>(() => {}) };

    expect(await renderRankCard(ctx({}, log), deps, input)).toBeNull();
    expect(log[0]).toContain('too long');
  }, 10_000);
});
