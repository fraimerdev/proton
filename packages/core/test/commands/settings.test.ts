import { describe, expect, test } from 'bun:test';
import {
  COMMAND_NAME_PATTERN,
  COMMAND_SETTINGS_SCHEMA_VERSION,
  type CommandSettings,
  codePointLength,
  commandInputSchema,
  commandSettingsSchema,
  DEFAULT_COMMAND_SETTINGS,
  isCustomized,
  resetCustomization,
} from '../../src/commands/settings.ts';

const customized: CommandSettings = {
  enabled: false,
  name: 'punish',
  description: 'Remove a member for good.',
  optionDescriptions: { 'add.user': 'Who to remove.' },
  privateReply: true,
};

describe('commandSettingsSchema', () => {
  test('a row jsonb stored with every key dropped still parses to the defaults', () => {
    expect(commandSettingsSchema.parse({})).toEqual({
      enabled: true,
      name: null,
      description: null,
      optionDescriptions: {},
      privateReply: null,
    });
  });

  test('the defaults are what the schema produces, and start at version 1', () => {
    expect(DEFAULT_COMMAND_SETTINGS).toEqual(commandSettingsSchema.parse({}));
    expect(COMMAND_SETTINGS_SCHEMA_VERSION).toBe(1);
  });

  test('two parses never share one option-description map', () => {
    const first = commandSettingsSchema.parse({});
    first.optionDescriptions.reason = 'Why.';

    expect(commandSettingsSchema.parse({}).optionDescriptions).toEqual({});
    expect(DEFAULT_COMMAND_SETTINGS.optionDescriptions).toEqual({});
  });

  test('keeps a full row as it was stored', () => {
    expect(commandSettingsSchema.parse(customized)).toEqual(customized);
  });

  test('refuses a row whose override is not text', () => {
    expect(commandSettingsSchema.safeParse({ optionDescriptions: { reason: 7 } }).success).toBe(
      false,
    );
    expect(commandSettingsSchema.safeParse({ privateReply: 'yes' }).success).toBe(false);
  });

  test('the dashboard input carries every customization field and nothing about the switch', () => {
    const parsed = commandInputSchema.parse({
      name: 'punish',
      description: null,
      optionDescriptions: {},
      privateReply: null,
      enabled: false,
    });

    expect(parsed).toEqual({
      name: 'punish',
      description: null,
      optionDescriptions: {},
      privateReply: null,
    });
  });
});

describe('resetCustomization', () => {
  test('clears every override and keeps the switch where it was', () => {
    expect(resetCustomization(customized)).toEqual({
      enabled: false,
      name: null,
      description: null,
      optionDescriptions: {},
      privateReply: null,
    });
  });

  test('never switches a command on', () => {
    expect(resetCustomization({ ...customized, enabled: true }).enabled).toBe(true);
    expect(resetCustomization(customized).enabled).toBe(false);
  });
});

describe('isCustomized', () => {
  test('the defaults are not a customization', () => {
    expect(isCustomized(DEFAULT_COMMAND_SETTINGS)).toBe(false);
  });

  test('a switched-off command with no overrides is not customized', () => {
    expect(isCustomized({ ...DEFAULT_COMMAND_SETTINGS, enabled: false })).toBe(false);
  });

  test.each([
    ['a name', { name: 'punish' }],
    ['a description', { description: 'Remove a member.' }],
    ['an option description', { optionDescriptions: { reason: 'Why.' } }],
    ['a reply preference of private', { privateReply: true }],
    ['a reply preference of public', { privateReply: false }],
  ])('%s is a customization', (_label, override) => {
    expect(isCustomized({ ...DEFAULT_COMMAND_SETTINGS, ...override })).toBe(true);
  });

  test('blank overrides inherit, so they are not a customization', () => {
    expect(
      isCustomized({
        ...DEFAULT_COMMAND_SETTINGS,
        name: '  ',
        description: '',
        optionDescriptions: { reason: ' ' },
      }),
    ).toBe(false);
  });
});

describe('COMMAND_NAME_PATTERN', () => {
  test.each([
    'ban',
    'ticket-blacklist',
    'allow_repeat',
    'x',
    'a'.repeat(32),
    'модерация',
    'पकड़',
    'ห้าม',
    'ʼban',
    'level2',
  ])('accepts %p', (name) => {
    expect(COMMAND_NAME_PATTERN.test(name)).toBe(true);
  });

  test.each(['', 'a'.repeat(33), 'ban user', 'ban!', '/ban', 'b.an', 'emoji🔨'])(
    'refuses %p',
    (name) => {
      expect(COMMAND_NAME_PATTERN.test(name)).toBe(false);
    },
  );

  test('counts 32 astral letters as 32 characters, not 64', () => {
    const astral = '𝒶'.repeat(32);

    expect(astral.length).toBe(64);
    expect(COMMAND_NAME_PATTERN.test(astral)).toBe(true);
    expect(COMMAND_NAME_PATTERN.test(`${astral}𝒶`)).toBe(false);
  });
});

describe('codePointLength', () => {
  test('counts code points, not UTF-16 units', () => {
    expect(codePointLength('')).toBe(0);
    expect(codePointLength('ban')).toBe(3);
    expect(codePointLength('𝒶𝒷')).toBe(2);
    expect(codePointLength('🔨 ban')).toBe(5);
  });
});
