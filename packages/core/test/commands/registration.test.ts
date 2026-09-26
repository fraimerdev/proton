import { describe, expect, test } from 'bun:test';
import {
  ApplicationCommandType,
  GatewayIntentBits,
  type RESTPostAPIChatInputApplicationCommandsJSONBody,
  ApplicationCommandOptionType as T,
} from 'discord-api-types/v10';
import { z } from 'zod';
import { commandSize } from '../../src/commands/effective.ts';
import {
  type CatalogueEntry,
  commandCatalogue,
  commandSetFingerprint,
  commandSetHash,
  definitionHash,
  type EffectiveCommand,
  effectiveCommandNames,
  effectiveCommandSet,
  type StoredCommandSettings,
  stableJson,
} from '../../src/commands/registration.ts';
import { commandSettingsSchema } from '../../src/commands/settings.ts';
import type {
  CommandDefinition,
  ContextMenuDefinition,
  ModuleManifest,
} from '../../src/modules/manifest.ts';
import { ModuleRegistry } from '../../src/modules/registry.ts';

function command(
  data: RESTPostAPIChatInputApplicationCommandsJSONBody,
  extra: Partial<CommandDefinition> = {},
): CommandDefinition {
  return {
    name: data.name,
    description: data.description,
    data,
    handler: async () => undefined,
    ...extra,
  };
}

function menu(name: string, type: 'user' | 'message'): ContextMenuDefinition {
  return {
    name,
    type,
    description: `${name}, from the Apps menu.`,
    data: {
      name,
      type: type === 'user' ? ApplicationCommandType.User : ApplicationCommandType.Message,
    },
    handler: async () => undefined,
  };
}

function manifest(
  id: string,
  commands: CommandDefinition[],
  contextMenus: ContextMenuDefinition[] = [],
): ModuleManifest {
  return {
    id,
    name: id.charAt(0).toUpperCase() + id.slice(1),
    category: 'utility',
    configSchema: z.object({ enabled: z.boolean().default(true) }),
    defaultConfig: { enabled: true },
    schemaVersion: 1,
    requiredIntents: [GatewayIntentBits.Guilds],
    requiredPermissions: [],
    commands,
    contextMenus,
  } as unknown as ModuleManifest;
}

const ban = command({
  name: 'ban',
  description: 'Ban a member.',
  default_member_permissions: '4',
  options: [
    {
      type: T.Subcommand,
      name: 'add',
      description: 'Ban someone.',
      options: [{ type: T.User, name: 'user', description: 'Who to ban.', required: true }],
    },
    { type: T.Subcommand, name: 'remove', description: 'Lift a ban.' },
  ],
});
const kick = command({ name: 'kick', description: 'Kick a member.' });
const help = command(
  { name: 'help', description: 'Open the dashboard.' },
  { alwaysRegistered: true },
);
const tag = command({ name: 'tag', description: 'Post a tag.' });

function registry(): ModuleRegistry {
  const built = new ModuleRegistry();
  built.register(manifest('help', [help]));
  built.register(manifest('moderation', [ban, kick], [menu('Report user', 'user')]));
  built.register(manifest('tags', [tag], [menu('Quote', 'message')]));
  return built;
}

const catalogue = commandCatalogue(registry());

const ALL_ON = { help: true, moderation: true, tags: true };

function stored(overrides: Partial<StoredCommandSettings> = {}): StoredCommandSettings {
  return { ...commandSettingsSchema.parse({}), updatedAt: null, ...overrides };
}

function keysOf(commands: readonly EffectiveCommand[]): string[] {
  return commands.map(({ key }) => key);
}

function bodyOf(commands: readonly EffectiveCommand[], key: string) {
  const found = commands.find((entry) => entry.key === key);
  if (!found) throw new Error(`expected ${key} in the set`);
  return found.body;
}

describe('commandCatalogue', () => {
  test('lists every slash command and context menu under a stable key', () => {
    expect(catalogue.map(({ key, kind, moduleId }) => ({ key, kind, moduleId }))).toEqual([
      { key: 'help', kind: 'chat', moduleId: 'help' },
      { key: 'ban', kind: 'chat', moduleId: 'moderation' },
      { key: 'kick', kind: 'chat', moduleId: 'moderation' },
      { key: 'user:Report user', kind: 'user', moduleId: 'moderation' },
      { key: 'tag', kind: 'chat', moduleId: 'tags' },
      { key: 'message:Quote', kind: 'message', moduleId: 'tags' },
    ]);
  });

  test('carries the definition itself and whether it stays while its module is off', () => {
    const helpEntry = catalogue.find((entry) => entry.key === 'help') as CatalogueEntry;
    const menuEntry = catalogue.find((entry) => entry.kind === 'user') as CatalogueEntry;

    expect(helpEntry.alwaysRegistered).toBe(true);
    expect(helpEntry.command).toBe(help);
    expect(helpEntry.data).toBe(help.data);
    expect(menuEntry.alwaysRegistered).toBe(false);
    expect(menuEntry.menu?.name).toBe('Report user');
    expect(menuEntry.command).toBeUndefined();
    expect(catalogue.find((entry) => entry.key === 'ban')?.alwaysRegistered).toBe(false);
  });

  test('needs nothing of the registry but its modules', () => {
    expect(commandCatalogue({ all: () => [] })).toEqual([]);
  });
});

describe('effectiveCommandSet inclusion', () => {
  test('registers every command of every module that is on', () => {
    const { commands, ignored } = effectiveCommandSet({
      catalogue,
      modulesOn: ALL_ON,
      settings: {},
    });

    expect(keysOf(commands)).toEqual([
      'help',
      'ban',
      'kick',
      'user:Report user',
      'tag',
      'message:Quote',
    ]);
    expect(ignored).toEqual({});
    expect(bodyOf(commands, 'ban')).toEqual(ban.data);
  });

  test('a module that is off takes its commands and menus with it', () => {
    const { commands } = effectiveCommandSet({
      catalogue,
      modulesOn: { help: true, moderation: false, tags: true },
      settings: {},
    });

    expect(keysOf(commands)).toEqual(['help', 'tag', 'message:Quote']);
  });

  test('a module missing from the map counts as off', () => {
    expect(
      keysOf(effectiveCommandSet({ catalogue, modulesOn: {}, settings: {} }).commands),
    ).toEqual(['help']);
  });

  test('an always-registered command stays while its module is off', () => {
    const { commands } = effectiveCommandSet({
      catalogue,
      modulesOn: { help: false },
      settings: {},
    });

    expect(keysOf(commands)).toEqual(['help']);
  });

  test('a command switched off is not registered, even an always-registered one', () => {
    const { commands } = effectiveCommandSet({
      catalogue,
      modulesOn: ALL_ON,
      settings: { kick: stored({ enabled: false }), help: stored({ enabled: false }) },
    });

    expect(keysOf(commands)).not.toContain('kick');
    expect(keysOf(commands)).not.toContain('help');
    expect(keysOf(commands)).toContain('ban');
  });

  test('a switched-off command keeps its name, so switching it back on changes nothing else', () => {
    const settings = {
      ban: stored({ name: 'punish', enabled: false, updatedAt: '2026-09-01T00:00:00Z' }),
    };
    const off = effectiveCommandSet({ catalogue, modulesOn: ALL_ON, settings });
    const on = effectiveCommandSet({
      catalogue,
      modulesOn: ALL_ON,
      settings: { ban: { ...settings.ban, enabled: true } },
    });

    expect(keysOf(off.commands)).not.toContain('ban');
    expect(bodyOf(on.commands, 'ban').name).toBe('punish');
  });
});

describe('effectiveCommandSet customization', () => {
  test('merges the stored overrides into the body Discord receives', () => {
    const { commands } = effectiveCommandSet({
      catalogue,
      modulesOn: ALL_ON,
      settings: {
        ban: stored({
          name: 'punish',
          description: 'Remove someone.',
          optionDescriptions: { 'add.user': 'The member.' },
          updatedAt: '2026-09-01T00:00:00Z',
        }),
      },
    });
    const body = bodyOf(commands, 'ban') as RESTPostAPIChatInputApplicationCommandsJSONBody;

    expect(body.name).toBe('punish');
    expect(body.description).toBe('Remove someone.');
    expect(body.default_member_permissions).toBe('4');
    const add = body.options?.[0] as { options: Array<Record<string, unknown>> };
    expect(add.options[0]).toEqual({
      type: T.User,
      name: 'user',
      description: 'The member.',
      required: true,
    });
  });

  test('a reply preference alone leaves the body exactly the code definition', () => {
    const { commands } = effectiveCommandSet({
      catalogue,
      modulesOn: ALL_ON,
      settings: { ban: stored({ privateReply: true }) },
    });

    expect(bodyOf(commands, 'ban')).toEqual(ban.data);
  });

  test('a bad stored customization falls back to the code definition and says why', () => {
    const { commands, ignored, refused } = effectiveCommandSet({
      catalogue,
      modulesOn: ALL_ON,
      settings: {
        ban: stored({ name: 'Punish Now', description: 'x'.repeat(150) }),
        kick: stored({ name: 'boot' }),
      },
    });

    expect(bodyOf(commands, 'ban')).toEqual(ban.data);
    expect(ignored.ban).toStartWith(
      "Discord would refuse the saved changes to /ban, so it is registered with Proton's " +
        'defaults until they are fixed: ',
    );
    expect(refused).toEqual(['ban']);
    expect(bodyOf(commands, 'kick').name).toBe('boot');
  });

  test('a refused customization is named even while its command is not registered', () => {
    const { refused } = effectiveCommandSet({
      catalogue,
      modulesOn: {},
      settings: { tag: stored({ description: 'x'.repeat(150) }) },
    });

    expect(refused).toEqual(['tag']);
  });

  test('a customization that fits only under the name it lost is refused as a whole', () => {
    const options: NonNullable<RESTPostAPIChatInputApplicationCommandsJSONBody['options']> = [];
    const data = { name: 'x'.repeat(32), description: 'd', options };
    while (commandSize(data) < 7900) {
      options.push({ type: T.String, name: `o${options.length}`, description: 'o'.repeat(50) });
    }
    const pad = `o${options.length}`;
    options.push({
      type: T.String,
      name: pad,
      description: 'p'.repeat(7990 - commandSize(data) - pad.length),
    });
    expect(commandSize(data)).toBe(7990);

    const heavy: CatalogueEntry = {
      key: data.name,
      kind: 'chat',
      moduleId: 'moderation',
      command: command(data),
      data,
      alwaysRegistered: false,
    };

    const { commands, ignored, refused } = effectiveCommandSet({
      catalogue: [...catalogue, heavy],
      modulesOn: ALL_ON,
      settings: { [heavy.key]: stored({ name: 'kick', description: 'D'.repeat(30) }) },
    });

    expect(bodyOf(commands, heavy.key)).toEqual(data);
    expect(ignored[heavy.key]).toContain('Discord allows 8000 characters per command');
    expect(refused).toEqual([heavy.key]);
  });

  test('a bad row frees its custom name instead of holding it against the others', () => {
    const { commands } = effectiveCommandSet({
      catalogue,
      modulesOn: ALL_ON,
      settings: {
        ban: stored({
          name: 'boot',
          description: '',
          optionDescriptions: { add: 'y'.repeat(101) },
        }),
        kick: stored({ name: 'boot', updatedAt: '2026-09-09T00:00:00Z' }),
      },
    });

    expect(bodyOf(commands, 'ban').name).toBe('ban');
    expect(bodyOf(commands, 'kick').name).toBe('boot');
  });

  test('names are resolved across every command, including ones that are not registered', () => {
    const { commands, ignored, refused } = effectiveCommandSet({
      catalogue,
      modulesOn: { help: true, moderation: false, tags: true },
      settings: { tag: stored({ name: 'kick', updatedAt: '2026-09-01T00:00:00Z' }) },
    });

    expect(bodyOf(commands, 'tag').name).toBe('tag');
    expect(ignored.tag).toBe('Proton now has its own /kick, so this command is back to /tag.');
    expect(refused).toEqual([]);
  });

  test('context menus are never renamed', () => {
    const { commands } = effectiveCommandSet({
      catalogue,
      modulesOn: ALL_ON,
      settings: { 'user:Report user': stored({ name: 'Flag user' }) },
    });

    expect(bodyOf(commands, 'user:Report user')).toEqual(menu('Report user', 'user').data);
  });

  test('never hands out the catalogue’s own objects, so a caller cannot corrupt the code', () => {
    const { commands } = effectiveCommandSet({ catalogue, modulesOn: ALL_ON, settings: {} });

    expect(bodyOf(commands, 'kick')).not.toBe(kick.data);
    bodyOf(commands, 'kick').name = 'mutated';
    expect(kick.data.name).toBe('kick');
  });
});

describe('effectiveCommandSet command ids', () => {
  const recorded = [
    { key: 'ban', id: '1260000000000000001', name: 'ban' },
    { key: 'kick', id: '1260000000000000002', name: 'boot' },
    { key: 'user:Report user', id: '1260000000000000003', name: 'Report user' },
  ];

  test('sends an id only for a command whose name changed since the last registration', () => {
    const { commands } = effectiveCommandSet({
      catalogue,
      modulesOn: ALL_ON,
      settings: { ban: stored({ name: 'punish', updatedAt: '2026-09-01T00:00:00Z' }) },
      recorded,
    });

    expect(bodyOf(commands, 'ban').id).toBe('1260000000000000001');
    expect(bodyOf(commands, 'kick').id).toBe('1260000000000000002');
    expect(bodyOf(commands, 'user:Report user').id).toBeUndefined();
    expect(bodyOf(commands, 'tag').id).toBeUndefined();
  });

  test('once Discord holds the new name, no id is sent', () => {
    const { commands } = effectiveCommandSet({
      catalogue,
      modulesOn: ALL_ON,
      settings: { kick: stored({ name: 'boot', updatedAt: '2026-09-01T00:00:00Z' }) },
      recorded,
    });

    expect(commands.every(({ body }) => body.id === undefined)).toBe(true);
  });
});

describe('effectiveCommandNames', () => {
  test('names every command in the catalogue, registered or not, by its code name by default', () => {
    expect(effectiveCommandNames({ catalogue, settings: {} })).toEqual({
      help: 'help',
      ban: 'ban',
      kick: 'kick',
      'user:Report user': 'Report user',
      tag: 'tag',
      'message:Quote': 'Quote',
    });
  });

  test('gives each command exactly the name effectiveCommandSet registers it under', () => {
    const settings = {
      ban: stored({ name: 'boot', updatedAt: '2026-09-02T00:00:00Z' }),
      kick: stored({ name: 'boot', updatedAt: '2026-09-01T00:00:00Z' }),
      tag: stored({ name: 'Bad Name' }),
      help: stored({ name: 'guide', enabled: false }),
      'user:Report user': stored({ name: 'Flag user' }),
    };
    const names = effectiveCommandNames({ catalogue, settings });
    const { commands } = effectiveCommandSet({
      catalogue,
      modulesOn: ALL_ON,
      settings: { ...settings, help: { ...settings.help, enabled: true } },
    });

    expect(names).toMatchObject({
      ban: 'ban',
      kick: 'boot',
      tag: 'tag',
      help: 'guide',
      'user:Report user': 'Report user',
    });
    for (const { key, body } of commands) expect(names[key]).toBe(body.name);
  });

  test('a module that is off still has its commands named', () => {
    expect(
      effectiveCommandNames({
        catalogue,
        settings: { kick: stored({ name: 'boot' }) },
      }).kick,
    ).toBe('boot');
  });
});

describe('fingerprint and hashes', () => {
  const base = effectiveCommandSet({ catalogue, modulesOn: ALL_ON, settings: {} }).commands;

  test('the fingerprint ignores ids, so a rename that landed does not look like a change', () => {
    const withIds = base.map((entry) => ({ ...entry, body: { ...entry.body, id: '1' } }));

    expect(commandSetFingerprint(withIds)).toBe(commandSetFingerprint(base));
  });

  test('the fingerprint ignores the order of commands and of object keys', () => {
    const reordered = [...base].reverse().map((entry) => ({
      ...entry,
      body: Object.fromEntries(Object.entries(entry.body).reverse()) as typeof entry.body,
    }));

    expect(commandSetFingerprint(reordered)).toBe(commandSetFingerprint(base));
  });

  test('the fingerprint keeps option order, which Discord shows', () => {
    const banEntry = base.find(({ key }) => key === 'ban') as EffectiveCommand;
    const body = banEntry.body as RESTPostAPIChatInputApplicationCommandsJSONBody;
    const swapped = base.map((entry) =>
      entry.key === 'ban'
        ? { ...entry, body: { ...body, options: [...(body.options ?? [])].reverse() } }
        : entry,
    );

    expect(commandSetFingerprint(swapped)).not.toBe(commandSetFingerprint(base));
  });

  test('the hash is a SHA-256 hex digest that moves with any registered change', async () => {
    const hash = await commandSetHash(base);
    const renamed = effectiveCommandSet({
      catalogue,
      modulesOn: ALL_ON,
      settings: { ban: stored({ name: 'punish' }) },
    }).commands;
    const smaller = effectiveCommandSet({
      catalogue,
      modulesOn: { ...ALL_ON, tags: false },
      settings: {},
    }).commands;

    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(await commandSetHash(base)).toBe(hash);
    expect(await commandSetHash(renamed)).not.toBe(hash);
    expect(await commandSetHash(smaller)).not.toBe(hash);
  });

  test('a reply preference alone never changes the hash, so it never re-registers', async () => {
    const preferred = effectiveCommandSet({
      catalogue,
      modulesOn: ALL_ON,
      settings: { ban: stored({ privateReply: false }), kick: stored({ privateReply: true }) },
    }).commands;

    expect(await commandSetHash(preferred)).toBe(await commandSetHash(base));
  });

  test('the hash of an empty set is the digest of an empty list', async () => {
    expect(await commandSetHash([])).toBe(
      '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945',
    );
  });

  test('definitionHash is stable across key order and moves with the definition', async () => {
    const reordered = Object.fromEntries(
      Object.entries(ban.data).reverse(),
    ) as RESTPostAPIChatInputApplicationCommandsJSONBody;

    expect(await definitionHash(ban.data)).toMatch(/^[0-9a-f]{64}$/);
    expect(await definitionHash(reordered)).toBe(await definitionHash(ban.data));
    expect(await definitionHash({ ...ban.data, description: 'Changed.' })).not.toBe(
      await definitionHash(ban.data),
    );
  });

  test('stableJson sorts keys at every depth and drops undefined', () => {
    expect(stableJson({ b: 1, a: { d: undefined, c: [{ z: 1, y: 2 }] } })).toBe(
      '{"a":{"c":[{"y":2,"z":1}]},"b":1}',
    );
  });
});
