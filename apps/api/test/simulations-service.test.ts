import { describe, expect, test } from 'bun:test';
import type {
  EventBus,
  ModuleManifest,
  ProtonEvent,
  RateWindowStore,
  SimulationAdapter,
  SimulationOutcome,
  SimulationResults,
} from '@proton/core';
import { ModuleRegistry } from '@proton/core';
import type { DbHandle } from '@proton/db';
import { z } from 'zod';
import type { ModuleConfigService, ModuleConfigView } from '../src/modules/service.ts';
import {
  SIMULATION_SEND_LIMIT,
  SimulationError,
  SimulationService,
} from '../src/simulations/service.ts';

const GUILD = '900000000000000001';
const ACTOR = '100000000000000001';
const CHANNEL = '100000000000000040';

const configSchema = z.object({
  enabled: z.boolean().default(false),
  channelId: z
    .string()
    .regex(/^\d{17,20}$/)
    .optional(),
  greeting: z.string().min(1).max(40).default('Hello'),
});

type Config = z.infer<typeof configSchema>;

const ADAPTER: SimulationAdapter<Config> = {
  descriptor: {
    id: 'demo.greeting',
    moduleId: 'demo',
    label: 'Greeting',
    summary: 'What Proton says.',
    configPath: 'greeting',
    output: 'message',
    delivery: 'channel',
    channelPath: 'channelId',
    subject: true,
    inputs: [{ key: 'times', label: 'Times', kind: 'integer', min: 1, max: 5, fallback: 2 }],
  },
  destination: (config) => config.channelId ?? null,
  build: () => ({ ok: false, humanReason: 'not built here', diagnostics: [] }),
};

function manifest(overrides: Partial<ModuleManifest> = {}): ModuleManifest {
  return {
    id: 'demo',
    name: 'Demo',
    category: 'utility',
    configSchema,
    defaultConfig: configSchema.parse({}),
    schemaVersion: 1,
    requiredIntents: [1],
    requiredPermissions: [],
    simulations: [ADAPTER],
    ...overrides,
  } as unknown as ModuleManifest;
}

function view(overrides: Partial<ModuleConfigView> = {}): ModuleConfigView {
  return {
    moduleId: 'demo',
    enabled: true,
    config: { enabled: true, channelId: CHANNEL, greeting: 'Hello' },
    schemaVersion: 1,
    migrated: false,
    tier: 'free',
    postables: [],
    simulations: [ADAPTER.descriptor],
    ...overrides,
  };
}

interface Harness {
  service: SimulationService;
  published: ProtonEvent[];
  audits: unknown[];
  hits: number;
}

function harness(
  options: {
    manifest?: ModuleManifest;
    view?: ModuleConfigView;
    answer?: SimulationOutcome | null;
    recalled?: SimulationOutcome | null;
    count?: number;
  } = {},
): Harness {
  const registry = new ModuleRegistry();
  registry.register(options.manifest ?? manifest());

  const published: ProtonEvent[] = [];
  const audits: unknown[] = [];
  let hits = 0;

  const outcome: SimulationOutcome = options.answer ?? {
    ok: true,
    mode: 'preview',
    simulationId: 'demo.greeting',
    usedDraft: false,
    destination: { kind: 'channel', channelId: CHANNEL, label: '#general' },
    render: null,
    sent: null,
    error: null,
  };

  const results: SimulationResults = {
    recall: async () => options.recalled ?? null,
    answer: async () => undefined,
    wait: async () => outcome,
  };

  const bus = {
    publish: async (event: ProtonEvent) => {
      published.push(event);
    },
    subscribe: () => ({ stop: async () => undefined }),
  } as unknown as EventBus;

  const rateWindow: RateWindowStore = {
    hit: async () => {
      hits += 1;
      return { count: options.count ?? hits, tripped: false };
    },
  };

  const modules = {
    get: async () => options.view ?? view(),
  } as unknown as ModuleConfigService;

  const db = {
    db: {
      insert: () => ({
        values: async (row: unknown) => {
          audits.push(row);
        },
      }),
    },
  } as unknown as DbHandle;

  const service = new SimulationService({
    modules,
    registry,
    db,
    results,
    bus,
    rateWindow,
    now: () => 1_700_000_000_000,
  });

  return {
    service,
    published,
    audits,
    get hits() {
      return hits;
    },
  };
}

function payloadOf(event: ProtonEvent | undefined): Record<string, unknown> {
  if (event === undefined) throw new Error('nothing was published');
  return event.payload as Record<string, unknown>;
}

function run(overrides: Record<string, unknown> = {}) {
  return {
    guildId: GUILD,
    moduleId: 'demo',
    simulationId: 'demo.greeting',
    mode: 'preview' as const,
    requestId: 'sim-abcdefgh',
    inputs: {},
    actorId: ACTOR,
    source: 'dashboard' as const,
    ...overrides,
  };
}

describe('running a simulation', () => {
  test('publishes the request and answers with what the worker sent back', async () => {
    const { service, published } = harness();
    const outcome = await service.run(run());

    expect(outcome.ok).toBe(true);
    expect(published).toHaveLength(1);
    expect(published[0]?.type).toBe('proton.simulation_requested');

    const payload = payloadOf(published[0]);
    expect(payload.guildId).toBe(GUILD);
    expect(payload.simulationId).toBe('demo.greeting');
    expect(payload.channelId).toBe(CHANNEL);
    expect(payload.tier).toBe('free');
  });

  test('stands the actor in as the example member when none is picked', async () => {
    const { service, published } = harness();
    await service.run(run());

    expect(payloadOf(published[0]).subjectId).toBe(ACTOR);
  });

  test('fills in the example data from what the dialog declares', async () => {
    const { service, published } = harness();
    await service.run(run());

    expect(payloadOf(published[0]).inputs).toEqual({ times: 2 });
  });

  test('refuses example data the control could never produce', async () => {
    const { service } = harness();

    await expect(service.run(run({ inputs: { times: 99 } }))).rejects.toThrow(SimulationError);
  });

  test('hands a repeated request the answer it already gave', async () => {
    const already: SimulationOutcome = {
      ok: true,
      mode: 'send',
      simulationId: 'demo.greeting',
      usedDraft: false,
      destination: { kind: 'channel', channelId: CHANNEL, label: '#general' },
      render: null,
      sent: { channelId: CHANNEL, messageId: '1', url: null, markerOmitted: null },
      error: null,
    };

    const { service, published } = harness({ recalled: already });
    const outcome = await service.run(run({ mode: 'send' }));

    expect(outcome).toEqual(already);
    expect(published).toHaveLength(0);
  });

  test('records a send in the audit trail and a preview nowhere', async () => {
    const sending = harness();
    await sending.service.run(run({ mode: 'send', channelId: CHANNEL }));
    expect(sending.audits).toHaveLength(1);

    const previewing = harness();
    await previewing.service.run(run());
    expect(previewing.audits).toHaveLength(0);
  });

  test('will not post from a module that is disabled, but will still render one', async () => {
    const off = view({ enabled: false });

    await expect(harness({ view: off }).service.run(run({ mode: 'send' }))).rejects.toThrow(
      /is off in this server/,
    );

    await expect(harness({ view: off }).service.run(run())).resolves.toBeDefined();
  });

  test('refuses a module the server has not paid for', async () => {
    const { service } = harness({ manifest: manifest({ requiredEntitlement: 'pro' }) });

    await expect(service.run(run())).rejects.toThrow(/pro plan/);
  });

  test('refuses a send with nowhere to send it', async () => {
    const { service } = harness({ view: view({ config: { enabled: true, greeting: 'Hello' } }) });

    await expect(service.run(run({ mode: 'send' }))).rejects.toThrow(/no channel/i);
  });

  test('renders a draft the admin has not saved, after checking it as a save would', async () => {
    const { service, published } = harness();
    await service.run(run({ draft: { enabled: true, channelId: CHANNEL, greeting: 'Hi there' } }));

    const payload = payloadOf(published[0]);
    expect(payload.usedDraft).toBe(true);
    expect((payload.config as Record<string, unknown>).greeting).toBe('Hi there');
  });

  test('refuses a draft the save would refuse, naming the setting', async () => {
    const { service } = harness();

    await expect(service.run(run({ draft: { greeting: '' } }))).rejects.toThrow(/greeting/);
  });

  test('stops posting once the window is full', async () => {
    const { service } = harness({ count: SIMULATION_SEND_LIMIT + 1 });

    await expect(service.run(run({ mode: 'send', channelId: CHANNEL }))).rejects.toThrow(
      /Wait a moment/,
    );
  });

  test('says so rather than guessing when the worker never answers', async () => {
    const registry = new ModuleRegistry();
    registry.register(manifest());

    const service = new SimulationService({
      modules: { get: async () => view() } as unknown as ModuleConfigService,
      registry,
      db: { db: { insert: () => ({ values: async () => undefined }) } } as unknown as DbHandle,
      results: { recall: async () => null, answer: async () => undefined, wait: async () => null },
      bus: { publish: async () => undefined } as unknown as EventBus,
    });

    await expect(service.run(run())).rejects.toThrow(/didn't hear back in time/);
  });

  test('says so rather than silently doing nothing when there is no event bus', async () => {
    const registry = new ModuleRegistry();
    registry.register(manifest());

    const service = new SimulationService({
      modules: { get: async () => view() } as unknown as ModuleConfigService,
      registry,
      db: { db: { insert: () => ({ values: async () => undefined }) } } as unknown as DbHandle,
    });

    await expect(service.run(run())).rejects.toThrow(/part of its service is down/);
  });

  test('names a simulation this module does not have', async () => {
    const { service } = harness();

    await expect(service.run(run({ simulationId: 'demo.nothing' }))).rejects.toThrow(
      /nothing called/,
    );
  });

  test('lists what a module offers', () => {
    const { service } = harness();

    expect(service.catalogue('demo').map(({ id }) => id)).toEqual(['demo.greeting']);
    expect(service.catalogue('welcome')).toEqual([]);
  });
});
