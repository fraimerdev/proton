import { describe, expect, test } from 'bun:test';
import {
  type ActionExecutor,
  type CommandContext,
  type CommandWorkerView,
  commandCatalogue,
  EMPTY_MESSAGE,
  type EventBus,
  labelOf,
  type ModuleContext,
  type ModuleManifest,
  type ModuleRegistry,
  type ProtonEvent,
  type SimulationOutcome,
  type SimulationScene,
} from '@proton/core';
import type { PlaceholderEnvironment } from '@proton/core/placeholders';
import type { CommandRegistrationRecord } from '@proton/db';
import { dispatch } from '@proton/fixtures';
import { normalise } from '@proton/gateway/normaliser';
import { z } from 'zod';
import { CommandLabels, internalLabel } from '../src/command-labels.ts';
import { CommandResolver, type CommandResolverPort } from '../src/command-resolver.ts';
import { CommandRecordCache } from '../src/command-sync.ts';
import { ModuleListenerRuntime } from '../src/listener-runtime.ts';
import { createScheduledJobRunner } from '../src/module-jobs.ts';
import { ModuleRuntime } from '../src/runtime.ts';
import { SimulationConsumer } from '../src/simulation-consumer.ts';
import {
  collectingLogger,
  commandRegistry,
  emptySeen,
  MemoryRegistrations,
  OTHER_GUILD,
  TEST_GUILD,
  viewOf,
} from './command-fakes.ts';

const BAN_ID = '1260000000000000001';

const executor: ActionExecutor = { execute: async () => ({ status: 'executed' }) };

const bus: EventBus = {
  publish: async () => undefined,
  subscribe: () => ({ group: 'x', close: async () => undefined }),
};

function record(overrides: Partial<CommandRegistrationRecord> = {}): CommandRegistrationRecord {
  return {
    guildId: TEST_GUILD,
    scope: 'guild',
    definitionHash: 'h',
    commands: [
      { key: 'ban', id: BAN_ID, name: 'punish', kind: 'chat' },
      { key: 'user:Report user', id: '1260000000000000009', name: 'Report user', kind: 'user' },
    ],
    idHistory: { [BAN_ID]: 'ban' },
    checkedAt: '2026-09-21T00:00:00.000Z',
    syncedAt: '2026-09-21T00:00:00.000Z',
    failure: null,
    permissionsCheckedAt: null,
    lostPermissions: null,
    ...overrides,
  };
}

const RENAMED = viewOf(
  { moderation: true },
  {
    ban: { name: 'sanction', updatedAt: '2026-09-22T00:00:00.000Z' },
    kick: { name: 'boot', enabled: false, updatedAt: '2026-09-22T00:00:00.000Z' },
  },
);

interface Sources {
  registry?: ModuleRegistry;
  stored?: CommandRegistrationRecord | null;
  view?: CommandWorkerView;
  inScope?: boolean;
}

function sources(options: Sources = {}) {
  const registry = options.registry ?? commandRegistry();
  const store = new MemoryRegistrations();
  const stored = options.stored === undefined ? record() : options.stored;
  if (stored) store.records.set(TEST_GUILD, stored);

  const records = new CommandRecordCache(store);
  const view = { current: options.view ?? RENAMED, fail: null as Error | null, reads: 0 };
  const recordFailure = { current: null as Error | null };
  const { logger, lines } = collectingLogger();

  const labels = new CommandLabels({
    catalogue: commandCatalogue(registry),
    records: {
      get: async (guildId) => {
        if (recordFailure.current) throw recordFailure.current;
        return records.get(guildId);
      },
    },
    settings: {
      get: async () => {
        view.reads += 1;
        if (view.fail) throw view.fail;
        return view.current;
      },
    },
    inScope: (guildId) => (options.inScope ?? true) && guildId === TEST_GUILD,
    logger,
  });

  return { registry, labels, records, view, recordFailure, lines };
}

describe('CommandLabels', () => {
  test('the name Discord holds wins over the one saved since', async () => {
    const label = await sources().labels.forGuild(TEST_GUILD);

    expect(label('ban')).toBe('/punish');
    expect(label('ban', 'remove')).toBe('/punish remove');
  });

  test('a command Discord does not hold is named by its saved settings', async () => {
    const label = await sources().labels.forGuild(TEST_GUILD);

    expect(label('kick')).toBe('/boot');
  });

  test('a command nobody renamed is its internal key, with the path spelled out', async () => {
    const label = await sources().labels.forGuild(TEST_GUILD);

    expect(label('warn', 'add')).toBe('/warn add');
    expect(label('user:Report user')).toBe('Apps → Report user');
    expect(label('not-a-command')).toBe('/not-a-command');
  });

  test('before the first registration the saved names are used', async () => {
    const label = await sources({ stored: null }).labels.forGuild(TEST_GUILD);

    expect(label('ban', 'add')).toBe('/sanction add');
  });

  test('a saved name Discord would refuse is never shown', async () => {
    const label = await sources({
      stored: null,
      view: viewOf({}, { kick: { name: 'Bad Name' } }),
    }).labels.forGuild(TEST_GUILD);

    expect(label('kick')).toBe('/kick');
  });

  test('outside the registration scope saved names never apply', async () => {
    const { labels, view } = sources({ stored: null });

    const label = await labels.forGuild(OTHER_GUILD);

    expect(label('ban', 'add')).toBe('/ban add');
    expect(label('kick')).toBe('/kick');
    expect(view.reads).toBe(0);
  });

  test('with nothing renamed the internal labeler is handed back as it is', async () => {
    const { labels } = sources({ stored: null, view: viewOf({}) });

    expect(await labels.forGuild(TEST_GUILD)).toBe(internalLabel);
  });

  test('a record that cannot be read falls back to the saved names, logged once', async () => {
    const { labels, recordFailure, lines } = sources();
    recordFailure.current = new Error('database is down');

    const first = await labels.forGuild(TEST_GUILD);
    const second = await labels.forGuild(TEST_GUILD);

    expect(first('ban')).toBe('/sanction');
    expect(second('kick')).toBe('/boot');
    expect(lines.filter((line) => line.includes('database is down'))).toHaveLength(1);
  });

  test('settings that cannot be read fall back to what Discord holds, logged once an outage', async () => {
    const { labels, view, lines } = sources();
    view.fail = new Error('api returned 503');

    const during = await labels.forGuild(TEST_GUILD);
    await labels.forGuild(TEST_GUILD);
    view.fail = null;
    await labels.forGuild(TEST_GUILD);
    view.fail = new Error('api returned 503');
    await labels.forGuild(TEST_GUILD);

    expect(during('ban')).toBe('/punish');
    expect(during('kick')).toBe('/kick');
    expect(lines.filter((line) => line.includes('api returned 503'))).toHaveLength(2);
  });

  test('nothing readable is internal names, and never a throw', async () => {
    const { labels, view, recordFailure } = sources();
    view.fail = new Error('api returned 503');
    recordFailure.current = new Error('database is down');

    const label = await labels.forGuild(TEST_GUILD);

    expect(label).toBe(internalLabel);
    expect(label('ban', 'add')).toBe('/ban add');
  });
});

function guildEvent(name: string): ProtonEvent {
  const raw = dispatch('interactionCreateGuildCommand');
  (raw.d.data as Record<string, unknown>).name = name;
  const event = normalise(raw)[0];
  if (!event) throw new Error('interactionCreateGuildCommand did not normalise');
  return event;
}

const enabledConfig = { get: async () => ({ enabled: true, config: { enabled: true } }) };

describe('a command handler', () => {
  function runtime(resolver?: CommandResolverPort) {
    const seen = emptySeen();
    const built = sources({ registry: commandRegistry(seen) });
    const logger = collectingLogger().logger;

    return {
      seen,
      runtime: new ModuleRuntime({
        bus,
        registry: built.registry,
        executor,
        config: enabledConfig,
        logger,
        resolver:
          resolver ??
          new CommandResolver({
            catalogue: commandCatalogue(built.registry),
            records: built.records,
            logger,
          }),
        commandSettings: { get: async () => RENAMED },
        labels: built.labels,
      }),
    };
  }

  test('sees every command under the name this server shows', async () => {
    const { runtime: under, seen } = runtime();

    await under.handle(guildEvent('punish'));

    const ctx = seen.commands[0]?.ctx as CommandContext;
    expect(seen.commands.map((entry) => entry.key)).toEqual(['ban']);
    expect(labelOf(ctx, 'ban', 'remove')).toBe('/punish remove');
    expect(labelOf(ctx, 'kick')).toBe('/boot');
    expect(labelOf(ctx, 'warn', 'add')).toBe('/warn add');
  });

  test('names the invoked command exactly as the member typed it', async () => {
    const { runtime: under, seen } = runtime({
      resolve: async () => ({ key: 'ban', displayName: 'smite' }),
    });

    await under.handle(guildEvent('smite'));

    const ctx = seen.commands[0]?.ctx as CommandContext;
    expect(labelOf(ctx, 'ban', 'add')).toBe('/smite add');
    expect(labelOf(ctx, 'kick')).toBe('/boot');
  });

  test('without a label source the context carries none, and labels are internal', async () => {
    const seen = emptySeen();
    const plain = new ModuleRuntime({
      bus,
      registry: commandRegistry(seen),
      executor,
      config: enabledConfig,
      logger: collectingLogger().logger,
    });

    await plain.handle(guildEvent('ban'));

    const ctx = seen.commands[0]?.ctx as CommandContext;
    expect('commandLabel' in ctx).toBe(false);
    expect(labelOf(ctx, 'ban', 'remove')).toBe('/ban remove');
  });
});

function listening(seen: Array<string | undefined>): ModuleManifest {
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
        types: ['member.joined', 'interaction.component'],
        handler: async (_event: ProtonEvent, ctx: ModuleContext) => {
          seen.push(ctx.commandLabel?.('ban', 'add'));
        },
      },
    ],
  } as unknown as ModuleManifest;
}

describe('a listener handler', () => {
  function listener() {
    const built = sources();
    const seen: Array<string | undefined> = [];
    const runtime = new ModuleListenerRuntime({
      bus,
      registry: built.registry,
      executor,
      config: enabledConfig,
      logger: collectingLogger().logger,
      labels: built.labels,
    });
    return { runtime, seen, manifest: listening(seen) };
  }

  test('an event handler sees the name this server shows', async () => {
    const { runtime, seen, manifest } = listener();

    await runtime.handleFor(manifest, {
      id: 'member.joined:1',
      type: 'member.joined',
      guildId: TEST_GUILD,
      occurredAt: 0,
      payload: {},
    });

    expect(seen).toEqual(['/punish add']);
  });

  test('a component handler sees it too', async () => {
    const { runtime, seen, manifest } = listener();
    const event = normalise(dispatch('interactionCreateComponent'))[0];
    if (!event) throw new Error('interactionCreateComponent did not normalise');

    await runtime.handleFor(manifest, event);

    expect(event.type).toBe('interaction.component');
    expect(seen).toEqual(['/punish add']);
  });
});

describe('a scheduled job handler', () => {
  test('sees the name this server shows', async () => {
    const built = sources();
    const seen: Array<string | undefined> = [];
    built.registry.register({
      id: 'reminders',
      name: 'Reminders',
      category: 'utility',
      configSchema: z.object({ enabled: z.boolean().default(true) }),
      defaultConfig: { enabled: true },
      schemaVersion: 1,
      requiredIntents: [],
      requiredPermissions: [],
      schedules: ['nudge'],
      scheduledHandlers: {
        nudge: async (_data: unknown, ctx: ModuleContext) => {
          seen.push(labelOf(ctx, 'ban', 'remove'));
        },
      },
    } as unknown as ModuleManifest);

    const run = createScheduledJobRunner({
      registry: built.registry,
      config: enabledConfig,
      executor,
      logger: collectingLogger().logger,
      labels: built.labels,
    });

    await run({
      guildId: TEST_GUILD,
      moduleId: 'reminders',
      jobId: 'nudge',
      data: {},
      idempotencyKey: 'job-1',
      attempts: 1,
      reschedule: async () => ({ status: 'completed' }) as never,
    });

    expect(seen).toEqual(['/punish remove']);
  });
});

describe('a rehearsal', () => {
  test('renders with the names this server shows', async () => {
    const built = sources();
    const scenes: SimulationScene[] = [];
    built.registry.register({
      id: 'greeter',
      name: 'Greeter',
      category: 'engagement',
      configSchema: z.object({ enabled: z.boolean().default(true) }),
      defaultConfig: { enabled: true },
      schemaVersion: 1,
      requiredIntents: [],
      requiredPermissions: [],
      simulations: [
        {
          descriptor: {
            id: 'greeting',
            moduleId: 'greeter',
            label: 'Greeting',
            summary: 'The message a new member gets.',
            configPath: 'greeting',
            output: 'message',
            delivery: 'channel',
            subject: true,
            inputs: [],
          },
          build: (_config: unknown, scene: SimulationScene) => {
            scenes.push(scene);
            return {
              ok: true,
              output: {
                kind: 'message',
                message: { ...EMPTY_MESSAGE, content: `Try ${labelOf(scene, 'ban', 'add')}` },
                attachments: [],
              },
              diagnostics: [],
              caption: 'A greeting',
            };
          },
        },
      ],
    } as unknown as ModuleManifest);

    const answers: SimulationOutcome[] = [];
    const placeholders: PlaceholderEnvironment = {
      applicationId: '200000000000000001',
      bot: async () => ({
        id: '200000000000000001',
        name: 'Proton',
        supportUrl: 'https://prtn.xyz',
      }),
      server: async (id) => ({ id }),
      user: async () => null,
      now: () => 0,
    };

    const consumer = new SimulationConsumer({
      bus,
      results: {
        recall: async () => null,
        answer: async (_id, outcome) => {
          answers.push(outcome);
        },
        wait: async () => null,
      },
      registry: built.registry,
      executor,
      guildState: { get: async () => null },
      rest: { request: async () => ({ status: 200, body: { user: { id: '1' }, roles: [] } }) },
      placeholders,
      apiUrl: 'http://api.invalid',
      apiSecret: 'secret',
      logger: collectingLogger().logger,
      now: () => 0,
      labels: built.labels,
    });

    await consumer.handle({
      id: 'proton.simulation_requested:1',
      type: 'proton.simulation_requested',
      guildId: TEST_GUILD,
      occurredAt: 0,
      payload: {
        requestId: 'request-0001',
        guildId: TEST_GUILD,
        moduleId: 'greeter',
        simulationId: 'greeting',
        mode: 'preview',
        actorId: '100000000000000001',
        subjectId: '100000000000000001',
        channelId: '300000000000000001',
        inputs: {},
        config: { enabled: true },
        tier: 'free',
        usedDraft: false,
      },
    });

    expect(scenes).toHaveLength(1);
    expect(answers[0]?.render?.message?.content).toBe('Try /punish add');
  });
});
