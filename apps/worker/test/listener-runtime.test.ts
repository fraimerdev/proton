import { describe, expect, test } from 'bun:test';
import {
  type ActionExecutor,
  type ActionRequest,
  type ActionResult,
  type EventBus,
  type EventType,
  type Logger,
  type ModuleContext,
  type ModuleManifest,
  ModuleRegistry,
  Permissions,
  type ProtonCustomId,
  type ProtonEvent,
  type SubscribeOptions,
} from '@proton/core';
import { dispatch } from '@proton/fixtures';
import { normalise } from '@proton/gateway/normaliser';
import { REPORT_CLOSE_JOB } from '@proton/module-moderation';
import { createModuleRegistry } from '@proton/modules';
import { z } from 'zod';
import { CachingConfigProvider, ConfigUnavailableError } from '../src/config-provider.ts';
import {
  interactionListenerGroup,
  listenerGroup,
  ModuleListenerRuntime,
  requestListenerGroup,
  subscribedTypes,
} from '../src/listener-runtime.ts';
import type { ConfigProvider } from '../src/runtime.ts';

const GUILD = '900000000000000001';

interface Seen {
  module: string;
  eventId: string;
  guildId: string;
  config: unknown;
}

const configSchema = z.object({ enabled: z.boolean(), label: z.string().default('') });

function testModule(options: {
  id: string;
  types: EventType[];
  seen: Seen[];
  throws?: boolean;

  secondTypes?: EventType[];
}): ModuleManifest {
  const handler = async (event: ProtonEvent, ctx: ModuleContext) => {
    options.seen.push({
      module: options.id,
      eventId: event.id,
      guildId: ctx.guildId,
      config: ctx.config,
    });
    if (options.throws) throw new Error(`${options.id} exploded`);
  };

  const listeners = [{ types: options.types, handler }];
  if (options.secondTypes) listeners.push({ types: options.secondTypes, handler });

  return {
    id: options.id,
    name: options.id,
    category: 'security',
    configSchema,
    defaultConfig: { enabled: true, label: '' },
    schemaVersion: 1,
    requiredIntents: [],
    requiredPermissions: [Permissions.ViewChannel],
    listeners,
  } as unknown as ModuleManifest;
}

interface SubscribeCall {
  group: string;
  types: EventType[];
  options: SubscribeOptions | undefined;
}

function recordingBus(): { bus: EventBus; calls: SubscribeCall[] } {
  const calls: SubscribeCall[] = [];
  return {
    calls,
    bus: {
      publish: async () => undefined,
      subscribe: (group, types, _handler, options) => {
        calls.push({ group, types, options });
        return { group, close: async () => undefined };
      },
    },
  };
}

const noopExecutor: ActionExecutor = {
  execute: async (_request: ActionRequest): Promise<ActionResult> => ({ status: 'executed' }),
};

function build(
  manifests: ModuleManifest[],
  config: ConfigProvider,
): {
  runtime: ModuleListenerRuntime;
  calls: SubscribeCall[];
  logs: Array<{ level: string; message: string }>;
} {
  const registry = new ModuleRegistry();
  for (const manifest of manifests) registry.register(manifest);

  const logs: Array<{ level: string; message: string }> = [];
  const logger: Logger = {
    info: (message) => logs.push({ level: 'info', message }),
    warn: (message) => logs.push({ level: 'warn', message }),
    error: (message) => logs.push({ level: 'error', message }),
  };

  const { bus, calls } = recordingBus();
  return {
    runtime: new ModuleListenerRuntime({
      bus,
      registry,
      executor: noopExecutor,
      config,
      logger,
    }),
    calls,
    logs,
  };
}

const enabled: ConfigProvider = {
  async get() {
    return { enabled: true, config: { enabled: true, label: 'x' } };
  },
};

function event(type: EventType, overrides: Partial<ProtonEvent> = {}): ProtonEvent {
  return {
    id: `${type}:1`,
    type,
    guildId: GUILD,
    occurredAt: 1_770_000_000_000,
    payload: {},
    ...overrides,
  };
}

describe('subscription shape', () => {
  test('one consumer group per module, never one shared group', () => {
    const seen: Seen[] = [];
    const { runtime, calls } = build(
      [
        testModule({ id: 'alpha', types: ['message.created'], seen }),
        testModule({ id: 'beta', types: ['message.created'], seen }),
      ],
      enabled,
    );

    runtime.start();

    expect(calls.map((c) => c.group)).toEqual(['listener:alpha', 'listener:beta']);
  });

  test('new listener groups start at $, not at the head of the stream', () => {
    const { runtime, calls } = build(
      [testModule({ id: 'alpha', types: ['message.created'], seen: [] })],
      enabled,
    );

    runtime.start();

    expect(calls[0]?.options?.startId).toBe('$');
  });

  test('a module with several listeners subscribes to the union, deduped', () => {
    const manifest = testModule({
      id: 'alpha',
      types: ['message.created', 'message.updated'],
      secondTypes: ['message.updated', 'member.joined'],
      seen: [],
    });

    expect(subscribedTypes(manifest).sort()).toEqual([
      'member.joined',
      'message.created',
      'message.updated',
    ]);
  });

  test('a module that declares no listeners gets no subscription', () => {
    const bare = {
      id: 'quiet',
      name: 'quiet',
      category: 'utility',
      configSchema,
      defaultConfig: { enabled: true, label: '' },
      schemaVersion: 1,
      requiredIntents: [],
      requiredPermissions: [Permissions.ViewChannel],
    } as unknown as ModuleManifest;

    const { runtime, calls } = build([bare], enabled);
    runtime.start();

    expect(calls).toEqual([]);
    expect(runtime.listening()).toEqual([]);
  });

  test('the group name is derived, not spelled out at each call site', () => {
    expect(listenerGroup('listener', 'antinuke')).toBe('listener:antinuke');
    expect(interactionListenerGroup('listener', 'antinuke')).toBe('listener:antinuke:interactions');
  });

  test('interactions get a group of their own, so slow events never hold a button up', () => {
    const { runtime, calls } = build(
      [
        testModule({
          id: 'alpha',
          types: ['message.created', 'interaction.component', 'interaction.modal'],
          secondTypes: ['interaction.autocomplete', 'member.joined'],
          seen: [],
        }),
      ],
      enabled,
    );

    const subscriptions = runtime.start();

    expect(subscriptions).toHaveLength(2);
    expect(calls.map((c) => [c.group, [...c.types].sort()])).toEqual([
      ['listener:alpha', ['member.joined', 'message.created']],
      [
        'listener:alpha:interactions',
        ['interaction.autocomplete', 'interaction.component', 'interaction.modal'],
      ],
    ]);
    expect(calls.every((c) => c.options?.startId === '$')).toBe(true);
  });

  test('only the interaction group runs concurrently, and only when the module opts in', () => {
    const concurrent = {
      ...testModule({
        id: 'alpha',
        types: ['message.created', 'interaction.component', 'moderation.report_action_requested'],
        seen: [],
      }),
      interactionConcurrency: 8,
    } as ModuleManifest;
    const { runtime, calls } = build(
      [concurrent, testModule({ id: 'beta', types: ['interaction.modal'], seen: [] })],
      enabled,
    );

    runtime.start();

    expect(calls.map((c) => [c.group, c.options])).toEqual([
      ['listener:alpha', { startId: '$' }],
      ['listener:alpha:interactions', { startId: '$', concurrency: 8 }],
      ['listener:alpha:requests', { startId: '$' }],
      ['listener:beta:interactions', { startId: '$' }],
    ]);
  });

  test('a dashboard request waits in a group of its own, never behind other events', () => {
    const { runtime, calls } = build(
      [
        testModule({
          id: 'moderation',
          types: [
            'moderation.report_action_requested',
            'moderation.report_submitted',
            'member.joined',
            'interaction.component',
          ],
          seen: [],
        }),
      ],
      enabled,
    );

    const subscriptions = runtime.start();

    expect(subscriptions).toHaveLength(3);
    expect(calls.map((c) => [c.group, [...c.types].sort()])).toEqual([
      ['listener:moderation', ['member.joined', 'moderation.report_submitted']],
      ['listener:moderation:interactions', ['interaction.component']],
      ['listener:moderation:requests', ['moderation.report_action_requested']],
    ]);
    expect(requestListenerGroup('listener', 'moderation')).toBe('listener:moderation:requests');
  });

  test('a module that only handles interactions subscribes only the interaction group', () => {
    const { runtime, calls } = build(
      [testModule({ id: 'alpha', types: ['interaction.component'], seen: [] })],
      enabled,
    );

    runtime.start();

    expect(calls.map((c) => c.group)).toEqual(['listener:alpha:interactions']);
  });

  test('a module with no interaction listeners keeps its single group', () => {
    const { runtime, calls } = build(
      [testModule({ id: 'alpha', types: ['message.created', 'proton.config_changed'], seen: [] })],
      enabled,
    );

    runtime.start();

    expect(calls.map((c) => c.group)).toEqual(['listener:alpha']);
  });
});

describe('the shipped moderation module', () => {
  test('runs eight interactions at once and gives dashboard requests their own group', () => {
    const registry = createModuleRegistry();
    const { bus, calls } = recordingBus();
    const runtime = new ModuleListenerRuntime({
      bus,
      registry,
      executor: noopExecutor,
      config: enabled,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    });

    runtime.start();
    const moderation = calls.filter((c) => c.group.startsWith('listener:moderation'));

    expect(moderation.map((c) => [c.group, c.options?.concurrency])).toEqual([
      ['listener:moderation', undefined],
      ['listener:moderation:interactions', 8],
      ['listener:moderation:requests', undefined],
    ]);
    expect(moderation[2]?.types).toEqual(['moderation.report_action_requested']);
  });

  test('lets its report-close job run while Moderation is off, and no other', () => {
    expect(createModuleRegistry().get('moderation')?.scheduledWhileDisabled).toEqual([
      REPORT_CLOSE_JOB,
    ]);
  });
});

describe('the shipped achievements module', () => {
  test('waits on a dashboard reward retry in a group of its own', () => {
    const { bus, calls } = recordingBus();
    const runtime = new ModuleListenerRuntime({
      bus,
      registry: createModuleRegistry(),
      executor: noopExecutor,
      config: enabled,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    });

    runtime.start();

    expect(calls.find((c) => c.group === 'listener:achievements:requests')?.types).toEqual([
      'achievements.reward_retry_requested',
    ]);
  });
});

describe('a press in a DM', () => {
  function dmModule(
    seen: Seen[],
    directInteractionGuild?: (customId: ProtonCustomId) => string | null,
  ): ModuleManifest {
    return {
      ...testModule({
        id: 'moderation',
        types: ['interaction.component', 'interaction.modal', 'message.created'],
        seen,
      }),
      ...(directInteractionGuild ? { directInteractionGuild } : {}),
    } as ModuleManifest;
  }

  const firstArg = (customId: ProtonCustomId) =>
    customId.action === 'rfin' ? (customId.args[0] ?? null) : null;

  function dmPress(edit?: (d: Record<string, unknown>) => void): ProtonEvent {
    const raw = dispatch('interactionCreateComponentDm');
    edit?.(raw.d);
    const normalised = normalise(raw)[0];
    if (!normalised) throw new Error('the DM press did not normalise');
    return normalised;
  }

  test('reaches the module under the guild its custom id names', async () => {
    const seen: Seen[] = [];
    const reads: string[] = [];
    const manifest = dmModule(seen, firstArg);
    const { runtime } = build([manifest], {
      async get(guildId) {
        reads.push(guildId);
        return { enabled: true, config: { enabled: true, label: 'x' } };
      },
    });

    const press = dmPress();
    expect(press.guildId).toBeNull();

    await runtime.handleFor(manifest, press);

    expect(reads).toEqual([GUILD]);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.guildId).toBe(GUILD);
  });

  test('the handler is given the event with the guild filled in', async () => {
    const received: ProtonEvent[] = [];
    const manifest = {
      ...dmModule([], firstArg),
      listeners: [
        {
          types: ['interaction.component'],
          handler: async (event: ProtonEvent) => {
            received.push(event);
          },
        },
      ],
    } as unknown as ModuleManifest;
    const { runtime } = build([manifest], enabled);

    await runtime.handleFor(manifest, dmPress());

    expect(received[0]?.guildId).toBe(GUILD);
    expect(received[0]?.id).toBe('interaction.component:1500000000000000008');
  });

  test('a DM modal submit is routed the same way', async () => {
    const seen: Seen[] = [];
    const manifest = dmModule(seen, (customId) =>
      customId.action === 'rsubd' ? (customId.args[0] ?? null) : null,
    );
    const { runtime } = build([manifest], enabled);

    await runtime.handleFor(
      manifest,
      event('interaction.modal', {
        guildId: null,
        payload: {
          id: '1500000000000000009',
          token: 't',
          type: 5,
          user: { id: '100000000000000001' },
          data: { custom_id: `proton:moderation:rsubd:${GUILD}:Ab3dE5gH9k`, components: [] },
        },
      }),
    );

    expect(seen[0]?.guildId).toBe(GUILD);
  });

  test.each([
    ['a module without the hook', undefined, undefined],
    ['a hook that declines', () => null, undefined],
    ['a hook that returns something that is not a snowflake', () => 'my-server', undefined],
    [
      'another module’s custom id',
      firstArg,
      (d: Record<string, unknown>) => {
        (d.data as Record<string, unknown>).custom_id = `proton:tickets:rfin:${GUILD}:x`;
      },
    ],
    [
      'a custom id that is not Proton’s',
      firstArg,
      (d: Record<string, unknown>) => {
        (d.data as Record<string, unknown>).custom_id = 'someone-elses-button';
      },
    ],
  ])('is dropped for %s, before any config is read', async (_label, hook, edit) => {
    const seen: Seen[] = [];
    let reads = 0;
    const manifest = dmModule(seen, hook);
    const { runtime } = build([manifest], {
      async get() {
        reads += 1;
        return { enabled: true, config: { enabled: true, label: 'x' } };
      },
    });

    await runtime.handleFor(manifest, dmPress(edit));

    expect(seen).toEqual([]);
    expect(reads).toBe(0);
  });

  test('only component and modal events are routed; a guild-less message is still dropped', async () => {
    const seen: Seen[] = [];
    const manifest = dmModule(seen, () => GUILD);
    const { runtime } = build([manifest], enabled);

    await runtime.handleFor(
      manifest,
      event('message.created', {
        guildId: null,
        payload: { data: { custom_id: `proton:moderation:rfin:${GUILD}:x` } },
      }),
    );

    expect(seen).toEqual([]);
  });

  test('a press in a guild never asks the hook', async () => {
    const seen: Seen[] = [];
    const asked: ProtonCustomId[] = [];
    const manifest = dmModule(seen, (customId) => {
      asked.push(customId);
      return '900000000000000002';
    });
    const { runtime } = build([manifest], enabled);

    await runtime.handleFor(manifest, event('interaction.component'));

    expect(asked).toEqual([]);
    expect(seen[0]?.guildId).toBe(GUILD);
  });
});

describe('dispatch', () => {
  test('invokes every listener of the module that matches the type', async () => {
    const seen: Seen[] = [];
    const manifest = testModule({
      id: 'alpha',
      types: ['message.created'],
      secondTypes: ['message.created'],
      seen,
    });
    const { runtime } = build([manifest], enabled);

    await runtime.handleFor(manifest, event('message.created'));

    expect(seen).toHaveLength(2);
    expect(seen[0]?.guildId).toBe(GUILD);
    expect(seen[0]?.config).toEqual({ enabled: true, label: 'x' });
  });

  test('does not invoke a listener whose types do not include the event', async () => {
    const seen: Seen[] = [];
    const manifest = testModule({ id: 'alpha', types: ['member.joined'], seen });
    const { runtime } = build([manifest], enabled);

    await runtime.handleFor(manifest, event('message.created'));

    expect(seen).toEqual([]);
  });

  test('a module disabled in this guild does not run', async () => {
    const seen: Seen[] = [];
    const manifest = testModule({ id: 'alpha', types: ['message.created'], seen });
    const { runtime, logs } = build([manifest], {
      async get() {
        return { enabled: false, config: { enabled: true, label: 'x' } };
      },
    });

    await runtime.handleFor(manifest, event('message.created'));

    expect(seen).toEqual([]);

    expect(logs).toEqual([]);
  });

  test('a module disabled still hears about it, so it can undo what it owns', async () => {
    const seen: Seen[] = [];
    const manifest = testModule({ id: 'alpha', types: ['proton.config_changed'], seen });
    const { runtime } = build([manifest], {
      async get() {
        return { enabled: false, config: { enabled: true, label: 'x' } };
      },
    });

    await runtime.handleFor(manifest, event('proton.config_changed'));

    expect(seen).toHaveLength(1);
  });

  test('an event with no guild is dropped before the config is even read', async () => {
    const seen: Seen[] = [];
    const manifest = testModule({ id: 'alpha', types: ['message.created'], seen });
    let reads = 0;
    const { runtime } = build([manifest], {
      async get() {
        reads += 1;
        return { enabled: true, config: { enabled: true, label: 'x' } };
      },
    });

    await runtime.handleFor(manifest, event('message.created', { guildId: null }));

    expect(seen).toEqual([]);
    expect(reads).toBe(0);
  });

  test('stored config that no longer parses stops the module and names the field', async () => {
    const seen: Seen[] = [];
    const manifest = testModule({ id: 'alpha', types: ['message.created'], seen });
    const { runtime, logs } = build([manifest], {
      async get() {
        return { enabled: true, config: { enabled: 'yes please' } };
      },
    });

    await runtime.handleFor(manifest, event('message.created'));

    expect(seen).toEqual([]);
    expect(logs[0]?.level).toBe('error');
    expect(logs[0]?.message).toContain('invalid stored config for alpha');
  });

  test('a module’s own config change is judged against the saved config, not the cache', async () => {
    const seen: Seen[] = [];
    const manifest = testModule({
      id: 'alpha',
      types: ['message.created', 'proton.config_changed'],
      seen,
    });
    let stored = { enabled: true, label: 'before' };
    const { runtime } = build(
      [manifest],
      new CachingConfigProvider(
        { get: async () => ({ enabled: true, config: stored }) },
        { ttlMs: 5_000 },
      ),
    );

    await runtime.handleFor(manifest, event('message.created'));
    stored = { enabled: true, label: 'after' };
    await runtime.handleFor(
      manifest,
      event('proton.config_changed', { payload: { moduleId: 'alpha', changedKeys: ['label'] } }),
    );

    expect(seen.map((s) => s.config)).toEqual([
      { enabled: true, label: 'before' },
      { enabled: true, label: 'after' },
    ]);
  });

  test('another module’s config change leaves this module’s cached config alone', async () => {
    const seen: Seen[] = [];
    const manifest = testModule({
      id: 'alpha',
      types: ['message.created', 'proton.config_changed'],
      seen,
    });
    let reads = 0;
    const { runtime } = build(
      [manifest],
      new CachingConfigProvider(
        {
          get: async () => {
            reads += 1;
            return { enabled: true, config: { enabled: true, label: 'x' } };
          },
        },
        { ttlMs: 5_000 },
      ),
    );

    await runtime.handleFor(manifest, event('message.created'));
    await runtime.handleFor(
      manifest,
      event('proton.config_changed', { payload: { moduleId: 'beta', changedKeys: ['label'] } }),
    );

    expect(seen).toHaveLength(2);
    expect(reads).toBe(1);
  });

  test('a module switched off just now hears its config change even through a warm cache', async () => {
    const seen: Seen[] = [];
    const manifest = testModule({
      id: 'alpha',
      types: ['message.created', 'proton.config_changed'],
      seen,
    });
    let stored = { enabled: true, config: { enabled: true, label: 'x' } };
    const { runtime } = build(
      [manifest],
      new CachingConfigProvider({ get: async () => stored }, { ttlMs: 5_000 }),
    );

    await runtime.handleFor(manifest, event('message.created'));
    stored = { enabled: false, config: { enabled: false, label: 'x' } };
    await runtime.handleFor(
      manifest,
      event('proton.config_changed', { payload: { moduleId: 'alpha', enabledAfter: false } }),
    );
    await runtime.handleFor(manifest, event('message.created'));

    expect(seen.map((s) => s.config)).toEqual([
      { enabled: true, label: 'x' },
      { enabled: false, label: 'x' },
    ]);
  });

  test('a cached config is parsed once, not once per event', async () => {
    const seen: Seen[] = [];
    let parses = 0;
    const manifest = {
      ...testModule({ id: 'alpha', types: ['message.created', 'proton.config_changed'], seen }),
      configSchema: z.object({
        enabled: z.boolean(),
        label: z.string().refine(() => {
          parses += 1;
          return true;
        }),
      }),
    } as ModuleManifest;
    const { runtime } = build(
      [manifest],
      new CachingConfigProvider(
        { get: async () => ({ enabled: true, config: { enabled: true, label: 'x' } }) },
        { ttlMs: 5_000 },
      ),
    );
    parses = 0;

    await runtime.handleFor(manifest, event('message.created'));
    await runtime.handleFor(manifest, event('message.created', { id: 'message.created:2' }));

    expect(parses).toBe(1);
    expect(seen[1]?.config).toBe(seen[0]?.config);

    await runtime.handleFor(
      manifest,
      event('proton.config_changed', { payload: { moduleId: 'alpha', changedKeys: ['label'] } }),
    );

    expect(parses).toBe(2);
  });

  test('one snapshot object handed to two modules is parsed by each module’s schema', async () => {
    const seen: Seen[] = [];
    const alpha = testModule({ id: 'alpha', types: ['message.created'], seen });
    const beta = {
      ...testModule({ id: 'beta', types: ['message.created'], seen }),
      configSchema: configSchema.extend({ mode: z.enum(['quiet', 'loud']).default('loud') }),
    } as ModuleManifest;
    const shared = { enabled: true, config: { enabled: true, label: 'x' } };
    const { runtime } = build([alpha, beta], { get: async () => shared });

    await runtime.handleFor(alpha, event('message.created'));
    await runtime.handleFor(beta, event('message.created'));

    expect(seen.map((s) => s.config)).toEqual([
      { enabled: true, label: 'x' },
      { enabled: true, label: 'x', mode: 'loud' },
    ]);
  });

  test('a throwing listener propagates, so the bus redelivers', async () => {
    const seen: Seen[] = [];
    const manifest = testModule({ id: 'alpha', types: ['message.created'], seen, throws: true });
    const { runtime } = build([manifest], enabled);

    await expect(runtime.handleFor(manifest, event('message.created'))).rejects.toThrow(
      'alpha exploded',
    );
  });
});

describe('a press on a module that cannot run is answered, not dropped', () => {
  const USER = '100000000000000001';
  const DASHBOARD = 'https://proton.example';
  const INTERACTION = '1500000000000000002';

  class RecordingExecutor implements ActionExecutor {
    readonly requests: ActionRequest[] = [];

    async execute(request: ActionRequest): Promise<ActionResult> {
      this.requests.push(request);
      return { status: 'executed' };
    }
  }

  function pressModule(
    seen: Seen[],
    options: { settingsPage?: boolean; types?: EventType[] } = {},
  ): ModuleManifest {
    return {
      ...testModule({
        id: 'alpha',
        types: options.types ?? [
          'interaction.component',
          'interaction.modal',
          'interaction.autocomplete',
          'message.created',
        ],
        seen,
      }),
      name: 'Alpha',
      ...(options.settingsPage === false ? {} : { dashboard: { icon: 'x', sections: [] } }),
      commands: [
        {
          name: 'apply',
          description: 'Apply',
          data: {
            name: 'apply',
            description: 'Apply',
            options: [{ type: 3, name: 'form', description: 'Form', autocomplete: true }],
          },
          handler: async () => undefined,
        },
      ],
    } as unknown as ModuleManifest;
  }

  function runtimeFor(
    manifest: ModuleManifest,
    snapshot: { enabled: boolean; config: unknown },
    dashboardUrl: string | null = DASHBOARD,
  ) {
    const registry = new ModuleRegistry();
    registry.register(manifest);
    const executor = new RecordingExecutor();
    const logs: Array<{ level: string; message: string }> = [];

    const runtime = new ModuleListenerRuntime({
      bus: recordingBus().bus,
      registry,
      executor,
      config: { get: async () => snapshot },
      logger: {
        info: (message) => logs.push({ level: 'info', message }),
        warn: (message) => logs.push({ level: 'warn', message }),
        error: (message) => logs.push({ level: 'error', message }),
      },
      ...(dashboardUrl === null ? {} : { dashboardUrl }),
    });

    return { runtime, executor, logs };
  }

  function press(customId: string, componentType = 2): ProtonEvent {
    return event('interaction.component', {
      id: `interaction.component:${INTERACTION}`,
      payload: {
        id: INTERACTION,
        token: 'press-token',
        type: 3,
        application_id: '800000000000000001',
        guild_id: GUILD,
        channel_id: '500000000000000001',
        member: { user: { id: USER }, roles: [] },
        data: { custom_id: customId, component_type: componentType },
      },
    });
  }

  function submit(customId: string): ProtonEvent {
    return event('interaction.modal', {
      id: `interaction.modal:${INTERACTION}`,
      payload: {
        id: INTERACTION,
        token: 'modal-token',
        type: 5,
        guild_id: GUILD,
        member: { user: { id: USER }, roles: [] },
        data: { custom_id: customId, components: [] },
      },
    });
  }

  function typing(command: string): ProtonEvent {
    return event('interaction.autocomplete', {
      id: `interaction.autocomplete:${INTERACTION}`,
      payload: {
        id: INTERACTION,
        token: 'autocomplete-token',
        type: 4,
        guild_id: GUILD,
        member: { user: { id: USER }, roles: [] },
        data: {
          name: command,
          type: 1,
          options: [{ name: 'form', type: 3, value: 'mod', focused: true }],
        },
      },
    });
  }

  function said(request: ActionRequest | undefined): string {
    const payload = request?.payload as { embeds?: Array<{ description?: string }> } | undefined;
    return payload?.embeds?.[0]?.description ?? '';
  }

  const OFF = { enabled: false, config: { enabled: true, label: 'x' } };
  const BROKEN = { enabled: true, config: { enabled: 'yes please' } };

  test('a button of a module switched off here says so privately, and the handler never runs', async () => {
    const seen: Seen[] = [];
    const manifest = pressModule(seen);
    const { runtime, executor } = runtimeFor(manifest, OFF);

    await runtime.handleFor(manifest, press('proton:alpha:go'));

    expect(seen).toEqual([]);
    expect(executor.requests).toHaveLength(1);

    const [reply] = executor.requests;
    expect(reply?.kind).toBe('interaction_reply');
    expect(reply?.moduleId).toBe('alpha');
    expect(reply?.actorId).toBe(USER);
    expect(reply?.idempotencyKey).toBe(`interaction.component:${INTERACTION}:module-disabled`);
    expect(reply?.payload).toMatchObject({
      interactionId: INTERACTION,
      interactionToken: 'press-token',
      callbackType: 4,
      ephemeral: true,
    });
    expect(said(reply)).toContain('**Alpha** is off in this server, so this button doesn’t work.');
    expect(said(reply)).toContain(`<${DASHBOARD}/dashboard/${GUILD}/alpha>`);
    expect(said(reply)).toContain('the switch at the top of the page');
  });

  test('a redelivered press is refused under the same key, so Discord hears it once', async () => {
    const manifest = pressModule([]);
    const { runtime, executor } = runtimeFor(manifest, OFF);

    await runtime.handleFor(manifest, press('proton:alpha:go'));
    await runtime.handleFor(manifest, press('proton:alpha:go'));

    expect(new Set(executor.requests.map((r) => r.idempotencyKey)).size).toBe(1);
  });

  test('a select menu and a form are named for what they are', async () => {
    const manifest = pressModule([]);
    const { runtime, executor } = runtimeFor(manifest, OFF);

    await runtime.handleFor(manifest, press('proton:alpha:pick', 3));
    await runtime.handleFor(manifest, submit('proton:alpha:form'));

    expect(said(executor.requests[0])).toContain('so this menu doesn’t work');
    expect(said(executor.requests[1])).toContain('so this form doesn’t work');
    expect(executor.requests[1]?.idempotencyKey).toBe(
      `interaction.modal:${INTERACTION}:module-disabled`,
    );
  });

  test('a module with no settings page points at its card on the overview', async () => {
    const manifest = pressModule([], { settingsPage: false });
    const { runtime, executor } = runtimeFor(manifest, OFF);

    await runtime.handleFor(manifest, press('proton:alpha:go'));

    expect(said(executor.requests[0])).toContain(`<${DASHBOARD}/dashboard/${GUILD}>`);
    expect(said(executor.requests[0])).toContain('the switch on the **Alpha** card');
  });

  test('without a dashboard address the link falls back to the default one', async () => {
    const manifest = pressModule([]);
    const { runtime, executor } = runtimeFor(manifest, OFF, null);

    await runtime.handleFor(manifest, press('proton:alpha:go'));

    expect(said(executor.requests[0])).toContain(
      `<http://localhost:3000/dashboard/${GUILD}/alpha>`,
    );
  });

  test('a press that belongs to another module, or to nobody, is left to its owner', async () => {
    const manifest = pressModule([]);
    const { runtime, executor } = runtimeFor(manifest, OFF);

    await runtime.handleFor(manifest, press('proton:tickets:ot'));
    await runtime.handleFor(manifest, press('someone-elses-button'));
    await runtime.handleFor(manifest, press('simulation:inert:go'));

    expect(executor.requests).toEqual([]);
  });

  test('an event that is not a press is still dropped without a word', async () => {
    const seen: Seen[] = [];
    const manifest = pressModule(seen);
    const { runtime, executor, logs } = runtimeFor(manifest, OFF);

    await runtime.handleFor(manifest, event('message.created'));

    expect(seen).toEqual([]);
    expect(executor.requests).toEqual([]);
    expect(logs).toEqual([]);
  });

  test('typing into an option of its own command gets an empty list rather than a spinner', async () => {
    const manifest = pressModule([]);
    const { runtime, executor } = runtimeFor(manifest, OFF);

    await runtime.handleFor(manifest, typing('apply'));
    await runtime.handleFor(manifest, typing('ticket'));

    expect(executor.requests).toHaveLength(1);
    expect(executor.requests[0]?.payload).toMatchObject({ callbackType: 8, choices: [] });
    expect(executor.requests[0]?.idempotencyKey).toBe(
      `interaction.autocomplete:${INTERACTION}:module-disabled`,
    );
  });

  test('settings that no longer parse are named to the presser, and the handler never runs', async () => {
    const seen: Seen[] = [];
    const manifest = pressModule(seen);
    const { runtime, executor, logs } = runtimeFor(manifest, BROKEN);

    await runtime.handleFor(manifest, press('proton:alpha:go'));

    expect(seen).toEqual([]);
    expect(logs[0]?.message).toContain('invalid stored config for alpha');

    const reply = executor.requests[0];
    expect(reply?.idempotencyKey).toBe(`interaction.component:${INTERACTION}:config-invalid`);
    expect(said(reply)).toContain('**Alpha** settings aren’t valid, so this button didn’t work');
    expect(said(reply)).toContain('enabled');
    expect(said(reply)).toContain(`<${DASHBOARD}/dashboard/${GUILD}/alpha>`);
  });

  test('broken settings on a module with no settings page are put down to Proton', async () => {
    const manifest = pressModule([], { settingsPage: false });
    const { runtime, executor } = runtimeFor(manifest, BROKEN);

    await runtime.handleFor(manifest, press('proton:alpha:go'));

    expect(said(executor.requests[0])).toContain('the problem is on my end');
    expect(said(executor.requests[0])).not.toContain('/dashboard/');
  });

  test('no refusal a member can read carries an em dash', async () => {
    const manifest = pressModule([]);
    const off = runtimeFor(manifest, OFF);
    const broken = runtimeFor(manifest, BROKEN);

    await off.runtime.handleFor(manifest, press('proton:alpha:go'));
    await broken.runtime.handleFor(manifest, press('proton:alpha:go'));

    for (const request of [...off.executor.requests, ...broken.executor.requests]) {
      expect(said(request)).not.toContain('—');
    }
  });
});

describe('config failures are triaged, not treated alike', () => {
  test('a permanent 4xx is logged with a remedy and the event is acked', async () => {
    const manifest = testModule({ id: 'alpha', types: ['message.created'], seen: [] });
    const { runtime, logs } = build([manifest], {
      async get(guildId, moduleId) {
        throw new ConfigUnavailableError({
          message: `api returned 400 for ${moduleId} in ${guildId}`,
          permanent: true,
          status: 400,
          guildId,
          moduleId,
        });
      },
    });

    await runtime.handleFor(manifest, event('message.created'));

    expect(logs[0]?.level).toBe('error');
    expect(logs[0]?.message).toContain('retrying will not help');
    expect(logs[0]?.message).toContain('save them once');
  });

  test('a transient failure rethrows, so the event is retried', async () => {
    const manifest = testModule({ id: 'alpha', types: ['message.created'], seen: [] });
    const { runtime } = build([manifest], {
      async get(guildId, moduleId) {
        throw new ConfigUnavailableError({
          message: 'api returned 503',
          permanent: false,
          status: 503,
          guildId,
          moduleId,
        });
      },
    });

    await expect(runtime.handleFor(manifest, event('message.created'))).rejects.toThrow('503');
  });

  test('an untyped error is treated as transient rather than swallowed', async () => {
    const manifest = testModule({ id: 'alpha', types: ['message.created'], seen: [] });
    const { runtime } = build([manifest], {
      async get() {
        throw new Error('something nobody anticipated');
      },
    });

    await expect(runtime.handleFor(manifest, event('message.created'))).rejects.toThrow(
      'something nobody anticipated',
    );
  });
});
