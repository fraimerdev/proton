import { describe, expect, test } from 'bun:test';
import {
  type CommandUpdateBody,
  commandCatalogue,
  commandCatalogueViewSchema,
  commandSetHash,
  commandWorkerViewSchema,
  definitionHash,
  effectiveCommandSet,
  protonCommandsChangedSchema,
} from '@proton/core';
import { CommandSettingsError, type CommandSettingsService } from '../src/commands/service.ts';
import { commandScopeOf } from '../src/env.ts';
import {
  ADMIN,
  BULK_SUBCOMMANDS,
  type CommandHarness,
  commandHarness,
  GUILD,
  OTHER_GUILD,
  registration,
  states,
  testRegistry,
} from './command-fixtures.ts';

const registry = testRegistry();

async function hashOf(key: string): Promise<string> {
  const entry = commandCatalogue(registry).find((candidate) => candidate.key === key);
  if (!entry) throw new Error(`no ${key} in the test registry`);
  return definitionHash(entry.data);
}

async function body(
  key: string,
  overrides: Partial<CommandUpdateBody> = {},
): Promise<CommandUpdateBody> {
  return {
    name: null,
    description: null,
    optionDescriptions: {},
    privateReply: null,
    expectedUpdatedAt: null,
    definitionHash: await hashOf(key),
    actorId: ADMIN,
    source: 'dashboard',
    ...overrides,
  };
}

async function viewOf(service: CommandSettingsService, key: string) {
  const view = await service.catalogue(GUILD);
  const command = view.commands.find((candidate) => candidate.key === key);
  if (!command) throw new Error(`no ${key} in the catalogue`);
  return command;
}

async function expectedHash(h: CommandHarness): Promise<string> {
  const settings = await h.settings.list(GUILD);
  const modulesOn = Object.fromEntries(
    Object.entries(h.modules.current).map(([id, state]) => [id, state.on]),
  );

  return commandSetHash(
    effectiveCommandSet({ catalogue: commandCatalogue(h.registry), modulesOn, settings }).commands,
  );
}

describe('the catalogue', () => {
  test('lists every command and menu from the registry with its code defaults', async () => {
    const view = await commandHarness().service.catalogue(GUILD);

    expect(commandCatalogueViewSchema.parse(view)).toEqual(view);
    expect(view.commands.map((command) => command.key)).toEqual([
      'warn',
      'kick',
      'ban',
      'user:Report user',
      'help',
      'tag',
      'giveaway',
    ]);

    const ban = view.commands.find((command) => command.key === 'ban');
    expect(ban).toMatchObject({
      kind: 'chat',
      moduleId: 'moderation',
      moduleName: 'Moderation',
      name: 'ban',
      description: 'Ban or unban a member.',
      effectiveName: 'ban',
      ignored: null,
      settings: {
        enabled: true,
        name: null,
        description: null,
        optionDescriptions: {},
        privateReply: null,
        updatedAt: null,
      },
    });
    expect(ban?.fields.map((field) => field.path)).toEqual(['add', 'remove']);
    expect(ban?.fields[0]?.children.map((field) => field.path)).toEqual(['add.user']);
    expect(ban?.definitionHash).toBe(await hashOf('ban'));
  });

  test('a context menu has no description, no fields and no reply control', async () => {
    const menu = await viewOf(commandHarness().service, 'user:Report user');

    expect(menu).toMatchObject({
      kind: 'user',
      name: 'Report user',
      description: '',
      fields: [],
      fixedSize: 0,
      reply: null,
    });
  });

  test('a module is on only when its row and its own enabled field both are', async () => {
    const h = commandHarness({ states: states({ moderation: true, tags: false }) });
    const view = await h.service.catalogue(GUILD);

    expect(view.commands.find((command) => command.key === 'warn')?.moduleOn).toBe(true);
    expect(view.commands.find((command) => command.key === 'tag')?.moduleOn).toBe(false);
    expect(view.commands.find((command) => command.key === 'help')).toMatchObject({
      moduleOn: false,
      alwaysRegistered: true,
    });
  });

  test('the reply default follows the module config the guild saved', async () => {
    const h = commandHarness({
      states: states({ moderation: true }, { moderation: { enabled: true, publicReplies: true } }),
    });

    expect((await viewOf(h.service, 'warn')).reply).toEqual({
      supported: true,
      paths: [{ path: '', default: 'public', toggleable: true }],
      inheritsFrom: { label: 'Moderation → Reply publicly', moduleId: 'moderation' },
    });
    expect((await viewOf(h.service, 'ban')).reply?.paths).toEqual([
      { path: 'add', default: 'private', toggleable: true },
      { path: 'remove', default: 'private', toggleable: true },
    ]);
    expect((await viewOf(h.service, 'kick')).reply).toBeNull();
  });

  test('a reply default that throws on the saved config falls back to the module defaults', async () => {
    const h = commandHarness({ states: states({ moderation: true }, { moderation: null }) });

    expect((await viewOf(h.service, 'warn')).reply?.paths).toEqual([
      { path: '', default: 'private', toggleable: true },
    ]);
    expect(h.errors).toHaveLength(1);
    expect(h.errors[0]).toContain('/warn');
  });

  test('a renamed command shows its new name, and a losing rename says why', async () => {
    const h = commandHarness();
    h.settings.seed(GUILD, 'warn', { name: 'caution' });
    h.settings.seed(GUILD, 'tag', { name: 'kick' });

    const view = await h.service.catalogue(GUILD);
    const warn = view.commands.find((command) => command.key === 'warn');
    const tag = view.commands.find((command) => command.key === 'tag');

    expect(warn).toMatchObject({
      name: 'warn',
      effectiveName: 'caution',
      ignored: null,
      refused: false,
    });
    expect(tag?.effectiveName).toBe('tag');
    expect(tag?.ignored).toBe('Proton now has its own /kick, so this command is back to /tag.');
    expect(tag?.refused).toBe(false);
  });

  test('a customization Discord would refuse is flagged as refused as a whole', async () => {
    const h = commandHarness();
    h.settings.seed(GUILD, 'warn', { name: 'caution', description: 'd'.repeat(150) });

    const view = await h.service.catalogue(GUILD);
    const warn = view.commands.find((command) => command.key === 'warn');

    expect(commandCatalogueViewSchema.parse(view)).toEqual(view);
    expect(warn).toMatchObject({ effectiveName: 'warn', refused: true });
    expect(warn?.ignored).toStartWith('Discord would refuse the saved changes to /warn');
    expect(view.commands.filter((command) => command.refused).map(({ key }) => key)).toEqual([
      'warn',
    ]);
  });

  test('a switched-off command keeps its name and customization', async () => {
    const h = commandHarness();
    h.settings.seed(GUILD, 'warn', { enabled: false, name: 'caution', description: 'Caution.' });

    expect(await viewOf(h.service, 'warn')).toMatchObject({
      effectiveName: 'caution',
      settings: { enabled: false, name: 'caution', description: 'Caution.' },
    });
  });

  test('passes on the commands whose Integrations permissions were lost', async () => {
    const h = commandHarness();
    const lost = { commands: [{ key: 'ban', name: 'ban' }], at: '2026-09-22T08:00:00.000Z' };
    h.registrations.set(registration({ lostPermissions: lost }));

    expect((await h.service.catalogue(GUILD)).lostPermissions).toEqual(lost);
  });
});

describe('the sync state', () => {
  test('a guild Proton has never registered commands in is unsynced', async () => {
    const view = await commandHarness().service.catalogue(GUILD);

    expect(view.sync).toEqual({
      state: 'unsynced',
      checkedAt: null,
      syncedAt: null,
      failure: null,
    });
  });

  test('in test-guild mode every other guild belongs to another environment', async () => {
    const h = commandHarness({ scope: { scope: 'guild', testGuildId: OTHER_GUILD } });

    expect((await h.service.catalogue(GUILD)).sync.state).toBe('not-this-environment');
    expect((await h.service.catalogue(OTHER_GUILD)).sync.state).toBe('unsynced');
  });

  test('a record made in test-guild mode for another guild is not this environment', async () => {
    const h = commandHarness({ scope: { scope: 'guild', testGuildId: OTHER_GUILD } });
    h.registrations.set(registration({ scope: 'guild', definitionHash: await expectedHash(h) }));

    expect((await h.service.catalogue(GUILD)).sync.state).toBe('not-this-environment');
  });

  test('synced when the recorded hash is the one the worker would compute now', async () => {
    const h = commandHarness();
    h.settings.seed(GUILD, 'warn', { name: 'caution' });
    h.registrations.set(registration({ definitionHash: await expectedHash(h) }));

    expect((await h.service.catalogue(GUILD)).sync).toEqual({
      state: 'synced',
      checkedAt: '2026-09-22T09:00:00.000Z',
      syncedAt: '2026-09-22T09:00:00.000Z',
      failure: null,
    });
  });

  test('pending once a save moves the expected hash past the recorded one', async () => {
    const h = commandHarness({ bus: false });
    h.registrations.set(registration({ definitionHash: await expectedHash(h) }));

    await h.service.update(GUILD, 'warn', await body('warn', { name: 'caution' }));

    expect((await h.service.catalogue(GUILD)).sync.state).toBe('pending');
  });

  test('switching a module on is pending too: the module map is part of the hash', async () => {
    const h = commandHarness();
    h.registrations.set(registration({ definitionHash: await expectedHash(h) }));
    h.modules.current = states({ moderation: true, tags: true, giveaways: true });

    expect((await h.service.catalogue(GUILD)).sync.state).toBe('pending');
  });

  test('a reply preference alone leaves a synced guild synced', async () => {
    const h = commandHarness();
    h.registrations.set(registration({ definitionHash: await expectedHash(h) }));

    await h.service.update(GUILD, 'warn', await body('warn', { privateReply: false }));

    expect((await h.service.catalogue(GUILD)).sync.state).toBe('synced');
  });

  test('failed, with the readable copy and without the hash, when the current set failed', async () => {
    const h = commandHarness();
    const failure = {
      code: '50001',
      status: 403,
      message: "Proton can't manage commands in this server.",
      detail: 'Missing Access',
      at: '2026-09-22T09:30:00.000Z',
      retryAt: null,
    };
    h.registrations.set(registration({ failure: { ...failure, hash: await expectedHash(h) } }));

    expect((await h.service.catalogue(GUILD)).sync).toMatchObject({ state: 'failed', failure });
  });

  test('a failure for an older set is pending: the worker has not tried this one yet', async () => {
    const h = commandHarness();
    h.registrations.set(
      registration({
        failure: {
          code: '50035',
          status: 400,
          message: 'Discord refused the commands.',
          detail: 'Invalid Form Body',
          at: '2026-09-22T09:30:00.000Z',
          retryAt: null,
          hash: 'an-older-hash',
        },
      }),
    );

    expect((await h.service.catalogue(GUILD)).sync).toMatchObject({
      state: 'pending',
      failure: null,
    });
  });
});

describe('the worker view', () => {
  test('carries the stored settings and the same module map the catalogue hashes', async () => {
    const h = commandHarness({ states: states({ moderation: true }) });
    const warn = h.settings.seed(GUILD, 'warn', { name: 'caution' });

    const view = await h.service.workerView(GUILD);

    expect(commandWorkerViewSchema.parse(view)).toEqual(view);
    expect(view.settings).toEqual({ warn });
    expect(view.modulesOn).toEqual({
      moderation: true,
      help: false,
      tags: false,
      giveaways: false,
    });
  });
});

describe('saving a command', () => {
  test('stores the normalized change, audits it and announces it', async () => {
    const h = commandHarness();

    const result = await h.service.update(
      GUILD,
      'ban',
      await body('ban', {
        name: ' /Punish ',
        description: 'Remove someone for good.',
        optionDescriptions: { 'add.user': 'The member to remove.', 'remove.user': '' },
        ipHash: 'hash-of-ip',
      }),
    );

    const stored = (await h.settings.list(GUILD)).ban;
    expect(stored).toMatchObject({
      enabled: true,
      name: 'punish',
      description: 'Remove someone for good.',
      optionDescriptions: { 'add.user': 'The member to remove.' },
      privateReply: null,
    });

    expect(result).toMatchObject({
      ok: true,
      command: { key: 'ban', effectiveName: 'punish', settings: stored },
    });

    expect(h.settings.audits).toEqual([
      {
        id: expect.any(String),
        guildId: GUILD,
        actorId: ADMIN,
        source: 'dashboard',
        action: 'command.update',
        before: {
          key: 'ban',
          settings: {
            enabled: true,
            name: null,
            description: null,
            optionDescriptions: {},
            privateReply: null,
          },
        },
        after: {
          key: 'ban',
          settings: {
            enabled: true,
            name: 'punish',
            description: 'Remove someone for good.',
            optionDescriptions: { 'add.user': 'The member to remove.' },
            privateReply: null,
          },
        },
        ipHash: 'hash-of-ip',
      },
    ]);

    expect(h.bus.published).toHaveLength(1);
    const event = h.bus.published[0];
    expect(event).toMatchObject({
      id: `proton.commands_changed:${GUILD}:${h.settings.audits[0]?.id}`,
      type: 'proton.commands_changed',
      guildId: GUILD,
      occurredAt: Date.parse('2026-09-22T12:00:00.000Z'),
    });
    expect(protonCommandsChangedSchema.parse(event?.payload)).toEqual({
      auditId: h.settings.audits[0]?.id ?? '',
      guildId: GUILD,
      actorId: ADMIN,
      source: 'dashboard',
      key: 'ban',
      displayName: 'ban',
      newName: 'punish',
      changed: ['name', 'description', 'options'],
      enabledBefore: true,
      enabledAfter: true,
      registration: true,
    });
  });

  test('a value equal to the code default is stored as no override', async () => {
    const h = commandHarness();

    await h.service.update(
      GUILD,
      'warn',
      await body('warn', {
        name: 'warn',
        description: 'Warn a member.',
        optionDescriptions: { user: 'Who to warn.' },
      }),
    );

    expect((await h.settings.list(GUILD)).warn).toMatchObject({
      name: null,
      description: null,
      optionDescriptions: {},
    });
    expect(h.bus.published).toEqual([]);
  });

  test('an override kept for an option the code has since removed survives the save', async () => {
    const h = commandHarness();
    const seeded = h.settings.seed(GUILD, 'warn', {
      optionDescriptions: { 'gone.option': 'Still here.' },
    });

    await h.service.update(
      GUILD,
      'warn',
      await body('warn', { description: 'Caution.', expectedUpdatedAt: seeded.updatedAt }),
    );

    expect((await h.settings.list(GUILD)).warn?.optionDescriptions).toEqual({
      'gone.option': 'Still here.',
    });
  });

  test('reset clears the customization and keeps the switch', async () => {
    const h = commandHarness();
    const seeded = h.settings.seed(GUILD, 'warn', {
      enabled: false,
      name: 'caution',
      description: 'Caution.',
      optionDescriptions: { user: 'Who.', 'gone.option': 'Still here.' },
      privateReply: true,
    });

    const result = await h.service.update(
      GUILD,
      'warn',
      await body('warn', { expectedUpdatedAt: seeded.updatedAt }),
    );

    expect(result.ok).toBe(true);
    const warn = (await h.settings.list(GUILD)).warn;
    expect(warn).toMatchObject({
      enabled: false,
      name: null,
      description: null,
      privateReply: null,
    });
    expect(warn?.optionDescriptions).toEqual({});
  });

  test('reset sent with the default name in the field clears a saved name Proton is not using', async () => {
    const h = commandHarness();
    const seeded = h.settings.seed(GUILD, 'tag', {
      name: 'kick',
      optionDescriptions: { 'gone.option': 'Still here.' },
    });

    const result = await h.service.update(
      GUILD,
      'tag',
      await body('tag', { name: 'tag', expectedUpdatedAt: seeded.updatedAt }),
    );

    expect(result).toMatchObject({ ok: true, command: { effectiveName: 'tag', ignored: null } });
    const tag = (await h.settings.list(GUILD)).tag;
    expect(tag?.name).toBeNull();
    expect(tag?.optionDescriptions).toEqual({});
    expect(h.bus.published[0]?.payload).toMatchObject({ changed: ['name', 'options'] });
  });

  test('editing a switched-off command saves it without switching it on', async () => {
    const h = commandHarness();
    const seeded = h.settings.seed(GUILD, 'kick', { enabled: false });

    await h.service.update(
      GUILD,
      'kick',
      await body('kick', { name: 'boot', expectedUpdatedAt: seeded.updatedAt }),
    );

    expect((await h.settings.list(GUILD)).kick).toMatchObject({ enabled: false, name: 'boot' });
    expect(h.bus.published[0]?.payload).toMatchObject({
      changed: ['name'],
      enabledBefore: false,
      enabledAfter: false,
      registration: true,
    });
  });

  test('a reply preference alone is announced as needing no registration', async () => {
    const h = commandHarness();

    await h.service.update(GUILD, 'ban', await body('ban', { privateReply: false }));

    expect(h.bus.published[0]?.payload).toMatchObject({
      key: 'ban',
      displayName: 'ban',
      newName: null,
      changed: ['privateReply'],
      registration: false,
    });
  });

  test('a save that changes nothing is audited but not announced', async () => {
    const h = commandHarness();

    expect((await h.service.update(GUILD, 'warn', await body('warn'))).ok).toBe(true);
    expect(h.settings.audits).toHaveLength(1);
    expect(h.bus.published).toEqual([]);
  });

  test('a publish that fails still saves, and says so in the log', async () => {
    const h = commandHarness();
    h.bus.failing = true;

    const result = await h.service.update(GUILD, 'warn', await body('warn', { name: 'caution' }));

    expect(result.ok).toBe(true);
    expect((await h.settings.list(GUILD)).warn?.name).toBe('caution');
    expect(h.errors).toHaveLength(1);
    expect(h.errors[0]).toContain('/warn');
    expect(h.errors[0]).toContain(GUILD);
  });

  test('without a bus the save still succeeds', async () => {
    const h = commandHarness({ bus: false });

    expect(
      (await h.service.update(GUILD, 'warn', await body('warn', { name: 'caution' }))).ok,
    ).toBe(true);
    expect(h.bus.published).toEqual([]);
  });

  test('an unknown command is refused as unknown', async () => {
    const h = commandHarness();

    const refused = h.service.update(GUILD, 'nope', await body('warn'));

    await expect(refused).rejects.toBeInstanceOf(CommandSettingsError);
    await expect(refused).rejects.toMatchObject({ code: 'unknown_command' });
  });
});

describe('a saved name Proton is not using', () => {
  test('survives a save of the reply preference alone, which needs no registration', async () => {
    const h = commandHarness();
    const seeded = h.settings.seed(GUILD, 'tag', { name: 'kick' });
    const tag = await viewOf(h.service, 'tag');
    expect(tag.effectiveName).toBe('tag');

    const result = await h.service.update(
      GUILD,
      'tag',
      await body('tag', {
        name: tag.effectiveName,
        privateReply: true,
        expectedUpdatedAt: seeded.updatedAt,
      }),
    );

    expect(result).toMatchObject({
      ok: true,
      command: {
        effectiveName: 'tag',
        ignored: 'Proton now has its own /kick, so this command is back to /tag.',
      },
    });
    expect((await h.settings.list(GUILD)).tag).toMatchObject({ name: 'kick', privateReply: true });
    expect(h.settings.audits[0]?.after).toMatchObject({ settings: { name: 'kick' } });
    expect(h.bus.published).toHaveLength(1);
    expect(h.bus.published[0]?.payload).toMatchObject({
      key: 'tag',
      displayName: 'tag',
      newName: null,
      changed: ['privateReply'],
      registration: false,
    });
  });

  test('can be sent back as it is stored without being refused as taken', async () => {
    const h = commandHarness();
    const seeded = h.settings.seed(GUILD, 'tag', { name: 'kick' });

    const result = await h.service.update(
      GUILD,
      'tag',
      await body('tag', {
        name: 'kick',
        description: 'Post a tag.',
        expectedUpdatedAt: seeded.updatedAt,
      }),
    );

    expect(result.ok).toBe(true);
    expect((await h.settings.list(GUILD)).tag).toMatchObject({
      name: 'kick',
      description: 'Post a tag.',
    });
    expect(h.bus.published[0]?.payload).toMatchObject({ changed: ['description'] });
  });

  test('does not let the command claim a different taken name unchecked', async () => {
    const h = commandHarness();
    const seeded = h.settings.seed(GUILD, 'tag', { name: 'kick' });

    const result = await h.service.update(
      GUILD,
      'tag',
      await body('tag', { name: 'ban', expectedUpdatedAt: seeded.updatedAt }),
    );

    expect(result).toEqual({
      ok: false,
      issues: [{ path: 'name', message: 'Proton already has a /ban command. Pick another name.' }],
    });
  });

  test('is cleared when the name field is sent blank', async () => {
    const h = commandHarness();
    const seeded = h.settings.seed(GUILD, 'tag', { name: 'kick' });

    await h.service.update(
      GUILD,
      'tag',
      await body('tag', { name: '', privateReply: true, expectedUpdatedAt: seeded.updatedAt }),
    );

    expect((await h.settings.list(GUILD)).tag).toMatchObject({ name: null, privateReply: true });
    expect(h.bus.published[0]?.payload).toMatchObject({
      changed: ['name', 'privateReply'],
      registration: true,
    });
  });

  test('comes back into effect when the refused description it was saved with is fixed', async () => {
    const h = commandHarness();
    const seeded = h.settings.seed(GUILD, 'warn', {
      name: 'caution',
      description: 'd'.repeat(150),
    });
    const warn = await viewOf(h.service, 'warn');
    expect(warn).toMatchObject({ effectiveName: 'warn', refused: true });

    const result = await h.service.update(
      GUILD,
      'warn',
      await body('warn', {
        name: warn.effectiveName,
        description: 'Give a member a caution.',
        expectedUpdatedAt: seeded.updatedAt,
      }),
    );

    expect(result).toMatchObject({
      ok: true,
      command: { effectiveName: 'caution', ignored: null, refused: false },
    });
    expect((await h.settings.list(GUILD)).warn).toMatchObject({
      name: 'caution',
      description: 'Give a member a caution.',
    });
    expect(h.bus.published[0]?.payload).toMatchObject({
      displayName: 'warn',
      newName: 'caution',
      changed: ['description'],
      registration: true,
    });
  });
});

describe('what a save refuses', () => {
  async function issuesOf(h: CommandHarness, key: string, overrides: Partial<CommandUpdateBody>) {
    const result = await h.service.update(GUILD, key, await body(key, overrides));
    if (result.ok) throw new Error('the save went through');

    expect(h.settings.audits).toEqual([]);
    expect(h.bus.published).toEqual([]);
    return result.issues;
  }

  test('a name Discord would refuse, naming the rule it breaks', async () => {
    expect(await issuesOf(commandHarness(), 'warn', { name: 'give warning' })).toEqual([
      {
        path: 'name',
        message: 'Command names can only use letters, numbers, - and _, with no spaces.',
      },
    ]);
    expect(await issuesOf(commandHarness(), 'warn', { name: 'w'.repeat(33) })).toEqual([
      { path: 'name', message: 'Command names can be at most 32 characters (this one is 33).' },
    ]);
  });

  test('a description over the limit, with its length', async () => {
    expect(await issuesOf(commandHarness(), 'warn', { description: 'd'.repeat(101) })).toEqual([
      {
        path: 'description',
        message: 'Descriptions can be at most 100 characters (this one is 101).',
      },
    ]);
  });

  test('an option description over the limit, at its own path', async () => {
    expect(
      await issuesOf(commandHarness(), 'ban', {
        optionDescriptions: { 'remove.user': 'o'.repeat(120) },
      }),
    ).toEqual([
      {
        path: 'options.remove.user',
        message: 'Descriptions can be at most 100 characters (this one is 120).',
      },
    ]);
  });

  test('a command whose descriptions together pass Discord’s 8000 characters', async () => {
    const optionDescriptions: Record<string, string> = {};
    for (let index = 0; index < BULK_SUBCOMMANDS; index++) {
      optionDescriptions[`step${index}`] = 's'.repeat(100);
      for (const option of ['prize', 'note', 'host']) {
        optionDescriptions[`step${index}.${option}`] = 'o'.repeat(100);
      }
    }

    const issues = await issuesOf(commandHarness(), 'giveaway', {
      description: 'g'.repeat(100),
      optionDescriptions,
    });

    expect(issues).toHaveLength(1);
    expect(issues[0]?.path).toBe('size');
    expect(issues[0]?.message).toContain('Discord allows 8000 characters per command');
  });

  test('a name Proton already uses for another command', async () => {
    expect(await issuesOf(commandHarness(), 'warn', { name: 'kick' })).toEqual([
      { path: 'name', message: 'Proton already has a /kick command. Pick another name.' },
    ]);
  });

  test('a name another command was renamed to, naming that command', async () => {
    const h = commandHarness();
    h.settings.seed(GUILD, 'kick', { name: 'boot' });

    expect(await issuesOf(h, 'warn', { name: 'boot' })).toEqual([
      { path: 'name', message: '/kick is already called “boot”. Rename /kick first.' },
    ]);
  });

  test('a clash between two other commands does not block this one', async () => {
    const h = commandHarness();
    h.settings.seed(GUILD, 'tag', { name: 'kick' });

    expect(
      (await h.service.update(GUILD, 'warn', await body('warn', { name: 'caution' }))).ok,
    ).toBe(true);
  });

  test('a reply preference on a command whose reply cannot be switched', async () => {
    expect(await issuesOf(commandHarness(), 'kick', { privateReply: true })).toEqual([
      {
        path: 'privateReply',
        message:
          "/kick always responds the same way, so whether it responds privately can't be changed.",
      },
    ]);
  });

  test('a stored preference that is resent unchanged does not block the save', async () => {
    const h = commandHarness();
    const seeded = h.settings.seed(GUILD, 'kick', { privateReply: true });

    const result = await h.service.update(
      GUILD,
      'kick',
      await body('kick', {
        description: 'Remove a member.',
        privateReply: true,
        expectedUpdatedAt: seeded.updatedAt,
      }),
    );

    expect(result.ok).toBe(true);
    expect((await h.settings.list(GUILD)).kick?.privateReply).toBe(true);
    expect(h.bus.published[0]?.payload).toMatchObject({ changed: ['description'] });
  });

  test('a stored preference changed on a command whose reply cannot be switched', async () => {
    const h = commandHarness();
    const seeded = h.settings.seed(GUILD, 'kick', { privateReply: true });

    const result = await h.service.update(
      GUILD,
      'kick',
      await body('kick', { privateReply: false, expectedUpdatedAt: seeded.updatedAt }),
    );

    expect(result).toEqual({
      ok: false,
      issues: [
        {
          path: 'privateReply',
          message:
            "/kick always responds the same way, so whether it responds privately can't be changed.",
        },
      ],
    });
    expect((await h.settings.list(GUILD)).kick?.privateReply).toBe(true);
  });

  test('any customization of a context menu', async () => {
    const issues = await issuesOf(commandHarness(), 'user:Report user', {
      name: 'report',
      privateReply: true,
    });

    expect(issues.map((issue) => issue.path)).toEqual(['name', 'privateReply']);
    expect(issues[0]?.message).toContain('“Report user” is an Apps menu entry');
  });

  test('a context menu saved with nothing customized goes through', async () => {
    const h = commandHarness();

    expect(
      (await h.service.update(GUILD, 'user:Report user', await body('user:Report user'))).ok,
    ).toBe(true);
  });
});

describe('a save made against a stale page', () => {
  test('is refused when the code definition changed since the page loaded', async () => {
    const h = commandHarness();

    const refused = h.service.update(GUILD, 'warn', await body('warn', { definitionHash: 'old' }));

    await expect(refused).rejects.toMatchObject({ code: 'command_changed' });
    expect(h.settings.audits).toEqual([]);
  });

  test('is refused when someone else saved the command in between', async () => {
    const h = commandHarness();
    const first = h.settings.seed(GUILD, 'warn', { name: 'caution' });
    h.settings.seed(GUILD, 'warn', { name: 'alert' });

    const refused = h.service.update(
      GUILD,
      'warn',
      await body('warn', { name: 'mine', expectedUpdatedAt: first.updatedAt }),
    );

    await expect(refused).rejects.toMatchObject({ code: 'command_changed' });
    expect((await h.settings.list(GUILD)).warn?.name).toBe('alert');
    expect(h.bus.published).toEqual([]);
  });

  test('is refused when the page saw no saved row and one exists now', async () => {
    const h = commandHarness();
    h.settings.seed(GUILD, 'warn', { name: 'alert' });

    await expect(
      h.service.update(GUILD, 'warn', await body('warn', { expectedUpdatedAt: null })),
    ).rejects.toMatchObject({ code: 'command_changed' });
  });

  test('goes through when the page saw the stored time', async () => {
    const h = commandHarness();
    const seeded = h.settings.seed(GUILD, 'warn', { name: 'alert' });

    const result = await h.service.update(
      GUILD,
      'warn',
      await body('warn', { name: 'caution', expectedUpdatedAt: seeded.updatedAt }),
    );

    expect(result.ok).toBe(true);
  });
});

describe('the command switch', () => {
  test('switches the command off without touching its customization', async () => {
    const h = commandHarness();
    h.settings.seed(GUILD, 'warn', { name: 'caution', privateReply: true });

    const { command } = await h.service.setEnabled(GUILD, 'warn', {
      enabled: false,
      actorId: ADMIN,
      source: 'dashboard',
    });

    expect(command.settings).toMatchObject({
      enabled: false,
      name: 'caution',
      privateReply: true,
    });
    expect(
      h.settings.audits.map(({ action, before, after }) => ({ action, before, after })),
    ).toEqual([
      {
        action: 'command.enabled',
        before: { key: 'warn', enabled: true },
        after: { key: 'warn', enabled: false },
      },
    ]);
    expect(h.bus.published[0]?.payload).toMatchObject({
      key: 'warn',
      displayName: 'caution',
      newName: null,
      changed: ['enabled'],
      enabledBefore: true,
      enabledAfter: false,
      registration: true,
    });
  });

  test('a switch to where it already is is not announced', async () => {
    const h = commandHarness();

    await h.service.setEnabled(GUILD, 'warn', {
      enabled: true,
      actorId: ADMIN,
      source: 'dashboard',
    });

    expect(h.bus.published).toEqual([]);
  });

  test('a context menu can be switched off by its key', async () => {
    const h = commandHarness();

    const { command } = await h.service.setEnabled(GUILD, 'user:Report user', {
      enabled: false,
      actorId: ADMIN,
      source: 'dashboard',
    });

    expect(command).toMatchObject({ key: 'user:Report user', settings: { enabled: false } });
  });

  test('an unknown command is refused', async () => {
    await expect(
      commandHarness().service.setEnabled(GUILD, 'nope', {
        enabled: false,
        actorId: ADMIN,
        source: 'dashboard',
      }),
    ).rejects.toMatchObject({ code: 'unknown_command' });
  });
});

describe('dismissing the lost-permissions banner', () => {
  test('clears the finding and audits who dismissed it', async () => {
    const h = commandHarness();
    const lost = { commands: [{ key: 'ban', name: 'ban' }], at: '2026-09-22T08:00:00.000Z' };
    h.registrations.set(registration({ lostPermissions: lost }));

    expect(
      await h.service.ackLostPermissions(GUILD, {
        actorId: ADMIN,
        source: 'dashboard',
        ipHash: 'hash',
      }),
    ).toEqual({ ok: true });

    expect((await h.service.catalogue(GUILD)).lostPermissions).toBeNull();
    expect(h.registrations.audits).toEqual([
      {
        id: expect.any(String),
        guildId: GUILD,
        actorId: ADMIN,
        source: 'dashboard',
        action: 'command.permissions_ack',
        before: { lostPermissions: lost },
        after: { lostPermissions: null },
        ipHash: 'hash',
      },
    ]);
  });

  test('with nothing to dismiss it is still ok and audits nothing', async () => {
    const h = commandHarness();

    expect(
      await h.service.ackLostPermissions(GUILD, { actorId: ADMIN, source: 'dashboard' }),
    ).toEqual({ ok: true });
    expect(h.registrations.audits).toEqual([]);
  });
});

describe('the registration scope the api reports against', () => {
  test('defaults to the test guild, as the worker does', () => {
    expect(
      commandScopeOf({ COMMAND_REGISTRATION_SCOPE: 'guild', DISCORD_TEST_GUILD_ID: GUILD }),
    ).toEqual({ scope: 'guild', testGuildId: GUILD, legacy: false });
  });

  test('reads the legacy global scope as every guild', () => {
    expect(
      commandScopeOf({ COMMAND_REGISTRATION_SCOPE: 'global', DISCORD_TEST_GUILD_ID: undefined }),
    ).toEqual({ scope: 'every-guild', testGuildId: null, legacy: true });
  });

  test('an empty test guild id is no test guild', () => {
    expect(
      commandScopeOf({ COMMAND_REGISTRATION_SCOPE: 'every-guild', DISCORD_TEST_GUILD_ID: '' }),
    ).toEqual({ scope: 'every-guild', testGuildId: null, legacy: false });
  });
});
