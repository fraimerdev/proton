import { describe, expect, test } from 'bun:test';
import {
  CommandOptionTypeError,
  createCommandOptions,
  OptionType,
  type RawOption,
} from '../../src/modules/options.ts';

const USER = '100000000000000001';
const CHANNEL = '500000000000000001';
const ROLE = '400000000000000001';

describe('createCommandOptions', () => {
  const options = createCommandOptions([
    { name: 'text', type: OptionType.String, value: 'hello' },
    { name: 'count', type: OptionType.Integer, value: 5 },
    { name: 'ratio', type: OptionType.Number, value: 1.5 },
    { name: 'silent', type: OptionType.Boolean, value: true },
    { name: 'target', type: OptionType.User, value: USER },
    { name: 'where', type: OptionType.Channel, value: CHANNEL },
    { name: 'role', type: OptionType.Role, value: ROLE },
  ]);

  test('reads each option as its declared type', () => {
    expect(options.getString('text')).toBe('hello');
    expect(options.getInteger('count')).toBe(5);
    expect(options.getNumber('ratio')).toBe(1.5);
    expect(options.getBoolean('silent')).toBe(true);
  });

  test('snowflake options come back as strings, ready for targetId', () => {
    expect(options.getUserId('target')).toBe(USER);
    expect(options.getChannelId('where')).toBe(CHANNEL);
    expect(options.getRoleId('role')).toBe(ROLE);
    expect(typeof options.getUserId('target')).toBe('string');
  });

  test('an absent option is null, not an error', () => {
    expect(options.getString('missing')).toBeNull();
    expect(options.getUserId('missing')).toBeNull();
    expect(options.has('missing')).toBe(false);
    expect(options.has('text')).toBe(true);
  });

  test('an empty option list is safe', () => {
    const empty = createCommandOptions();

    expect(empty.getString('anything')).toBeNull();
    expect(empty.getSubcommand()).toBeNull();
  });

  test('getNumber accepts an integer, since Discord may send either', () => {
    expect(options.getNumber('count')).toBe(5);
  });

  test('asking for the wrong type throws rather than returning null', () => {
    expect(() => options.getInteger('text')).toThrow(CommandOptionTypeError);
    expect(() => options.getString('count')).toThrow(/registered options and its handler disagree/);
  });
});

describe('subcommand flattening', () => {
  const raw: RawOption[] = [
    {
      name: 'add',
      type: OptionType.Subcommand,
      options: [{ name: 'user', type: OptionType.User, value: USER }],
    },
  ];

  test('exposes the subcommand and flattens its options', () => {
    const options = createCommandOptions(raw);

    expect(options.getSubcommand()).toBe('add');

    expect(options.getUserId('user')).toBe(USER);
  });

  test('handles a subcommand group two levels deep', () => {
    const options = createCommandOptions([
      {
        name: 'role',
        type: OptionType.SubcommandGroup,
        options: raw,
      },
    ]);

    expect(options.getSubcommandGroup()).toBe('role');
    expect(options.getSubcommand()).toBe('add');
    expect(options.getUserId('user')).toBe(USER);
  });

  test('a flat command reports no subcommand', () => {
    const options = createCommandOptions([{ name: 'text', type: OptionType.String, value: 'hi' }]);

    expect(options.getSubcommand()).toBeNull();
    expect(options.getSubcommandGroup()).toBeNull();
  });
});
