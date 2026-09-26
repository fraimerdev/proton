import { describe, expect, test } from 'bun:test';
import {
  type RESTPostAPIChatInputApplicationCommandsJSONBody,
  ApplicationCommandOptionType as T,
} from 'discord-api-types/v10';
import {
  type CommandReplyPolicy,
  replyControl,
  replyControlSchema,
  replyDefault,
  resolvePrivateReply,
  subcommandPath,
} from '../../src/commands/visibility.ts';
import { OptionType, type RawOption } from '../../src/modules/options.ts';

interface ModerationConfig {
  publicReplies: boolean;
}

const moderation: CommandReplyPolicy<ModerationConfig> = {
  default: (config) => (config.publicReplies ? 'public' : 'private'),
  toggleable: ['add', 'remove'],
  inheritsFrom: { label: 'Moderation → Reply publicly', moduleId: 'moderation' },
};

const xp: CommandReplyPolicy<unknown> = {
  default: (_config, path) => (path.startsWith('event.') ? 'private' : 'public'),
  toggleable: ['give', 'take', 'set'],
};

const ping: CommandReplyPolicy = { default: 'public', toggleable: [''] };

const xpData: RESTPostAPIChatInputApplicationCommandsJSONBody = {
  name: 'xp',
  description: 'Manage XP.',
  options: [
    { type: T.Subcommand, name: 'give', description: 'Give XP.' },
    { type: T.Subcommand, name: 'take', description: 'Take XP.' },
    { type: T.Subcommand, name: 'set', description: 'Set XP.' },
    {
      type: T.SubcommandGroup,
      name: 'event',
      description: 'XP events.',
      options: [
        { type: T.Subcommand, name: 'start', description: 'Start one.' },
        { type: T.Subcommand, name: 'end', description: 'End it.' },
      ],
    },
  ],
};

const banData: RESTPostAPIChatInputApplicationCommandsJSONBody = {
  name: 'ban',
  description: 'Ban a member.',
  options: [
    { type: T.Subcommand, name: 'add', description: 'Ban someone.' },
    { type: T.Subcommand, name: 'remove', description: 'Lift a ban.' },
  ],
};

const pingData: RESTPostAPIChatInputApplicationCommandsJSONBody = {
  name: 'ping',
  description: 'Pong.',
};

function sub(name: string, options: RawOption[] = []): RawOption {
  return { name, type: OptionType.Subcommand, options };
}

function group(name: string, options: RawOption[]): RawOption {
  return { name, type: OptionType.SubcommandGroup, options };
}

describe('subcommandPath', () => {
  test('is empty for a command with no subcommands', () => {
    expect(subcommandPath(undefined)).toBe('');
    expect(subcommandPath([])).toBe('');
    expect(subcommandPath([{ name: 'user', type: OptionType.User, value: '1' }])).toBe('');
  });

  test('names the subcommand', () => {
    expect(
      subcommandPath([sub('add', [{ name: 'user', type: OptionType.User, value: '1' }])]),
    ).toBe('add');
  });

  test('joins a group and its subcommand with a dot', () => {
    expect(subcommandPath([group('blacklist', [sub('list')])])).toBe('blacklist.list');
  });

  test('keeps a grouped list apart from the root list it shares a name with', () => {
    expect(subcommandPath([sub('list')])).not.toBe(
      subcommandPath([group('blacklist', [sub('list')])]),
    );
  });
});

describe('resolvePrivateReply', () => {
  test('with no preference every path uses its default', () => {
    expect(resolvePrivateReply(moderation, { publicReplies: false }, 'add', null)).toBe(true);
    expect(resolvePrivateReply(moderation, { publicReplies: true }, 'add', null)).toBe(false);
    expect(resolvePrivateReply(xp, {}, 'give', null)).toBe(false);
    expect(resolvePrivateReply(xp, {}, 'event.start', null)).toBe(true);
  });

  test('a preference decides only the paths the policy lets it', () => {
    expect(resolvePrivateReply(xp, {}, 'give', true)).toBe(true);
    expect(resolvePrivateReply(xp, {}, 'set', true)).toBe(true);
    expect(resolvePrivateReply(moderation, { publicReplies: false }, 'remove', false)).toBe(false);
  });

  test('a path outside the allowlist keeps its default whatever the preference says', () => {
    expect(resolvePrivateReply(xp, {}, 'event.start', false)).toBe(true);
    expect(resolvePrivateReply(xp, {}, 'event.end', false)).toBe(true);
    expect(resolvePrivateReply(xp, {}, 'unknown', true)).toBe(false);
  });

  test('the allowlist matches whole paths, so a grouped list is not the root list', () => {
    const giveaway: CommandReplyPolicy = { default: 'private', toggleable: ['list'] };

    expect(resolvePrivateReply(giveaway, {}, 'list', false)).toBe(false);
    expect(resolvePrivateReply(giveaway, {}, 'blacklist.list', false)).toBe(true);
  });

  test('a command with no subcommands is toggled at the empty path', () => {
    expect(resolvePrivateReply(ping, {}, '', null)).toBe(false);
    expect(resolvePrivateReply(ping, {}, '', true)).toBe(true);
  });
});

describe('replyDefault', () => {
  test('reads a fixed default or asks the policy with the config and path', () => {
    expect(replyDefault(ping, {}, '')).toBe('public');
    expect(replyDefault(moderation, { publicReplies: true }, 'add')).toBe('public');
    expect(replyDefault(xp, {}, 'event.end')).toBe('private');
  });
});

describe('replyControl', () => {
  test('is null for a command that declares no policy', () => {
    expect(replyControl(undefined, pingData, {})).toBeNull();
  });

  test('lists every leaf path with its default and whether the switch reaches it', () => {
    expect(replyControl(xp, xpData, {})).toEqual({
      supported: true,
      paths: [
        { path: 'give', default: 'public', toggleable: true },
        { path: 'take', default: 'public', toggleable: true },
        { path: 'set', default: 'public', toggleable: true },
        { path: 'event.start', default: 'private', toggleable: false },
        { path: 'event.end', default: 'private', toggleable: false },
      ],
    });
  });

  test('carries the module setting a default follows, with config read for the defaults', () => {
    expect(replyControl(moderation, banData, { publicReplies: true })).toEqual({
      supported: true,
      paths: [
        { path: 'add', default: 'public', toggleable: true },
        { path: 'remove', default: 'public', toggleable: true },
      ],
      inheritsFrom: { label: 'Moderation → Reply publicly', moduleId: 'moderation' },
    });
  });

  test('a policy that toggles nothing is shown but not supported', () => {
    const fixed: CommandReplyPolicy = { default: 'private', toggleable: [] };

    expect(replyControl(fixed, banData, {})).toEqual({
      supported: false,
      paths: [
        { path: 'add', default: 'private', toggleable: false },
        { path: 'remove', default: 'private', toggleable: false },
      ],
    });
  });

  test('a toggleable entry that is not a leaf of this definition supports nothing', () => {
    const stale: CommandReplyPolicy = { default: 'private', toggleable: ['retired'] };

    expect(replyControl(stale, banData, {})?.supported).toBe(false);
  });

  test('a command with no subcommands has the one empty path', () => {
    expect(replyControl(ping, pingData, {})).toEqual({
      supported: true,
      paths: [{ path: '', default: 'public', toggleable: true }],
    });
  });

  test('what it builds crosses the api through the shared schema unchanged', () => {
    const control = replyControl(moderation, banData, { publicReplies: false });

    expect(replyControlSchema.parse(control)).toEqual(control as NonNullable<typeof control>);
  });
});
