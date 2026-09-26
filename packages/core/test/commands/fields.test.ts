import { describe, expect, test } from 'bun:test';
import {
  type RESTPostAPIChatInputApplicationCommandsJSONBody,
  ApplicationCommandOptionType as T,
} from 'discord-api-types/v10';
import {
  commandFieldSchema,
  commandFields,
  fieldPaths,
  leafPaths,
} from '../../src/commands/fields.ts';

const ticket: RESTPostAPIChatInputApplicationCommandsJSONBody = {
  name: 'ticket',
  description: 'Manage tickets.',
  options: [
    {
      type: T.Subcommand,
      name: 'add',
      description: 'Add someone to this ticket.',
      options: [{ type: T.User, name: 'user', description: 'Who to add.', required: true }],
    },
    {
      type: T.SubcommandGroup,
      name: 'blacklist',
      description: 'Keep people from opening tickets.',
      options: [
        {
          type: T.Subcommand,
          name: 'add',
          description: 'Blacklist someone.',
          options: [
            { type: T.User, name: 'user', description: 'Who to blacklist.', required: true },
            { type: T.String, name: 'reason', description: 'Why.' },
          ],
        },
        { type: T.Subcommand, name: 'list', description: 'Everyone blacklisted.' },
      ],
    },
    { type: T.Subcommand, name: 'list', description: 'Your tickets.' },
  ],
};

const flat: RESTPostAPIChatInputApplicationCommandsJSONBody = {
  name: 'kick',
  description: 'Kick a member.',
  options: [
    { type: T.User, name: 'user', description: 'Who to kick.', required: true },
    { type: T.String, name: 'reason', description: 'Why.', autocomplete: true },
    { type: T.Integer, name: 'days', description: 'Days.' },
    { type: T.Number, name: 'ratio', description: 'Ratio.' },
    { type: T.Boolean, name: 'silent', description: 'Quietly.' },
    { type: T.Channel, name: 'where', description: 'Channel.' },
    { type: T.Role, name: 'role', description: 'Role.' },
    { type: T.Mentionable, name: 'who', description: 'Anyone.' },
    { type: T.Attachment, name: 'proof', description: 'Proof.' },
  ],
};

describe('commandFields', () => {
  test('builds groups, subcommands and options with their paths, in code order', () => {
    expect(commandFields(ticket)).toEqual([
      {
        path: 'add',
        name: 'add',
        kind: 'subcommand',
        description: 'Add someone to this ticket.',
        children: [
          {
            path: 'add.user',
            name: 'user',
            kind: 'option',
            optionType: 'user',
            required: true,
            description: 'Who to add.',
            children: [],
          },
        ],
      },
      {
        path: 'blacklist',
        name: 'blacklist',
        kind: 'group',
        description: 'Keep people from opening tickets.',
        children: [
          {
            path: 'blacklist.add',
            name: 'add',
            kind: 'subcommand',
            description: 'Blacklist someone.',
            children: [
              {
                path: 'blacklist.add.user',
                name: 'user',
                kind: 'option',
                optionType: 'user',
                required: true,
                description: 'Who to blacklist.',
                children: [],
              },
              {
                path: 'blacklist.add.reason',
                name: 'reason',
                kind: 'option',
                optionType: 'string',
                required: false,
                description: 'Why.',
                children: [],
              },
            ],
          },
          {
            path: 'blacklist.list',
            name: 'list',
            kind: 'subcommand',
            description: 'Everyone blacklisted.',
            children: [],
          },
        ],
      },
      {
        path: 'list',
        name: 'list',
        kind: 'subcommand',
        description: 'Your tickets.',
        children: [],
      },
    ]);
  });

  test('names every option type Discord has', () => {
    expect(commandFields(flat).map((field) => field.optionType)).toEqual([
      'user',
      'string',
      'integer',
      'number',
      'boolean',
      'channel',
      'role',
      'mentionable',
      'attachment',
    ]);
  });

  test('a flat option’s path is its own name', () => {
    expect(commandFields(flat).map((field) => field.path)).toEqual([
      'user',
      'reason',
      'days',
      'ratio',
      'silent',
      'where',
      'role',
      'who',
      'proof',
    ]);
  });

  test('a command with no options has no fields', () => {
    expect(commandFields({ name: 'ping', description: 'Pong.' })).toEqual([]);
  });

  test('what it builds is what the shared schema accepts, so it crosses the api unchanged', () => {
    const fields = commandFields(ticket);

    expect(fields.map((field) => commandFieldSchema.parse(field))).toEqual(fields);
  });

  test('the schema refuses a field of a kind it does not know', () => {
    expect(
      commandFieldSchema.safeParse({
        path: 'x',
        name: 'x',
        kind: 'choice',
        description: '',
        children: [],
      }).success,
    ).toBe(false);
  });
});

describe('fieldPaths', () => {
  test('collects every level, so identically named options stay distinct', () => {
    expect([...fieldPaths(commandFields(ticket))].sort()).toEqual([
      'add',
      'add.user',
      'blacklist',
      'blacklist.add',
      'blacklist.add.reason',
      'blacklist.add.user',
      'blacklist.list',
      'list',
    ]);
  });

  test('is empty for a command with no options', () => {
    expect(fieldPaths([]).size).toBe(0);
  });
});

describe('leafPaths', () => {
  test('is a single empty path for a command with no subcommands', () => {
    expect(leafPaths(flat)).toEqual(['']);
    expect(leafPaths({ name: 'ping', description: 'Pong.' })).toEqual(['']);
  });

  test('lists every runnable subcommand, groups joined with a dot', () => {
    expect(leafPaths(ticket)).toEqual(['add', 'blacklist.add', 'blacklist.list', 'list']);
  });

  test('never lists a group itself', () => {
    expect(leafPaths(ticket)).not.toContain('blacklist');
  });
});
