import { describe, expect, test } from 'bun:test';
import type { CardBadge, CardDescriptorInput } from '@proton/cards';
import type { CommandContext, Logger } from '@proton/core';
import { type LevelingConfig, levelingDefaultConfig } from '../src/config.ts';
import type { LevelingDeps } from '../src/deps.ts';
import { BADGE_BUDGET_MS, type RankCardInput, renderRankCard } from '../src/rank-card.ts';

const GUILD = '900000000000000001';
const USER = '100000000000000001';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

const GOLD: CardBadge = { shape: 'circle', colour: '#d9a931', icon: 'trophy' };
const SILVER: CardBadge = { shape: 'shield', colour: '#9ea7b3', icon: 'chat' };

type RankDescriptor = Extract<CardDescriptorInput, { kind: 'rank' }>;

function rankOf(descriptor: CardDescriptorInput | undefined): RankDescriptor {
  if (descriptor?.kind !== 'rank') throw new Error('expected a rank card descriptor');
  return descriptor;
}

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

function capturing(seen: CardDescriptorInput[], extra: Partial<LevelingDeps> = {}): LevelingDeps {
  return {
    renderCard: async (descriptor) => {
      seen.push(descriptor);
      return PNG;
    },
    ...extra,
  };
}

describe('renderRankCard', () => {
  test('hands the renderer the guild’s settings, not defaults of its own', async () => {
    const seen: CardDescriptorInput[] = [];
    const deps = capturing(seen, {
      userProfile: async () => ({ displayName: 'Rin', avatarHash: 'a'.repeat(32) }),
    });

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
    expect(rankOf(seen[0]).avatarUrl).toContain(USER);
  });

  test('a member with no profile is still drawn, under a name the card can render', async () => {
    const seen: CardDescriptorInput[] = [];

    await renderRankCard(ctx(), capturing(seen), input);

    expect(seen[0]).toMatchObject({ displayName: 'Member' });
    expect(rankOf(seen[0]).avatarUrl).toBeUndefined();
  });

  // At the level ceiling the span is zero, which the descriptor refuses because a bar wider than
  // its track is a curve bug. One is the honest floor, and it must survive the schema.
  test('the level ceiling renders rather than throwing on a zero-width level', async () => {
    const seen: CardDescriptorInput[] = [];

    await renderRankCard(ctx(), capturing(seen), { ...input, into: 0, span: 0 });

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

describe('renderRankCard — achievement badges', () => {
  test('the member’s badges and how many achievements they hold reach the card', async () => {
    const seen: CardDescriptorInput[] = [];
    const asked: string[] = [];
    const deps = capturing(seen, {
      badges: async (guildId, userId) => {
        asked.push(`${guildId}:${userId}`);
        return { badges: [GOLD, SILVER], count: 7 };
      },
    });

    await renderRankCard(ctx(), deps, input);

    expect(asked).toEqual([`${GUILD}:${USER}`]);
    expect(rankOf(seen[0]).badges).toEqual([GOLD, SILVER]);
    expect(rankOf(seen[0]).achievementCount).toBe(7);
  });

  test('a member with no achievements gets the card exactly as it was before badges', async () => {
    const seen: CardDescriptorInput[] = [];
    const deps = capturing(seen, { badges: async () => ({ badges: [], count: 0 }) });

    await renderRankCard(ctx(), deps, input);

    expect(seen[0]).not.toHaveProperty('badges');
    expect(seen[0]).not.toHaveProperty('achievementCount');
  });

  test('the card carries no more badges than it has room for', async () => {
    const seen: CardDescriptorInput[] = [];
    const deps = capturing(seen, {
      badges: async () => ({ badges: Array.from({ length: 9 }, () => GOLD), count: 9 }),
    });

    await renderRankCard(ctx(), deps, input);

    expect(rankOf(seen[0]).badges).toHaveLength(6);
    expect(rankOf(seen[0]).achievementCount).toBe(9);
  });

  test('with badges switched off the card does not even ask for them', async () => {
    const seen: CardDescriptorInput[] = [];
    let asked = false;
    const deps = capturing(seen, {
      badges: async () => {
        asked = true;
        return { badges: [GOLD], count: 1 };
      },
    });

    await renderRankCard(ctx({ cardShowBadges: false }), deps, input);

    expect(asked).toBe(false);
    expect(seen[0]).not.toHaveProperty('badges');
  });

  test('badges are read alongside the profile, not after it', async () => {
    const seen: CardDescriptorInput[] = [];
    let profileRead = false;
    let askedWhileProfilePending = false;

    const deps = capturing(seen, {
      userProfile: async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        profileRead = true;
        return { displayName: 'Rin', avatarHash: null };
      },
      badges: async () => {
        askedWhileProfilePending = !profileRead;
        return { badges: [GOLD], count: 1 };
      },
    });

    await renderRankCard(ctx(), deps, input);

    expect(askedWhileProfilePending).toBe(true);
    expect(rankOf(seen[0]).badges).toEqual([GOLD]);
  });

  test('badges that never arrive cost the badges after the budget, not the card', async () => {
    const seen: CardDescriptorInput[] = [];
    const log: string[] = [];
    const deps = capturing(seen, {
      badges: () => new Promise<{ badges: CardBadge[]; count: number }>(() => {}),
    });

    const started = Date.now();
    const attachment = await renderRankCard(ctx({}, log), deps, input);

    expect(attachment?.filename).toBe('rank.png');
    expect(Date.now() - started).toBeGreaterThanOrEqual(BADGE_BUDGET_MS - 50);
    expect(seen[0]).not.toHaveProperty('badges');
    expect(log.some((line) => line.startsWith('warn:') && line.includes('too long'))).toBe(true);
  }, 10_000);

  test('badges that fail to load cost the badges, not the card', async () => {
    const seen: CardDescriptorInput[] = [];
    const log: string[] = [];
    const deps = capturing(seen, {
      badges: async () => {
        throw new Error('postgres is down');
      },
    });

    const attachment = await renderRankCard(ctx({}, log), deps, input);

    expect(attachment?.filename).toBe('rank.png');
    expect(seen[0]).not.toHaveProperty('badges');
    expect(log.some((line) => line.includes('postgres is down'))).toBe(true);
  });
});
