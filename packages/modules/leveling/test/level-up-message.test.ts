import { describe, expect, test } from 'bun:test';
import type { ActionRequest, ActionResult, Logger, ModuleContext } from '@proton/core';
import {
  DEFAULT_LEVEL_UP_MESSAGE,
  isSilentLevelUp,
  type LevelingConfig,
  levelingConfigSchema,
  levelingDefaultConfig,
  levelUpMessageSchema,
} from '../src/config.ts';
import { applyLevelUp, renderLevelUpMessage } from '../src/level-up.ts';

const CHANNEL = '800000000000000001';
const USER = '900000000000000002';

const LEGACY_TEXT = 'GG {user}, level {level} at {xp} XP!';

function silentLogger(): Logger {
  return { info: () => undefined, warn: () => undefined, error: () => undefined };
}

function contextFor(config: Partial<LevelingConfig>): {
  ctx: ModuleContext<LevelingConfig>;
  sent: ActionRequest[];
} {
  const sent: ActionRequest[] = [];

  const ctx: ModuleContext<LevelingConfig> = {
    guildId: '100000000000000001',
    config: { ...levelingDefaultConfig, ...config },
    logger: silentLogger(),
    executor: {
      async execute(request: ActionRequest): Promise<ActionResult> {
        sent.push(request);
        return { status: 'executed' };
      },
    },
    publish: async () => undefined,
  };

  return { ctx, sent };
}

function levelUp() {
  return {
    userId: USER,
    previousLevel: 4,
    level: 5,
    xp: 1234,
    source: 'message' as const,
    idempotencyRoot: 'leveling:test',
    originChannelId: CHANNEL,
  };
}

describe('levelUpMessage — legacy migration', () => {
  test('a stored bare string keeps its text', () => {
    const parsed = levelUpMessageSchema.parse(LEGACY_TEXT);

    expect(parsed).toEqual({
      content: LEGACY_TEXT,
      embeds: [],
      components: [],
      mentions: { everyone: false, roles: true, users: true },
      v2: [],
    });
  });

  test('parsing the parse of a stored string leaves it untouched', () => {
    const once = levelUpMessageSchema.parse(LEGACY_TEXT);
    const twice = levelUpMessageSchema.parse(once);

    expect(twice).toEqual(once);
  });

  test('a whole legacy config survives a parse and a re-parse of its own output', () => {
    const stored = { ...levelingDefaultConfig, levelUpMessage: LEGACY_TEXT };

    const once = levelingConfigSchema.parse(stored);
    const twice = levelingConfigSchema.parse(once);

    expect(once.levelUpMessage.content).toBe(LEGACY_TEXT);
    expect(twice.levelUpMessage.content).toBe(LEGACY_TEXT);
    expect(twice).toEqual(once);
  });

  test('a stored empty string stays silent instead of being refused', () => {
    const parsed = levelUpMessageSchema.parse('');

    expect(isSilentLevelUp(parsed)).toBe(true);
  });

  test('the default is the message it always was', () => {
    expect(levelingConfigSchema.parse({}).levelUpMessage.content).toBe(DEFAULT_LEVEL_UP_MESSAGE);
  });
});

describe('renderLevelUpMessage', () => {
  test('substitutes the placeholders in the content', () => {
    const rendered = renderLevelUpMessage(levelUpMessageSchema.parse(LEGACY_TEXT), {
      userId: USER,
      level: 5,
      xp: 1234,
    });

    expect(rendered.ok).toBe(true);
    if (!rendered.ok) return;

    expect(rendered.body.content).toBe(`GG <@${USER}>, level 5 at 1234 XP!`);
  });

  test('substitutes inside an embed, not only in the content', () => {
    const message = levelUpMessageSchema.parse({
      embeds: [
        {
          title: 'Level {level}',
          description: '{user} is on {xp} XP.',
          fields: [{ name: 'Level', value: '{level}' }],
          footer: { text: '{xp} XP' },
        },
      ],
    });

    const rendered = renderLevelUpMessage(message, { userId: USER, level: 7, xp: 99 });

    expect(rendered.ok).toBe(true);
    if (!rendered.ok) return;

    expect(rendered.body.embeds?.[0]).toMatchObject({
      title: 'Level 7',
      description: `<@${USER}> is on 99 XP.`,
      fields: [{ name: 'Level', value: '7' }],
      footer: { text: '99 XP' },
    });
  });

  test('always sends an allowed_mentions policy', () => {
    const rendered = renderLevelUpMessage(levelUpMessageSchema.parse('{user}'), {
      userId: USER,
      level: 1,
      xp: 1,
    });

    expect(rendered.ok).toBe(true);
    if (!rendered.ok) return;

    expect(rendered.body.allowedMentions).toEqual({ parse: ['roles', 'users'] });
  });

  test('an unknown placeholder is left alone rather than emptied', () => {
    const rendered = renderLevelUpMessage(levelUpMessageSchema.parse('{rank} of {level}'), {
      userId: USER,
      level: 3,
      xp: 10,
    });

    expect(rendered.ok).toBe(true);
    if (!rendered.ok) return;

    expect(rendered.body.content).toBe('{rank} of 3');
  });
});

describe('announce', () => {
  test('posts the rendered message in the configured channel', async () => {
    const { ctx, sent } = contextFor({
      levelUpMessage: levelUpMessageSchema.parse(LEGACY_TEXT),
      levelUpChannelId: CHANNEL,
    });

    await applyLevelUp(ctx, levelUp());

    const send = sent.find((request) => request.kind === 'send');
    expect(send?.payload).toMatchObject({
      channelId: CHANNEL,
      content: `GG <@${USER}>, level 5 at 1234 XP!`,
    });
  });

  test('an empty message levels the member up silently', async () => {
    const { ctx, sent } = contextFor({
      levelUpMessage: levelUpMessageSchema.parse(''),
      levelUpChannelId: CHANNEL,
    });

    await applyLevelUp(ctx, levelUp());

    expect(sent.some((request) => request.kind === 'send')).toBe(false);
  });

  test('falls back to the channel the member was talking in', async () => {
    const { ctx, sent } = contextFor({ levelUpMessage: levelUpMessageSchema.parse('{user}!') });

    await applyLevelUp(ctx, levelUp());

    expect(sent.find((request) => request.kind === 'send')?.payload).toMatchObject({
      channelId: CHANNEL,
    });
  });

  test('a voice level-up with no configured channel posts nothing', async () => {
    const { ctx, sent } = contextFor({ levelUpMessage: levelUpMessageSchema.parse('{user}!') });

    await applyLevelUp(ctx, {
      ...levelUp(),
      source: 'voice',
      originChannelId: undefined,
    });

    expect(sent.some((request) => request.kind === 'send')).toBe(false);
  });
});
