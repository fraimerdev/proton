import { describe, expect, test } from 'bun:test';
import {
  type ActionExecutor,
  type ActionRequest,
  type ActionResult,
  type CommandWorkerView,
  commandCatalogue,
  type EventBus,
  type ModuleManifest,
  type ModuleRegistry,
  type ProtonEvent,
} from '@proton/core';
import type { CommandRegistrationRecord } from '@proton/db';
import { dispatch, type GuildCommandDispatchName } from '@proton/fixtures';
import { normalise } from '@proton/gateway/normaliser';
import { permissionsConfigSchema, permissionsModule } from '@proton/module-permissions';
import { z } from 'zod';
import {
  CommandResolver,
  type CommandResolverPort,
  UPDATING_REFUSAL,
} from '../src/command-resolver.ts';
import { CommandRecordCache } from '../src/command-sync.ts';
import { ModuleListenerRuntime } from '../src/listener-runtime.ts';
import { type ConfigProvider, type ModuleConfigSnapshot, ModuleRuntime } from '../src/runtime.ts';
import {
  collectingLogger,
  commandRegistry,
  emptySeen,
  MemoryRegistrations,
  type Seen,
  TEST_GUILD,
  viewOf,
} from './command-fakes.ts';

const DASHBOARD = 'https://proton.example';
const BAN_ID = '1260000000000000001';
const ROLE = '700000000000000009';

class RecordingExecutor implements ActionExecutor {
  readonly requests: ActionRequest[] = [];

  async execute(request: ActionRequest): Promise<ActionResult> {
    this.requests.push(request);
    return { status: 'executed' };
  }
}

const bus: EventBus = {
  publish: async () => undefined,
  subscribe: () => ({ group: 'x', close: async () => undefined }),
};

function record(overrides: Partial<CommandRegistrationRecord> = {}): CommandRegistrationRecord {
  return {
    guildId: TEST_GUILD,
    scope: 'guild',
    definitionHash: 'h',
    commands: [{ key: 'ban', id: BAN_ID, name: 'punish', kind: 'chat' }],
    idHistory: { [BAN_ID]: 'ban' },
    checkedAt: '2026-09-21T00:00:00.000Z',
    syncedAt: '2026-09-21T00:00:00.000Z',
    failure: null,
    permissionsCheckedAt: null,
    lostPermissions: null,
    ...overrides,
  };
}

function realResolver(registry: ModuleRegistry, stored: CommandRegistrationRecord | null) {
  const store = new MemoryRegistrations();
  if (stored) store.records.set(TEST_GUILD, stored);
  const reconciled: string[] = [];
  const resolver = new CommandResolver({
    catalogue: commandCatalogue(registry),
    records: new CommandRecordCache(store),
    reconcile: (guildId) => reconciled.push(guildId),
    logger: collectingLogger().logger,
  });
  return { resolver, reconciled };
}

function guildEvent(
  name: GuildCommandDispatchName,
  edit: (data: Record<string, unknown>) => void = () => undefined,
): ProtonEvent {
  const event = normalise(dispatch(name))[0];
  if (!event) throw new Error(`${name} did not normalise`);
  edit((event.payload as { data: Record<string, unknown> }).data);
  return event;
}

const punish = (subcommand = 'add') =>
  guildEvent('interactionCreateGuildCommand', (data) => {
    data.name = 'punish';
    if (subcommand !== 'add') {
      data.options = [
        {
          name: 'remove',
          type: 1,
          options: [{ name: 'user_id', type: 3, value: '100000000000000003' }],
        },
      ];
    }
  });

interface Options {
  seen?: Seen;
  reply?: { default: 'private' | 'public'; toggleable: string[] };
  snapshot?: (moduleId: string) => ModuleConfigSnapshot | Promise<ModuleConfigSnapshot>;
  view?: () => Promise<CommandWorkerView>;
  stored?: CommandRegistrationRecord | null;
  resolver?: CommandResolverPort;
  withPermissions?: boolean;
}

function build(options: Options = {}) {
  const seen = options.seen ?? emptySeen();
  const registry = commandRegistry(seen, options.reply);
  if (options.withPermissions) registry.register(permissionsModule);
  const executor = new RecordingExecutor();
  const { logger, lines } = collectingLogger();
  const { resolver, reconciled } = realResolver(
    registry,
    options.stored === undefined ? record() : options.stored,
  );

  const config: ConfigProvider = {
    get: async (_guildId, moduleId) =>
      options.snapshot ? options.snapshot(moduleId) : { enabled: true, config: { enabled: true } },
  };

  const runtime = new ModuleRuntime({
    bus,
    registry,
    executor,
    config,
    logger,
    dashboardUrl: DASHBOARD,
    resolver: options.resolver ?? resolver,
    commandSettings: { get: options.view ?? (async () => viewOf({})) },
  });

  return { runtime, executor, seen, lines, reconciled };
}

function replyEphemeral(executor: RecordingExecutor): unknown {
  return (executor.requests[0]?.payload as { ephemeral?: boolean } | undefined)?.ephemeral;
}

function replyText(executor: RecordingExecutor): string {
  const payload = executor.requests[0]?.payload as
    | { content?: string; embeds?: Array<{ description?: string }> }
    | undefined;
  return String(payload?.content || payload?.embeds?.[0]?.description || '');
}

describe('dispatch by internal key', () => {
  test('a renamed command runs the internal handler', async () => {
    const { runtime, seen } = build();

    await runtime.handle(punish());

    expect(seen.commands.map((entry) => entry.key)).toEqual(['ban']);
  });

  test('refusal copy uses the name the server sees', async () => {
    const { runtime, executor, seen } = build({
      snapshot: () => ({ enabled: false, config: { enabled: true } }),
    });

    await runtime.handle(punish());

    expect(seen.commands).toEqual([]);
    expect(replyText(executor)).toContain('`/punish`');
    expect(replyText(executor)).not.toContain('/ban');
  });

  test('a permission override on the key refuses with the display name', async () => {
    const { runtime, executor, seen } = build({
      withPermissions: true,
      snapshot: (moduleId) =>
        moduleId === 'permissions'
          ? { enabled: true, config: permissionsConfigSchema.parse({ overrides: { ban: [ROLE] } }) }
          : { enabled: true, config: { enabled: true } },
    });

    await runtime.handle(punish());

    expect(seen.commands).toEqual([]);
    expect(replyText(executor)).toContain('/punish');
    expect(executor.requests[0]?.idempotencyKey).toEndWith(':permission-refusal');
  });

  test('a context menu routes by its type-qualified key', async () => {
    const { runtime, seen } = build({ stored: null });

    await runtime.handle(guildEvent('interactionCreateGuildUserCommand'));

    expect(seen.menus.map((entry) => entry.key)).toEqual(['user:Report user']);
  });

  test('an interaction Proton cannot place is refused while it registers again', async () => {
    const { runtime, executor, seen, reconciled } = build({ stored: record({ idHistory: {} }) });

    await runtime.handle(punish());

    expect(seen.commands).toEqual([]);
    expect(replyText(executor)).toContain(UPDATING_REFUSAL);
    expect(replyEphemeral(executor)).toBe(true);
    expect(reconciled).toEqual([TEST_GUILD]);
  });

  const staleGlobalBan = () =>
    guildEvent('interactionCreateGuildCommand', (data) => {
      delete data.guild_id;
      data.options = [{ name: 'add', type: 1, options: [{ name: 'days', type: 3, value: '7' }] }];
    });

  test('an out-of-date global copy is refused privately and pointed at the server’s own', async () => {
    const { runtime, executor, seen, reconciled } = build();

    await runtime.handle(staleGlobalBan());

    expect(seen.commands).toEqual([]);
    expect(replyText(executor)).toContain('That copy of /ban is out of date. Use /punish instead.');
    expect(replyEphemeral(executor)).toBe(true);
    expect(executor.requests[0]?.idempotencyKey).toEndWith(':command-outdated');
    expect(reconciled).toEqual([]);
  });

  test('an out-of-date global copy whose server copy kept the name points at the other one', async () => {
    const { runtime, executor } = build({
      stored: record({ commands: [{ key: 'ban', id: BAN_ID, name: 'ban', kind: 'chat' }] }),
    });

    await runtime.handle(staleGlobalBan());

    expect(replyText(executor)).toContain(
      'That copy of /ban is out of date. Pick the other /ban in the command list.',
    );
  });

  test('an out-of-date global copy with no server copy sends the admin to the Commands page', async () => {
    const { runtime, executor, reconciled } = build({ stored: record({ commands: [] }) });

    await runtime.handle(staleGlobalBan());

    expect(replyText(executor)).toContain(
      'That copy of /ban is out of date, and this server has no current /ban to use instead. ' +
        `A server admin can manage commands at <${DASHBOARD}/dashboard/${TEST_GUILD}/commands>.`,
    );
    expect(replyText(executor)).not.toContain('Pick the other');
    expect(replyEphemeral(executor)).toBe(true);
    expect(reconciled).toEqual([]);
  });

  test('a redelivery of an interaction refused while updating is not run once the server syncs', async () => {
    const seen = emptySeen();
    const claimed = new Set<string>();
    const executor: ActionExecutor = {
      async execute(request) {
        if (claimed.has(request.idempotencyKey)) return { status: 'skipped_duplicate' };
        claimed.add(request.idempotencyKey);
        return { status: 'executed' };
      },
    };
    let resolves = 0;
    const runtime = new ModuleRuntime({
      bus,
      registry: commandRegistry(seen),
      executor,
      config: { get: async () => ({ enabled: true, config: { enabled: true } }) },
      logger: collectingLogger().logger,
      resolver: {
        resolve: async () => {
          resolves += 1;
          return resolves === 1
            ? { unresolved: 'updating' }
            : { key: 'ban', displayName: 'punish' };
        },
      },
      refused: { has: async (key) => claimed.has(key) },
    });
    const event = punish();

    await runtime.handle(event);
    await runtime.handle(event);

    expect(seen.commands).toEqual([]);
    expect(resolves).toBe(1);
    expect(claimed.has(`${event.id}:commands-updating`)).toBe(true);

    await runtime.handle({ ...event, id: `${event.id}-next` });
    expect(seen.commands.map((entry) => entry.key)).toEqual(['ban']);
  });

  test('without a resolver the command name is the key', async () => {
    const seen = emptySeen();
    const runtime = new ModuleRuntime({
      bus,
      registry: commandRegistry(seen),
      executor: new RecordingExecutor(),
      config: { get: async () => ({ enabled: true, config: { enabled: true } }) },
      logger: collectingLogger().logger,
    });

    await runtime.handle(guildEvent('interactionCreateGuildCommand'));

    expect(seen.commands.map((entry) => entry.key)).toEqual(['ban']);
    expect('privateReply' in (seen.commands[0]?.ctx ?? {})).toBe(false);
  });
});

describe('the per-server switch', () => {
  test('a switched-off command is refused privately and names where to switch it on', async () => {
    const { runtime, executor, seen } = build({
      view: async () => viewOf({ moderation: true }, { ban: { enabled: false } }),
    });

    await runtime.handle(punish());

    expect(seen.commands).toEqual([]);
    expect(replyText(executor)).toContain(
      '`/punish` is off in this server. A server admin can turn it on at ' +
        `<${DASHBOARD}/dashboard/${TEST_GUILD}/commands>.`,
    );
    expect(replyEphemeral(executor)).toBe(true);
  });

  test('settings that cannot be read run the command with defaults, logged once', async () => {
    const { runtime, seen, lines } = build({
      reply: { default: 'private', toggleable: ['add'] },
      view: async () => {
        throw new Error('api returned 503');
      },
    });

    await runtime.handle(punish());
    await runtime.handle(punish());

    expect(seen.commands).toHaveLength(2);
    expect(seen.commands[0]?.ctx.privateReply).toBe(true);
    expect(lines.filter((line) => line.includes('per-server command settings'))).toHaveLength(1);
  });

  test('config, permissions and settings are read at the same time', async () => {
    const started: string[] = [];
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const { runtime, seen } = build({
      withPermissions: true,
      snapshot: async (moduleId) => {
        started.push(`config:${moduleId}`);
        await gate;
        return moduleId === 'permissions'
          ? { enabled: false, config: permissionsConfigSchema.parse({}) }
          : { enabled: true, config: { enabled: true } };
      },
      view: async () => {
        started.push('settings');
        await gate;
        return viewOf({});
      },
    });

    const handled = runtime.handle(punish());
    await Bun.sleep(0);
    expect(started.sort()).toEqual(['config:moderation', 'config:permissions', 'settings']);

    release();
    await handled;
    expect(seen.commands).toHaveLength(1);
  });
});

describe('ctx.privateReply', () => {
  const policy = { default: 'private' as const, toggleable: ['add'] };

  test('the admin preference applies to a toggleable path', async () => {
    const { runtime, seen } = build({
      reply: policy,
      view: async () => viewOf({}, { ban: { privateReply: false } }),
    });

    await runtime.handle(punish('add'));

    expect(seen.commands[0]?.ctx.privateReply).toBe(false);
  });

  test('a path outside the allowlist keeps its default whatever the preference', async () => {
    const { runtime, seen } = build({
      reply: policy,
      view: async () => viewOf({}, { ban: { privateReply: false } }),
    });

    await runtime.handle(punish('remove'));

    expect(seen.commands[0]?.ctx.privateReply).toBe(true);
  });

  test('no preference means the default', async () => {
    const { runtime, seen } = build({ reply: policy });

    await runtime.handle(punish('add'));

    expect(seen.commands[0]?.ctx.privateReply).toBe(true);
  });

  test('a command without a policy gets no privateReply at all', async () => {
    const { runtime, seen } = build({ reply: policy, stored: null });

    await runtime.handle(
      guildEvent('interactionCreateGuildCommand', (data) => {
        data.name = 'kick';
        data.options = [{ name: 'user', type: 6, value: '100000000000000003' }];
      }),
    );

    expect(seen.commands.map((entry) => entry.key)).toEqual(['kick']);
    expect('privateReply' in (seen.commands[0]?.ctx ?? {})).toBe(false);
  });
});

describe('autocomplete rewrite', () => {
  function autocompleteModule(names: unknown[]): ModuleManifest {
    return {
      id: 'moderation',
      name: 'Moderation',
      category: 'moderation',
      configSchema: z.object({ enabled: z.boolean().default(true) }),
      defaultConfig: { enabled: true },
      schemaVersion: 1,
      requiredIntents: [],
      requiredPermissions: [],
      listeners: [
        {
          types: ['interaction.autocomplete', 'member.joined'],
          handler: async (event: ProtonEvent) => {
            names.push((event.payload as { data?: { name?: unknown } }).data?.name);
          },
        },
      ],
    } as unknown as ModuleManifest;
  }

  function listenerWith(resolver: CommandResolverPort) {
    const names: unknown[] = [];
    const manifest = autocompleteModule(names);
    const registry = commandRegistry();
    const runtime = new ModuleListenerRuntime({
      bus,
      registry,
      executor: new RecordingExecutor(),
      config: { get: async () => ({ enabled: true, config: { enabled: true } }) },
      logger: collectingLogger().logger,
      resolver,
    });
    return { runtime, manifest, names, registry };
  }

  test('modules see the internal key, not the name the server gave the command', async () => {
    const { resolver } = realResolver(commandRegistry(), record());
    const { runtime, manifest, names } = listenerWith(resolver);

    await runtime.handleFor(
      manifest,
      guildEvent('interactionCreateGuildAutocomplete', (data) => {
        data.name = 'punish';
      }),
    );

    expect(names).toEqual(['ban']);
  });

  test('an unresolved autocomplete is left as Discord sent it', async () => {
    const { resolver } = realResolver(commandRegistry(), record({ idHistory: {} }));
    const { runtime, manifest, names } = listenerWith(resolver);

    await runtime.handleFor(
      manifest,
      guildEvent('interactionCreateGuildAutocomplete', (data) => {
        data.name = 'punish';
      }),
    );

    expect(names).toEqual(['punish']);
  });

  test('other events never touch the resolver', async () => {
    let resolves = 0;
    const { runtime, manifest } = listenerWith({
      resolve: async () => {
        resolves += 1;
        return { key: 'x', displayName: 'x' };
      },
    });

    await runtime.handleFor(manifest, {
      id: 'member.joined:1',
      type: 'member.joined',
      guildId: TEST_GUILD,
      occurredAt: 0,
      payload: { data: { name: 'ban' } },
    });

    expect(resolves).toBe(0);
  });
});
