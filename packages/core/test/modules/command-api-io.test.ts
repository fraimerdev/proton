import { describe, expect, test } from 'bun:test';
import { ApplicationCommandOptionType as T } from 'discord-api-types/v10';
import { commandFields } from '../../src/commands/fields.ts';
import {
  type CommandCatalogueView,
  type CommandSettingsView,
  type CommandUpdateResult,
  type CommandView,
  commandCatalogueViewSchema,
  commandEnabledBodySchema,
  commandSettingsViewSchema,
  commandUpdateBodySchema,
  commandUpdateResultSchema,
  commandWorkerViewSchema,
} from '../../src/modules/api-io.ts';

const settings: CommandSettingsView = {
  enabled: true,
  name: 'punish',
  description: null,
  optionDescriptions: { 'add.user': 'The member.' },
  privateReply: null,
  updatedAt: '2026-09-21T10:00:00.000Z',
};

const view: CommandView = {
  key: 'ban',
  kind: 'chat',
  moduleId: 'moderation',
  moduleName: 'Moderation',
  moduleOn: true,
  alwaysRegistered: false,
  name: 'ban',
  description: 'Ban a member.',
  fields: commandFields({
    name: 'ban',
    description: 'Ban a member.',
    options: [
      {
        type: T.Subcommand,
        name: 'add',
        description: 'Ban someone.',
        options: [{ type: T.User, name: 'user', description: 'Who.', required: true }],
      },
    ],
  }),
  fixedSize: 10,
  definitionHash: 'a'.repeat(64),
  settings,
  effectiveName: 'punish',
  ignored: null,
  refused: false,
  reply: {
    supported: true,
    paths: [{ path: 'add', default: 'private', toggleable: true }],
    inheritsFrom: { label: 'Moderation → Reply publicly', moduleId: 'moderation' },
  },
};

describe('command api shapes', () => {
  test('a settings row without a save time reads as never saved', () => {
    const { updatedAt: _updatedAt, ...row } = settings;

    expect(commandSettingsViewSchema.parse(row).updatedAt).toBeNull();
    expect(commandSettingsViewSchema.parse({}).enabled).toBe(true);
  });

  test('the catalogue view round-trips a command, its sync state and lost permissions', () => {
    const catalogue: CommandCatalogueView = {
      commands: [view],
      sync: {
        state: 'failed',
        checkedAt: '2026-09-21T10:00:00.000Z',
        syncedAt: null,
        failure: {
          code: '50001',
          status: 403,
          message: "Proton can't manage commands in this server.",
          detail: 'Missing Access',
          at: '2026-09-21T10:00:00.000Z',
          retryAt: null,
        },
      },
      lostPermissions: { commands: [{ key: 'ban', name: 'ban' }], at: '2026-09-21T09:00:00.000Z' },
    };

    expect(commandCatalogueViewSchema.parse(catalogue)).toEqual(catalogue);
  });

  test.each(['synced', 'pending', 'unsynced', 'not-this-environment'])(
    'accepts the %s sync state',
    (state) => {
      expect(
        commandCatalogueViewSchema.safeParse({
          commands: [],
          sync: { state, checkedAt: null, syncedAt: null, failure: null },
          lostPermissions: null,
        }).success,
      ).toBe(true);
    },
  );

  test('refuses a sync state nobody defined', () => {
    expect(
      commandCatalogueViewSchema.safeParse({
        commands: [],
        sync: { state: 'maybe', checkedAt: null, syncedAt: null, failure: null },
        lostPermissions: null,
      }).success,
    ).toBe(false);
  });

  test('an update names who made it and defaults its source to the dashboard', () => {
    const body = commandUpdateBodySchema.parse({
      name: 'punish',
      description: null,
      optionDescriptions: {},
      privateReply: true,
      expectedUpdatedAt: null,
      definitionHash: 'a'.repeat(64),
      actorId: '100000000000000001',
    });

    expect(body.source).toBe('dashboard');
    expect(commandUpdateBodySchema.safeParse({ ...body, actorId: '' }).success).toBe(false);
    expect(commandUpdateBodySchema.safeParse({ ...body, definitionHash: '' }).success).toBe(false);
  });

  test('an update cannot switch a command, and the switch has its own body', () => {
    const parsed = commandUpdateBodySchema.parse({
      name: null,
      description: null,
      optionDescriptions: {},
      privateReply: null,
      expectedUpdatedAt: '2026-09-21T10:00:00.000Z',
      definitionHash: 'b'.repeat(64),
      actorId: '100000000000000001',
      enabled: false,
    });

    expect('enabled' in parsed).toBe(false);
    expect(
      commandEnabledBodySchema.parse({ enabled: false, actorId: '100000000000000001' }),
    ).toEqual({ enabled: false, actorId: '100000000000000001', source: 'dashboard' });
  });

  test('a refused save keeps its issues across the boundary, a saved one keeps its command', () => {
    const refused: CommandUpdateResult = {
      ok: false,
      issues: [{ path: 'name', message: 'Command names must be lowercase.' }],
    };

    expect(commandUpdateResultSchema.parse(refused)).toEqual(refused);
    expect(commandUpdateResultSchema.parse({ ok: true, command: view })).toEqual({
      ok: true,
      command: view,
    });
    expect(commandUpdateResultSchema.safeParse({ ok: true, issues: [] }).success).toBe(false);
  });

  test('a command view from before the refused flag reads as not refused', () => {
    const { refused: _refused, ...older } = view;
    const parsed = commandCatalogueViewSchema.parse({
      commands: [older],
      sync: { state: 'synced', checkedAt: null, syncedAt: null, failure: null },
      lostPermissions: null,
    });

    expect(parsed.commands[0]?.refused).toBe(false);
    expect(
      commandUpdateResultSchema.parse({ ok: true, command: { ...view, refused: true } }),
    ).toEqual({ ok: true, command: { ...view, refused: true } });
  });

  test('the worker view takes rows as jsonb returns them', () => {
    const parsed = commandWorkerViewSchema.parse({
      settings: { ban: { name: 'punish' }, kick: { enabled: false } },
      modulesOn: { moderation: true, tags: false },
    });

    expect(parsed.settings.ban).toEqual({
      enabled: true,
      name: 'punish',
      description: null,
      optionDescriptions: {},
      privateReply: null,
      updatedAt: null,
    });
    expect(parsed.settings.kick?.enabled).toBe(false);
  });
});
