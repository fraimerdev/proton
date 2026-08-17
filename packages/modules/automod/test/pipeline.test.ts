import { describe, expect, test } from 'bun:test';
import type { GuildState, RateWindowHit, RateWindowResult, RateWindowStore } from '@proton/core';
import { type AutomodConfig, automodConfigSchema, readSettings } from '../src/config.ts';
import { isExempt } from '../src/exempt.ts';
import { type MessageFacts, normaliseForMatching } from '../src/message.ts';
import { duplicateFingerprint, type ScreenInput, screen } from '../src/pipeline.ts';

function config(overrides: Record<string, unknown> = {}): AutomodConfig {
  return automodConfigSchema.parse({ enabled: true, ...overrides });
}

function facts(overrides: Partial<MessageFacts> = {}): MessageFacts {
  const content = overrides.content ?? '';
  return {
    messageId: '1400000000000000001',
    channelId: '500000000000000001',
    authorId: '100000000000000001',
    isBot: false,
    type: 0,
    content,
    normalised: normaliseForMatching(content),
    mentionUserIds: [],
    mentionRoleIds: [],
    mentionsEveryone: false,
    attachments: [],
    roleIds: null,
    ...overrides,
  };
}

class CountingWindow implements RateWindowStore {
  readonly calls: RateWindowHit[] = [];
  readonly #counts = new Map<string, number>();

  async hit(input: RateWindowHit): Promise<RateWindowResult> {
    this.calls.push(input);
    const key = `${input.guildId}:${input.ruleId}:${input.actorId}`;
    const count = (this.#counts.get(key) ?? 0) + 1;
    this.#counts.set(key, count);
    return { count, tripped: count === input.limit };
  }
}

function settingsOf(cfg: AutomodConfig) {
  const result = readSettings(cfg);
  if ('invalid' in result) throw new Error(result.invalid);
  return result.settings;
}

function input(cfg: AutomodConfig, window: RateWindowStore, over: Partial<ScreenInput> = {}) {
  return {
    facts: facts(),
    config: cfg,
    settings: settingsOf(cfg),
    guildId: '900000000000000001',
    rateWindow: window,
    eventId: 'evt-1',
    now: 1_000,
    ...over,
  } satisfies ScreenInput;
}

describe('screen', () => {
  test('no enabled check means no verdict', async () => {
    const cfg = config();
    const verdict = await screen(
      input(cfg, new CountingWindow(), { facts: facts({ content: 'HELLO EVERYONE!!!' }) }),
    );

    expect(verdict.matched).toBe(false);
  });

  test('the highest severity acts and the rest are reported', async () => {
    const cfg = config({
      invitesSeverity: 'low',
      capsSeverity: 'high',
      capsRatio: 50,
    });

    const verdict = await screen(
      input(cfg, new CountingWindow(), {
        facts: facts({ content: 'JOIN NOW discord.gg/abcdef RIGHT NOW OKAY' }),
      }),
    );

    if (!verdict.matched) throw new Error('expected a match');
    expect(verdict.hit.check).toBe('caps');
    expect(verdict.hit.severity).toBe('high');
    expect(verdict.also.map((hit) => hit.check)).toContain('invites');
  });

  test('an equal severity does not displace the incumbent', async () => {
    const cfg = config({ invitesSeverity: 'medium', capsSeverity: 'medium', capsRatio: 50 });

    const verdict = await screen(
      input(cfg, new CountingWindow(), {
        facts: facts({ content: 'JOIN NOW discord.gg/abcdef RIGHT NOW OKAY' }),
      }),
    );

    if (!verdict.matched) throw new Error('expected a match');
    expect(verdict.hit.check).toBe('invites');
    expect(verdict.also).toHaveLength(1);
  });

  test('the stateful checks still run when a stateless one already matched', async () => {
    const cfg = config({
      floodSeverity: 'low',
      duplicateSeverity: 'low',
      capsSeverity: 'high',
      capsRatio: 50,
    });
    const window = new CountingWindow();

    await screen(
      input(cfg, window, { facts: facts({ content: 'SHOUTING AT EVERYBODY IN HERE' }) }),
    );

    expect(window.calls.map((call) => call.ruleId.split(':')[1])).toEqual(['flood', 'dup']);
  });

  test('a check set to off never touches Redis', async () => {
    const cfg = config({ floodSeverity: 'off', duplicateSeverity: 'off' });
    const window = new CountingWindow();

    await screen(
      input(cfg, window, { facts: facts({ content: 'a message long enough to count' }) }),
    );

    expect(window.calls).toHaveLength(0);
  });

  test('flood trips on the configured message and not before', async () => {
    const cfg = config({ floodSeverity: 'medium', floodCount: 3 });
    const window = new CountingWindow();

    const results = [];
    for (let i = 0; i < 3; i++) {
      results.push(await screen(input(cfg, window, { eventId: `evt-${i}` })));
    }

    expect(results.map((r) => r.matched)).toEqual([false, false, true]);
  });

  test('duplicate keys on the text, so the same words from a fresh message still count', async () => {
    const cfg = config({ duplicateSeverity: 'medium', duplicateCount: 2 });
    const window = new CountingWindow();

    const first = await screen(
      input(cfg, window, {
        facts: facts({ messageId: '1', content: 'buy cheap followers now' }),
        eventId: 'evt-1',
      }),
    );
    const second = await screen(
      input(cfg, window, {
        facts: facts({ messageId: '2', content: 'buy cheap followers now' }),
        eventId: 'evt-2',
      }),
    );

    expect(first.matched).toBe(false);
    expect(second.matched).toBe(true);
  });

  test('different text does not accumulate against the same fingerprint', async () => {
    const cfg = config({ duplicateSeverity: 'medium', duplicateCount: 2 });
    const window = new CountingWindow();

    await screen(
      input(cfg, window, { facts: facts({ content: 'the first thing said' }), eventId: 'a' }),
    );
    const second = await screen(
      input(cfg, window, { facts: facts({ content: 'a different thing said' }), eventId: 'b' }),
    );

    expect(second.matched).toBe(false);
  });

  test('short messages are exempt from the duplicate check', async () => {
    const cfg = config({ duplicateSeverity: 'medium', duplicateCount: 2 });
    const window = new CountingWindow();

    for (const eventId of ['a', 'b', 'c']) {
      await screen(input(cfg, window, { facts: facts({ content: 'lol' }), eventId }));
    }

    expect(window.calls).toHaveLength(0);
  });

  test('the event id is the rate-window member, so a redelivery counts once', async () => {
    const cfg = config({ floodSeverity: 'medium' });
    const window = new CountingWindow();

    await screen(input(cfg, window, { eventId: 'evt-7' }));

    expect(window.calls[0]?.member).toBe('evt-7');
  });
});

describe('duplicateFingerprint', () => {
  test('the same normalised text hashes the same', () => {
    expect(duplicateFingerprint('hello there')).toBe(duplicateFingerprint('hello there'));
  });

  test('different text hashes differently', () => {
    expect(duplicateFingerprint('hello there')).not.toBe(duplicateFingerprint('hello here'));
  });
});

describe('isExempt', () => {
  const botUserId = '200000000000000001';
  const state: GuildState = {
    guildId: '900000000000000001',
    ownerId: '1',
    everyoneRoleId: '900000000000000001',
    roles: new Map(),
    botRoleIds: [],
    channels: new Map([
      [
        '600000000000000001',
        { id: '600000000000000001', parentId: '500000000000000002', overwrites: [] },
      ],
    ]),
    updatedAt: 0,
  };

  test('Proton never screens itself, whatever the config says', () => {
    expect(
      isExempt({
        facts: facts({ authorId: botUserId, isBot: true }),
        config: config({ exemptBots: false }),
        botUserId,
        state: null,
      }),
    ).toBe('self');
  });

  test('system messages are never punished', () => {
    expect(isExempt({ facts: facts({ type: 7 }), config: config(), botUserId, state: null })).toBe(
      'not_a_human_message',
    );
  });

  test('replies are screened', () => {
    expect(
      isExempt({ facts: facts({ type: 19 }), config: config(), botUserId, state: null }),
    ).toBeNull();
  });

  test('other bots are exempt only while exemptBots is on', () => {
    const bot = facts({ authorId: '300000000000000001', isBot: true });
    expect(isExempt({ facts: bot, config: config(), botUserId, state: null })).toBe('bot');
    expect(
      isExempt({ facts: bot, config: config({ exemptBots: false }), botUserId, state: null }),
    ).toBeNull();
  });

  test('an exempt channel covers threads inside it', () => {
    const inThread = facts({ channelId: '600000000000000001' });
    const cfg = config({ exemptChannelIds: ['500000000000000002'] });

    expect(isExempt({ facts: inThread, config: cfg, botUserId, state })).toBe('channel');
    expect(isExempt({ facts: inThread, config: cfg, botUserId, state: null })).toBeNull();
  });

  test('holding any exempt role is enough', () => {
    expect(
      isExempt({
        facts: facts({ roleIds: ['700000000000000001', '700000000000000002'] }),
        config: config({ exemptRoleIds: ['700000000000000002'] }),
        botUserId,
        state: null,
      }),
    ).toBe('role');
  });
});
