import { describe, expect, test } from 'bun:test';
import {
  GatewayIntentBits,
  type RESTPostAPIChatInputApplicationCommandsJSONBody,
  ApplicationCommandOptionType as T,
} from 'discord-api-types/v10';
import { z } from 'zod';
import type { CommandDefinition, ModuleManifest } from '../../src/modules/manifest.ts';
import {
  MAX_CHAT_COMMANDS,
  ModuleRegistrationError,
  ModuleRegistry,
} from '../../src/modules/registry.ts';

function command(
  name: string,
  data: Partial<RESTPostAPIChatInputApplicationCommandsJSONBody> = {},
  extra: Partial<CommandDefinition> = {},
): CommandDefinition {
  return {
    name,
    description: `The ${name} command.`,
    data: { name, description: `The ${name} command.`, ...data },
    handler: async () => undefined,
    ...extra,
  };
}

function manifest(id: string, commands: CommandDefinition[]): ModuleManifest {
  return {
    id,
    name: id,
    category: 'utility',
    configSchema: z.object({ enabled: z.boolean().default(true) }),
    defaultConfig: { enabled: true },
    schemaVersion: 1,
    requiredIntents: [GatewayIntentBits.Guilds],
    requiredPermissions: [],
    commands,
  } as unknown as ModuleManifest;
}

const withSubcommands: Partial<RESTPostAPIChatInputApplicationCommandsJSONBody> = {
  options: [
    { type: T.Subcommand, name: 'give', description: 'Give XP.' },
    {
      type: T.SubcommandGroup,
      name: 'event',
      description: 'XP events.',
      options: [{ type: T.Subcommand, name: 'start', description: 'Start one.' }],
    },
  ],
};

describe('slash commands at registration', () => {
  test('a module may declare valid commands, with a reply policy over its leaf paths', () => {
    const registry = new ModuleRegistry();

    registry.register(
      manifest('leveling', [
        command('rank'),
        command('xp', withSubcommands, {
          reply: { default: 'public', toggleable: ['give', 'event.start'] },
        }),
        command('ping', {}, { reply: { default: 'public', toggleable: [''] } }),
      ]),
    );

    expect(registry.get('leveling')?.commands).toHaveLength(3);
  });

  test('refuses a command whose data carries a different name, and names both', () => {
    const registry = new ModuleRegistry();

    expect(() =>
      registry.register(manifest('moderation', [command('ban', { name: 'banish' })])),
    ).toThrow("the command '/ban' registers data named 'banish'");
    expect(registry.get('moderation')).toBeUndefined();
  });

  test('refuses a name another module already declared, and names the owner', () => {
    const registry = new ModuleRegistry();
    registry.register(manifest('moderation', [command('warn')]));

    expect(() => registry.register(manifest('tickets', [command('warn')]))).toThrow(
      "the command '/warn' is already declared by 'moderation'",
    );
    expect(registry.get('tickets')).toBeUndefined();
  });

  test('refuses the same command declared twice in one module', () => {
    expect(() =>
      new ModuleRegistry().register(manifest('tags', [command('tag'), command('tag')])),
    ).toThrow("the command '/tag' is declared twice");
  });

  test(`refuses a module that takes Proton past Discord’s ${MAX_CHAT_COMMANDS} commands`, () => {
    const registry = new ModuleRegistry();
    registry.register(
      manifest(
        'many',
        Array.from({ length: MAX_CHAT_COMMANDS }, (_unused, index) => command(`c${index}`)),
      ),
    );

    expect(() => registry.register(manifest('one-more', [command('extra')]))).toThrow(
      `it brings Proton to ${MAX_CHAT_COMMANDS + 1} slash commands, and Discord allows ` +
        `${MAX_CHAT_COMMANDS} per server`,
    );
  });

  const refused: [
    string,
    string,
    Partial<RESTPostAPIChatInputApplicationCommandsJSONBody>,
    string,
  ][] = [
    ['an uppercase name', 'Ban', {}, 'name: Command names must be lowercase.'],
    [
      'a name with a space',
      'my tag',
      {},
      'name: Command names can only use letters, numbers, - and _, with no spaces.',
    ],
    [
      'an overlong description',
      'tag',
      { description: 'x'.repeat(120) },
      'description: Descriptions can be at most 100 characters (this one is 120).',
    ],
    [
      'an option with no description',
      'tag',
      { options: [{ type: T.String, name: 'name', description: '' }] },
      'options.name: Discord needs a description here.',
    ],
  ];

  test.each(refused)(
    'refuses %s and says what Discord would refuse',
    (_label, name, data, detail) => {
      expect(() => new ModuleRegistry().register(manifest('tags', [command(name, data)]))).toThrow(
        `Discord would refuse /${name}: ${detail}`,
      );
    },
  );

  test('refuses a reply policy that toggles a path the command does not have', () => {
    expect(() =>
      new ModuleRegistry().register(
        manifest('leveling', [
          command('xp', withSubcommands, {
            reply: { default: 'public', toggleable: ['give', 'event', 'take'] },
          }),
        ]),
      ),
    ).toThrow(
      "/xp lets admins choose the reply visibility of 'event', 'take', which are not a " +
        'subcommand path of it — its subcommands are give, event.start',
    );
  });

  test('a command with no subcommands is toggled only at the empty path', () => {
    expect(() =>
      new ModuleRegistry().register(
        manifest('ping', [
          command('ping', {}, { reply: { default: 'public', toggleable: ['ping'] } }),
        ]),
      ),
    ).toThrow(
      "/ping lets admins choose the reply visibility of 'ping', which is not a subcommand path " +
        'of it — it has no subcommands, so the only path is an empty string',
    );
  });

  test('every refusal is a registration error that names the module', () => {
    let caught: unknown;
    try {
      new ModuleRegistry().register(manifest('tags', [command('Tag')]));
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ModuleRegistrationError);
    expect((caught as Error).message).toStartWith("Module 'tags' is invalid: ");
  });
});
