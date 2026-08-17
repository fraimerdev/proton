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
  type ProtonEvent,
  type SubscribeOptions,
} from '@proton/core';
import { z } from 'zod';
import { ConfigUnavailableError } from '../src/config-provider.ts';
import { listenerGroup, ModuleListenerRuntime, subscribedTypes } from '../src/listener-runtime.ts';
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

  test('a module switched off still hears about it, so it can undo what it owns', async () => {
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

  test('a throwing listener propagates, so the bus redelivers', async () => {
    const seen: Seen[] = [];
    const manifest = testModule({ id: 'alpha', types: ['message.created'], seen, throws: true });
    const { runtime } = build([manifest], enabled);

    await expect(runtime.handleFor(manifest, event('message.created'))).rejects.toThrow(
      'alpha exploded',
    );
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
