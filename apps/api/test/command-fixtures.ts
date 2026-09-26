import {
  type CommandDefinition,
  type CommandSettings,
  type CommandSettingsView,
  type ContextMenuDefinition,
  commandSettingsSchema,
  type EventBus,
  type LostCommandPermissions,
  type ModuleManifest,
  ModuleRegistry,
  OptionType,
  type ProtonEvent,
} from '@proton/core';
import type {
  CommandRegistrationRecord,
  CommandSettingsDecision,
  CommandSettingsWritten,
  GuildCommandSettings,
  LostPermissionsAudit,
  NewAuditTrailEntry,
} from '@proton/db';
import { z } from 'zod';
import { type CommandScope, CommandSettingsService } from '../src/commands/service.ts';
import type { ModuleState } from '../src/modules/service.ts';

export const GUILD = '900000000000000001';
export const OTHER_GUILD = '900000000000000002';
export const ADMIN = '100000000000000001';

type Option = NonNullable<CommandDefinition['data']['options']>[number];

export function userOption(name: string, description: string, required = false): Option {
  return { type: OptionType.User, name, description, required };
}

export function stringOption(name: string, description: string, required = false): Option {
  return { type: OptionType.String, name, description, required };
}

export function subcommand(name: string, description: string, options: Option[]): Option {
  return { type: OptionType.Subcommand, name, description, options } as Option;
}

export function command(
  name: string,
  description: string,
  options: Option[] = [],
  extra: Partial<CommandDefinition> = {},
): CommandDefinition {
  return {
    name,
    description,
    data: { name, description, ...(options.length > 0 ? { options } : {}) },
    handler: async () => undefined,
    ...extra,
  };
}

function manifest(input: {
  id: string;
  name: string;
  configSchema?: z.ZodObject<z.ZodRawShape>;
  defaultConfig?: Record<string, unknown>;
  commands?: CommandDefinition[];
  contextMenus?: ContextMenuDefinition[];
}): ModuleManifest {
  return {
    id: input.id,
    name: input.name,
    category: 'utility',
    configSchema: input.configSchema ?? z.object({ enabled: z.boolean().default(true) }),
    defaultConfig: input.defaultConfig ?? { enabled: true },
    schemaVersion: 1,
    requiredIntents: [],
    requiredPermissions: [],
    commands: input.commands ?? [],
    contextMenus: input.contextMenus ?? [],
  } as unknown as ModuleManifest;
}

export const moderationConfigSchema = z.object({
  enabled: z.boolean().default(true),
  publicReplies: z.boolean().default(false),
});

export const tagsConfigSchema = z.object({
  enabled: z.boolean().default(true),
  ephemeral: z.boolean().default(false),
});

const REPORT_USER: ContextMenuDefinition = {
  name: 'Report user',
  type: 'user',
  description: 'Report a member to the moderators.',
  data: { name: 'Report user', type: 2 },
  handler: async () => undefined,
};

export const BULK_SUBCOMMANDS = 20;

function bulkCommand(): CommandDefinition {
  return command(
    'giveaway',
    'Run giveaways.',
    Array.from({ length: BULK_SUBCOMMANDS }, (_, index) =>
      subcommand(`step${index}`, `Step ${index}.`, [
        stringOption('prize', 'The prize.'),
        stringOption('note', 'A note.'),
        userOption('host', 'Who hosts it.'),
      ]),
    ),
  );
}

export function testRegistry(): ModuleRegistry {
  const registry = new ModuleRegistry();

  registry.register(
    manifest({
      id: 'moderation',
      name: 'Moderation',
      configSchema: moderationConfigSchema,
      defaultConfig: { enabled: true, publicReplies: false },
      commands: [
        command(
          'warn',
          'Warn a member.',
          [userOption('user', 'Who to warn.', true), stringOption('reason', 'Why.')],
          {
            reply: {
              default: (config: { publicReplies: boolean }) =>
                config.publicReplies ? 'public' : 'private',
              toggleable: [''],
              inheritsFrom: { label: 'Moderation → Reply publicly', moduleId: 'moderation' },
            },
          },
        ),
        command('kick', 'Kick a member.', [userOption('user', 'Who to kick.', true)]),
        command(
          'ban',
          'Ban or unban a member.',
          [
            subcommand('add', 'Ban a member.', [userOption('user', 'Who to ban.', true)]),
            subcommand('remove', 'Unban a member.', [userOption('user', 'Who to unban.', true)]),
          ],
          { reply: { default: 'private', toggleable: ['add', 'remove'] } },
        ),
      ],
      contextMenus: [REPORT_USER],
    }),
  );

  registry.register(
    manifest({
      id: 'help',
      name: 'Help',
      commands: [
        command('help', 'Find your way around Proton.', [], {
          alwaysRegistered: true,
          reply: { default: 'public', toggleable: [''] },
        }),
      ],
    }),
  );

  registry.register(
    manifest({
      id: 'tags',
      name: 'Tags',
      configSchema: tagsConfigSchema,
      defaultConfig: { enabled: true, ephemeral: false },
      commands: [
        command('tag', 'Post a saved tag.', [stringOption('name', 'Which tag.', true)], {
          reply: {
            default: (config: { ephemeral: boolean }) => (config.ephemeral ? 'private' : 'public'),
            toggleable: [''],
          },
        }),
      ],
    }),
  );

  registry.register(manifest({ id: 'giveaways', name: 'Giveaways', commands: [bulkCommand()] }));

  return registry;
}

export function states(
  on: Partial<Record<string, boolean>> = {},
  configs: Partial<Record<string, unknown>> = {},
): Record<string, ModuleState> {
  const defaults: Record<string, unknown> = {
    moderation: { enabled: true, publicReplies: false },
    help: { enabled: true },
    tags: { enabled: true, ephemeral: false },
    giveaways: { enabled: true },
  };

  return Object.fromEntries(
    Object.keys(defaults).map((id) => [
      id,
      { on: on[id] ?? false, config: id in configs ? configs[id] : defaults[id] },
    ]),
  );
}

export class MemoryCommandSettingsStore {
  readonly guilds = new Map<string, Map<string, CommandSettingsView>>();
  readonly audits: NewAuditTrailEntry[] = [];
  #clock = Date.parse('2026-09-22T10:00:00.000Z');

  seed(guildId: string, key: string, settings: Partial<CommandSettings>): CommandSettingsView {
    this.#clock += 1000;
    const view = {
      ...commandSettingsSchema.parse(settings),
      updatedAt: new Date(this.#clock).toISOString(),
    };
    this.#guild(guildId).set(key, view);
    return view;
  }

  #guild(guildId: string): Map<string, CommandSettingsView> {
    const held = this.guilds.get(guildId);
    if (held) return held;

    const created = new Map<string, CommandSettingsView>();
    this.guilds.set(guildId, created);
    return created;
  }

  async list(guildId: string): Promise<GuildCommandSettings> {
    return Object.fromEntries(
      [...this.#guild(guildId).entries()].map(([key, view]) => [key, structuredClone(view)]),
    );
  }

  async write(
    guildId: string,
    key: string,
    decide: CommandSettingsDecision,
  ): Promise<CommandSettingsWritten | null> {
    const current = await this.list(guildId);
    const decided = await decide(current);
    if (decided === null) return null;

    this.#clock += 1000;
    const settings = {
      ...commandSettingsSchema.parse(decided.next),
      updatedAt: new Date(this.#clock).toISOString(),
    };

    this.#guild(guildId).set(key, settings);
    this.audits.push({ ...decided.audit, guildId });

    return { settings, guild: { ...current, [key]: settings } };
  }
}

export class MemoryRegistrationStore {
  readonly records = new Map<string, CommandRegistrationRecord>();
  readonly audits: NewAuditTrailEntry[] = [];

  set(record: CommandRegistrationRecord): void {
    this.records.set(record.guildId, record);
  }

  async get(guildId: string): Promise<CommandRegistrationRecord | null> {
    return this.records.get(guildId) ?? null;
  }

  async ackLostPermissions(
    guildId: string,
    audit?: LostPermissionsAudit,
  ): Promise<LostCommandPermissions | null> {
    const record = this.records.get(guildId);
    const acked = record?.lostPermissions ?? null;
    if (!record || acked === null) return null;

    if (audit) this.audits.push({ ...audit(acked), guildId });
    this.records.set(guildId, { ...record, lostPermissions: null });
    return acked;
  }
}

export function registration(
  overrides: Partial<CommandRegistrationRecord> = {},
): CommandRegistrationRecord {
  return {
    guildId: GUILD,
    scope: 'every-guild',
    definitionHash: null,
    commands: [],
    idHistory: {},
    checkedAt: '2026-09-22T09:00:00.000Z',
    syncedAt: '2026-09-22T09:00:00.000Z',
    failure: null,
    permissionsCheckedAt: null,
    lostPermissions: null,
    ...overrides,
  };
}

export class RecordingBus implements EventBus {
  readonly published: ProtonEvent[] = [];
  failing = false;

  async publish(event: ProtonEvent): Promise<void> {
    if (this.failing) throw new Error('redis is down');
    this.published.push(event);
  }

  subscribe(): never {
    throw new Error('the api never subscribes');
  }
}

export interface CommandHarness {
  service: CommandSettingsService;
  registry: ModuleRegistry;
  settings: MemoryCommandSettingsStore;
  registrations: MemoryRegistrationStore;
  bus: RecordingBus;
  errors: string[];
  modules: { current: Record<string, ModuleState> };
}

export function commandHarness(
  options: { scope?: CommandScope; states?: Record<string, ModuleState>; bus?: boolean } = {},
): CommandHarness {
  const registry = testRegistry();
  const settings = new MemoryCommandSettingsStore();
  const registrations = new MemoryRegistrationStore();
  const bus = new RecordingBus();
  const errors: string[] = [];
  const modules = { current: options.states ?? states({ moderation: true, tags: true }) };

  const service = new CommandSettingsService({
    registry,
    settings,
    registrations,
    modules: { moduleStates: async () => modules.current },
    scope: options.scope ?? { scope: 'every-guild', testGuildId: null },
    ...(options.bus === false ? {} : { bus }),
    logger: { error: (message: string) => errors.push(message) },
    now: () => Date.parse('2026-09-22T12:00:00.000Z'),
  });

  return { service, registry, settings, registrations, bus, errors, modules };
}
