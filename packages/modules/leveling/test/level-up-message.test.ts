import { describe, expect, test } from 'bun:test';
import type {
  ActionRequest,
  ActionResult,
  GuildState,
  Logger,
  ModuleContext,
  ProtonEvent,
} from '@proton/core';
import { type PlaceholderEnvironment, SAMPLE_BOT, SAMPLE_NOW } from '@proton/core/placeholders';
import { levelUpCustomId } from '../src/component-id.ts';
import {
  DEFAULT_LEVEL_UP_MESSAGE,
  isSilentLevelUp,
  type LevelingConfig,
  type LevelUpMessage,
  levelingConfigSchema,
  levelingDefaultConfig,
  levelUpMessageSchema,
} from '../src/config.ts';
import { applyLevelUp, type LevelUp, renderLevelUpMessage } from '../src/level-up.ts';
import { createMessageXpListener } from '../src/message-xp.ts';
import type { LevelUpPlaceholderFacts } from '../src/placeholders.ts';
import type { AwardInput, AwardResult } from '../src/store.ts';
import { FakeXpStore } from './fakes.ts';

const GUILD = '100000000000000001';
const CHANNEL = '800000000000000001';
const USER = '900000000000000002';

const LEGACY_TEXT = 'GG {user}, level {level} at {xp} XP!';

function contextFor(config: Partial<LevelingConfig>): {
  ctx: ModuleContext<LevelingConfig>;
  sent: ActionRequest[];
  logs: string[];
} {
  const sent: ActionRequest[] = [];
  const logs: string[] = [];
  const logger: Logger = {
    info: (message) => logs.push(message),
    warn: (message) => logs.push(message),
    error: (message) => logs.push(message),
  };

  const ctx: ModuleContext<LevelingConfig> = {
    guildId: GUILD,
    config: { ...levelingDefaultConfig, ...config },
    logger,
    executor: {
      async execute(request: ActionRequest): Promise<ActionResult> {
        sent.push(request);
        return { status: 'executed' };
      },
    },
    publish: async () => undefined,
  };

  return { ctx, sent, logs };
}

function levelUp(): LevelUp {
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

function factsFor(values: { level: number; xp: number }): LevelUpPlaceholderFacts {
  return {
    userId: USER,
    user: { id: USER, username: 'member', globalName: 'Member', avatarHash: null },
    member: 'unavailable',
    level: values.level,
    previousLevel: values.level - 1,
    xp: values.xp,
    source: 'message',
    server: { id: GUILD },
    destinationChannel: { id: CHANNEL },
    bot: null,
  };
}

function sentPayload(sent: readonly ActionRequest[]): Record<string, unknown> {
  const send = sent.find((request) => request.kind === 'send');
  if (!send) throw new Error('no level-up message was sent');
  return (send.payload ?? {}) as Record<string, unknown>;
}

function message(value: unknown): LevelUpMessage {
  return levelUpMessageSchema.parse(value);
}

function environment(calls: string[]): PlaceholderEnvironment {
  return {
    applicationId: SAMPLE_BOT.id,
    bot: async () => {
      calls.push('bot');
      return SAMPLE_BOT;
    },
    server: async (guildId) => {
      calls.push('server');
      return { id: guildId };
    },
    user: async (userId) => {
      calls.push(`user:${userId}`);
      return { id: userId, username: 'voicer', globalName: 'Voice Regular', avatarHash: null };
    },
    now: () => SAMPLE_NOW,
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
    const rendered = renderLevelUpMessage(
      message(LEGACY_TEXT),
      factsFor({ level: 5, xp: 1234 }),
      SAMPLE_NOW,
    );

    expect(rendered.ok).toBe(true);
    if (!rendered.ok) return;

    expect(rendered.body.content).toBe(`GG <@${USER}>, level 5 at 1234 XP!`);
  });

  test('substitutes inside an embed, not only in the content', () => {
    const embedded = message({
      embeds: [
        {
          title: 'Level {level}',
          description: '{user} is on {xp} XP.',
          fields: [{ name: 'Level', value: '{level}' }],
          footer: { text: '{xp} XP' },
        },
      ],
    });

    const rendered = renderLevelUpMessage(embedded, factsFor({ level: 7, xp: 99 }), SAMPLE_NOW);

    expect(rendered.ok).toBe(true);
    if (!rendered.ok) return;

    expect(rendered.body.embeds?.[0]).toMatchObject({
      title: 'Level 7',
      description: `<@${USER}> is on 99 XP.`,
      fields: [{ name: 'Level', value: '7' }],
      footer: { text: '99 XP' },
    });
  });

  test('renders a link button address, and never touches a custom_id', () => {
    const linked = message({
      content: 'GG',
      components: [
        {
          kind: 'buttons',
          buttons: [
            { key: 'level', style: 'link', label: 'Level {level}', url: 'https://x/{level}' },
          ],
        },
      ],
    });

    const rendered = renderLevelUpMessage(linked, factsFor({ level: 5, xp: 1 }), SAMPLE_NOW);
    if (!rendered.ok) throw new Error(rendered.humanReason);

    expect(rendered.body.components).toEqual([
      { type: 1, components: [{ type: 2, style: 5, label: 'Level 5', url: 'https://x/5' }] },
    ]);

    const pressable: LevelUpMessage = {
      ...linked,
      components: [
        {
          kind: 'buttons',
          buttons: [{ key: 'level', style: 'primary', label: '{level}', emoji: { name: '{xp}' } }],
        },
      ],
    };

    const pressed = renderLevelUpMessage(pressable, factsFor({ level: 5, xp: 1 }), SAMPLE_NOW);
    if (!pressed.ok) throw new Error(pressed.humanReason);

    expect(pressed.body.components).toEqual([
      {
        type: 1,
        components: [
          {
            type: 2,
            style: 1,
            label: '5',
            emoji: { name: '{xp}' },
            custom_id: levelUpCustomId('level'),
          },
        ],
      },
    ]);
  });

  test('always sends an allowed_mentions policy', () => {
    const rendered = renderLevelUpMessage(
      message('{user}'),
      factsFor({ level: 1, xp: 1 }),
      SAMPLE_NOW,
    );

    expect(rendered.ok).toBe(true);
    if (!rendered.ok) return;

    expect(rendered.body.allowedMentions).toEqual({ parse: ['roles', 'users'] });
  });

  test('an unknown placeholder is left alone rather than emptied', () => {
    const rendered = renderLevelUpMessage(
      message('{rank} of {level}'),
      factsFor({ level: 3, xp: 10 }),
      SAMPLE_NOW,
    );

    expect(rendered.ok).toBe(true);
    if (!rendered.ok) return;

    expect(rendered.body.content).toBe('{rank} of 3');
  });
});

describe('announce', () => {
  test('posts the rendered message in the configured channel', async () => {
    const { ctx, sent } = contextFor({
      levelUpMessage: message(LEGACY_TEXT),
      levelUpChannelId: CHANNEL,
    });

    await applyLevelUp(ctx, levelUp());

    const send = sent.find((request) => request.kind === 'send');
    expect(send?.payload).toMatchObject({
      channelId: CHANNEL,
      content: `GG <@${USER}>, level 5 at 1234 XP!`,
    });
    expect(send?.idempotencyKey).toBe('leveling:test:level-up');
  });

  test('an empty message levels the member up silently', async () => {
    const { ctx, sent } = contextFor({
      levelUpMessage: message(''),
      levelUpChannelId: CHANNEL,
    });

    await applyLevelUp(ctx, levelUp());

    expect(sent.some((request) => request.kind === 'send')).toBe(false);
  });

  test('falls back to the channel the member was talking in', async () => {
    const { ctx, sent } = contextFor({ levelUpMessage: message('{user}!') });

    await applyLevelUp(ctx, levelUp());

    expect(sent.find((request) => request.kind === 'send')?.payload).toMatchObject({
      channelId: CHANNEL,
    });
  });

  test('a voice level-up with no configured channel posts nothing', async () => {
    const { ctx, sent } = contextFor({ levelUpMessage: message('{user}!') });

    await applyLevelUp(ctx, {
      ...levelUp(),
      source: 'voice',
      originChannelId: undefined,
    });

    expect(sent.some((request) => request.kind === 'send')).toBe(false);
  });
});

describe('what a level-up message reads, and when', () => {
  function seeded(): FakeXpStore {
    return new FakeXpStore().seed(
      GUILD,
      { userId: USER, xp: 1234, level: 5, rank: 12, messageCount: 812, voiceSeconds: 18000 },
      { userId: '900000000000000003', xp: 0, level: 0, rank: 3, messageCount: 0, voiceSeconds: 0 },
      { userId: '900000000000000004', xp: 5, level: 0, rank: 2, messageCount: 1, voiceSeconds: 0 },
    );
  }

  test('the rank is read only when the message uses it', async () => {
    const xp = seeded();
    const quiet = contextFor({ levelUpMessage: message(LEGACY_TEXT), levelUpChannelId: CHANNEL });

    await applyLevelUp(quiet.ctx, levelUp(), { xp });

    expect(xp.reads).toEqual([]);

    const ranked = contextFor({
      levelUpMessage: message('You are {level.rank:ordinal} after {level.messages} messages'),
      levelUpChannelId: CHANNEL,
    });

    await applyLevelUp(ranked.ctx, levelUp(), { xp });

    expect(xp.reads).toEqual([`get:${USER}`]);
    expect(sentPayload(ranked.sent).content).toBe('You are 12th after 812 messages');
  });

  test('the ranked members are counted only for {level.ranked_member_count}', async () => {
    const xp = seeded();
    const ranked = contextFor({
      levelUpMessage: message('Rank {level.rank}'),
      levelUpChannelId: CHANNEL,
    });

    await applyLevelUp(ranked.ctx, levelUp(), { xp });

    expect(xp.reads).not.toContain('countRanked');

    const counted = contextFor({
      levelUpMessage: message('One of {level.ranked_member_count}'),
      levelUpChannelId: CHANNEL,
    });

    await applyLevelUp(counted.ctx, levelUp(), { xp });

    expect(xp.reads).toEqual([`get:${USER}`, 'countRanked']);
    expect(sentPayload(counted.sent).content).toBe('One of 2');
  });

  test('a rank query that throws still posts, with the fallback, and says why', async () => {
    const xp = new FakeXpStore();
    xp.get = async () => {
      throw new Error('the database is down');
    };
    const { ctx, sent, logs } = contextFor({
      levelUpMessage: message('Rank {level.rank:fallback("?")}'),
      levelUpChannelId: CHANNEL,
    });

    await applyLevelUp(ctx, levelUp(), { xp });

    expect(sentPayload(sent).content).toBe('Rank ?');
    expect(logs.join(' ')).toContain('the database is down');
  });

  test('a message level-up names the member from the event, without reading a profile', async () => {
    class LevellingStore extends FakeXpStore {
      override async award(input: AwardInput): Promise<AwardResult> {
        this.awards.push(input);
        return { xp: 1234, level: 5, previousLevel: 4, awarded: true };
      }
    }

    const calls: string[] = [];
    const { ctx, sent } = contextFor({
      enabled: true,
      levelUpMessage: message(
        '{user.display_name} hit {level} with {xp.gained} XP in {channel.mention}',
      ),
    });
    const event: ProtonEvent = {
      id: 'message-1',
      type: 'message.created',
      guildId: GUILD,
      occurredAt: SAMPLE_NOW,
      payload: {
        id: '1400000000000000001',
        channel_id: CHANNEL,
        type: 0,
        author: { id: USER, username: 'member', global_name: 'Member', avatar: null },
        member: { nick: 'Nick', roles: [] },
      },
    };

    await createMessageXpListener({
      xp: new LevellingStore(),
      random: () => 0,
      placeholders: environment(calls),
    }).handler(event, ctx);

    expect(sentPayload(sent).content).toBe(`Nick hit 5 with 15 XP in <#${CHANNEL}>`);
    expect(calls).toEqual([]);
  });

  test('a voice level-up reads the profile only when a name is used, and has no member', async () => {
    const calls: string[] = [];
    const voice: LevelUp = { ...levelUp(), source: 'voice', originChannelId: undefined };

    const mention = contextFor({
      levelUpMessage: message('{user} reached {level}'),
      levelUpChannelId: CHANNEL,
    });
    await applyLevelUp(mention.ctx, voice, { placeholders: environment(calls) });

    expect(calls).toEqual([]);
    expect(sentPayload(mention.sent).content).toBe(`<@${USER}> reached 5`);

    const named = contextFor({
      levelUpMessage: message('{user.display_name} reached {level}. Nick: {user.nickname}'),
      levelUpChannelId: CHANNEL,
    });
    await applyLevelUp(named.ctx, voice, { placeholders: environment(calls) });

    expect(calls).toEqual([`user:${USER}`]);
    expect(sentPayload(named.sent).content).toBe('Voice Regular reached 5. Nick:');
  });

  test('{user} in a button label reads the profile to show the name', async () => {
    const calls: string[] = [];
    const { ctx, sent } = contextFor({
      levelUpMessage: message({
        content: 'GG',
        components: [
          {
            kind: 'buttons',
            buttons: [{ key: 'me', style: 'link', label: '{user}', url: 'https://example.com' }],
          },
        ],
      }),
      levelUpChannelId: CHANNEL,
    });

    await applyLevelUp(
      ctx,
      { ...levelUp(), source: 'admin' },
      { placeholders: environment(calls) },
    );

    expect(calls).toEqual([`user:${USER}`]);
    expect(sentPayload(sent).components).toMatchObject([
      { components: [{ label: 'Voice Regular' }] },
    ]);
  });

  test('server and channel details come from the guild-state cache, read only when used', async () => {
    let reads = 0;
    const state: GuildState = {
      guildId: GUILD,
      ownerId: USER,
      everyoneRoleId: GUILD,
      roles: new Map(),
      botRoleIds: [],
      channels: new Map([
        [CHANNEL, { id: CHANNEL, parentId: null, name: 'levels', overwrites: [] }],
      ]),
      name: 'Proton',
      updatedAt: 0,
    };
    const guildState = {
      get: async () => {
        reads += 1;
        return state;
      },
    };

    const quiet = contextFor({ levelUpMessage: message(LEGACY_TEXT), levelUpChannelId: CHANNEL });
    await applyLevelUp(quiet.ctx, levelUp(), { guildState });

    expect(reads).toBe(0);

    const detailed = contextFor({
      levelUpMessage: message('{destination_channel.name} in {server.name}'),
      levelUpChannelId: CHANNEL,
    });
    await applyLevelUp(detailed.ctx, levelUp(), { guildState });

    expect(reads).toBe(1);
    expect(sentPayload(detailed.sent).content).toBe('levels in Proton');
  });

  test('Proton’s own profile is read only when the message uses it', async () => {
    const calls: string[] = [];
    const quiet = contextFor({ levelUpMessage: message(LEGACY_TEXT), levelUpChannelId: CHANNEL });

    await applyLevelUp(quiet.ctx, levelUp(), { placeholders: environment(calls) });

    expect(calls).toEqual([]);

    const bot = contextFor({
      levelUpMessage: message('Congratulations from {bot.name}'),
      levelUpChannelId: CHANNEL,
    });
    await applyLevelUp(bot.ctx, levelUp(), { placeholders: environment(calls) });

    expect(calls).toEqual(['bot']);
    expect(sentPayload(bot.sent).content).toBe('Congratulations from Proton');
  });
});
