import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import {
  type ActionExecutor,
  type ActionRequest,
  type ActionResult,
  type EventType,
  type Logger,
  type ModuleContext,
  type ModuleManifest,
  ModuleRegistry,
  Permissions,
  type ProtonEvent,
  RedisRateWindow,
  RedisStreamsEventBus,
} from '@proton/core';
import { dispatchSequence } from '@proton/fixtures';
import { normalise } from '@proton/gateway/normaliser';
import { createAntinukeModule, RedisMaintenanceStore } from '@proton/module-antinuke';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import Redis from 'ioredis';
import { z } from 'zod';
import { CachingConfigProvider } from '../src/config-provider.ts';
import { ModuleListenerRuntime } from '../src/listener-runtime.ts';
import type { ConfigProvider } from '../src/runtime.ts';

let container: StartedRedisContainer;
let redis: Redis;

beforeAll(async () => {
  container = await new RedisContainer('redis:7-alpine').start();
  redis = new Redis(container.getConnectionUrl());
}, 240_000);

afterAll(async () => {
  redis?.disconnect();
  await container?.stop();
}, 240_000);

beforeEach(async () => {
  await redis.flushall();
});

const GUILD = '900000000000000001';
const BOT = '300000000000000001';
const NUKER = '200000000000000009';
const OWNER = '200000000000000001';
const HIGH_ROLE = '410000000000000004';
const LOW_ROLE = '410000000000000002';

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (await predicate()) return;
    } catch {}
    await Bun.sleep(25);
  }
  throw new Error('waitFor timed out');
}

function burst(): ProtonEvent[] {
  return dispatchSequence('auditLogChannelDeleteBurst').map((raw) => {
    const event = normalise(raw);
    if (!event) throw new Error(`the normaliser produced nothing for ${raw.t}`);
    return event;
  });
}

function recordingExecutor(): { executor: ActionExecutor; requests: ActionRequest[] } {
  const requests: ActionRequest[] = [];
  return {
    requests,
    executor: {
      execute: async (request: ActionRequest): Promise<ActionResult> => {
        requests.push(request);
        return { status: 'executed', caseId: 'case-1' };
      },
    },
  };
}

function silent(): { logger: Logger; logs: string[] } {
  const logs: string[] = [];
  return {
    logs,
    logger: {
      info: (m) => logs.push(m),
      warn: (m) => logs.push(m),
      error: (m) => logs.push(m),
    },
  };
}

function antinuke(): ModuleManifest {
  return createAntinukeModule({
    rateWindow: new RedisRateWindow(redis),
    maintenance: new RedisMaintenanceStore(redis),
    guildState: {
      get: async () => ({
        guildId: GUILD,
        ownerId: OWNER,
        everyoneRoleId: GUILD,
        roles: new Map([
          [GUILD, { id: GUILD, permissions: 0n, position: 0 }],
          [LOW_ROLE, { id: LOW_ROLE, permissions: 0n, position: 2 }],
          [HIGH_ROLE, { id: HIGH_ROLE, permissions: 0n, position: 4 }],
        ]),
        botRoleIds: [],
        channels: new Map(),
        updatedAt: Date.now(),
      }),
      put: async () => undefined,
      patch: async () => undefined,
      delete: async () => undefined,
    },
    fetchMemberRoles: async () => [GUILD, LOW_ROLE, HIGH_ROLE],
    botUserId: BOT,
  }) as unknown as ModuleManifest;
}

const enabledConfig: ConfigProvider = {
  async get(_guildId, moduleId) {
    if (moduleId === 'antinuke') {
      return { enabled: true, config: { ...createAntinukeModule().defaultConfig, enabled: true } };
    }
    return { enabled: true, config: {} };
  },
};

describe('Gate 2: the 20-deletion burst reaches the breaker through the bus', () => {
  test('publishing the fixture trips the breaker, strip-first, exactly once', async () => {
    const bus = new RedisStreamsEventBus(redis, { blockMs: 50, claimIdleMs: 30_000 });
    const { executor, requests } = recordingExecutor();
    const { logger } = silent();

    const registry = new ModuleRegistry();
    registry.register(antinuke());

    const runtime = new ModuleListenerRuntime({
      bus,
      registry,
      executor,
      config: new CachingConfigProvider(enabledConfig, { ttlMs: 5_000 }),
      logger,
    });

    const subscriptions = runtime.start();

    await Promise.all(subscriptions.map((s) => s.ready));

    for (const event of burst()) await bus.publish(event);

    await waitFor(() => requests.length >= 2);

    await Bun.sleep(500);

    const strips = requests.filter((r) => r.kind === 'remove_role');
    expect(strips).toHaveLength(2);

    expect(new Set(strips.map((r) => r.targetId))).toEqual(new Set([NUKER]));
    expect(strips.map((r) => (r.payload as { roleId: string }).roleId)).toEqual([
      HIGH_ROLE,
      LOW_ROLE,
    ]);

    expect(strips.some((r) => (r.payload as { roleId: string }).roleId === GUILD)).toBe(false);

    await Promise.all(subscriptions.map((s) => s.close()));
    await bus.close();
  }, 120_000);

  test('maintenance mode suppresses the whole burst end to end', async () => {
    const bus = new RedisStreamsEventBus(redis, { blockMs: 50, claimIdleMs: 30_000 });
    const { executor, requests } = recordingExecutor();
    const { logger } = silent();

    const events = burst();
    const start = events[0]?.occurredAt ?? Date.now();
    await new RedisMaintenanceStore(redis, { now: () => start }).set({
      guildId: GUILD,
      enabledBy: OWNER,
      reason: 'moving twenty channels',
      startedAt: start - 60_000,
      expiresAt: start + 60_000,
    });

    const registry = new ModuleRegistry();
    registry.register(antinuke());

    const runtime = new ModuleListenerRuntime({
      bus,
      registry,
      executor,
      config: new CachingConfigProvider(enabledConfig, { ttlMs: 5_000 }),
      logger,
    });

    const subscriptions = runtime.start();
    await Promise.all(subscriptions.map((s) => s.ready));

    for (const event of events) await bus.publish(event);
    await Bun.sleep(1_500);

    expect(requests).toEqual([]);

    expect(await redis.keys('proton:rate:*')).toEqual([]);

    await Promise.all(subscriptions.map((s) => s.close()));
    await bus.close();
  }, 120_000);
});

const probeSchema = z.object({ enabled: z.boolean() });

function probeModule(id: string, seen: string[], throws = false): ModuleManifest {
  return {
    id,
    name: id,
    category: 'security',
    configSchema: probeSchema,
    defaultConfig: { enabled: true },
    schemaVersion: 1,
    requiredIntents: [],
    requiredPermissions: [Permissions.ViewChannel],
    listeners: [
      {
        types: ['channel.deleted'] as EventType[],
        async handler(event: ProtonEvent, _ctx: ModuleContext) {
          seen.push(`${id}:${event.id}`);
          if (throws) throw new Error(`${id} exploded`);
        },
      },
    ],
    migrations: [],
  } as unknown as ModuleManifest;
}

describe('per-module consumer groups isolate failure', () => {
  test('a throwing module is retried without its healthy peer being re-run', async () => {
    const bus = new RedisStreamsEventBus(redis, { blockMs: 50, claimIdleMs: 400 });
    const { executor } = recordingExecutor();
    const { logger } = silent();

    const healthy: string[] = [];
    const broken: string[] = [];

    const registry = new ModuleRegistry();
    registry.register(probeModule('healthy', healthy));
    registry.register(probeModule('broken', broken, true));

    const runtime = new ModuleListenerRuntime({
      bus,
      registry,
      executor,
      config: {
        async get() {
          return { enabled: true, config: { enabled: true } };
        },
      },
      logger,
    });

    const subscriptions = runtime.start();
    await Promise.all(subscriptions.map((s) => s.ready));

    const event = burst()[0] as ProtonEvent;
    await bus.publish(event);

    await waitFor(() => broken.length >= 2, 20_000);

    expect(healthy).toEqual([`healthy:${event.id}`]);
    expect(broken.length).toBeGreaterThanOrEqual(2);

    await Promise.all(subscriptions.map((s) => s.close()));
    await bus.close();
  }, 120_000);

  test('each listening module gets its own group, named for it', async () => {
    const bus = new RedisStreamsEventBus(redis, { blockMs: 50 });
    const { executor } = recordingExecutor();
    const { logger } = silent();

    const registry = new ModuleRegistry();
    registry.register(probeModule('alpha', []));
    registry.register(probeModule('beta', []));

    const runtime = new ModuleListenerRuntime({
      bus,
      registry,
      executor,
      config: {
        async get() {
          return { enabled: true, config: { enabled: true } };
        },
      },
      logger,
    });

    const subscriptions = runtime.start();
    await waitFor(async () => {
      const groups = (await redis.xinfo('GROUPS', 'proton:events:channel.deleted')) as unknown[];
      return groups.length >= 2;
    });

    const groups = (await redis.xinfo('GROUPS', 'proton:events:channel.deleted')) as Array<
      unknown[]
    >;
    const names = groups.map((g) => String(g[1])).sort();
    expect(names).toEqual(['listener:alpha', 'listener:beta']);

    await Promise.all(subscriptions.map((s) => s.close()));
    await bus.close();
  }, 120_000);

  test('a newly created listener group does not see events published before it', async () => {
    const bus = new RedisStreamsEventBus(redis, { blockMs: 50 });
    const { executor } = recordingExecutor();
    const { logger } = silent();

    for (const event of burst()) await bus.publish(event);

    const seen: string[] = [];
    const registry = new ModuleRegistry();
    registry.register(probeModule('latecomer', seen));

    const runtime = new ModuleListenerRuntime({
      bus,
      registry,
      executor,
      config: {
        async get() {
          return { enabled: true, config: { enabled: true } };
        },
      },
      logger,
    });

    const subscriptions = runtime.start();
    await Bun.sleep(1_000);

    expect(seen).toEqual([]);

    await Promise.all(subscriptions.map((s) => s.close()));
    await bus.close();
  }, 120_000);
});

describe('config reads are collapsed across a burst', () => {
  test('the twenty-event burst costs one config read per module', async () => {
    const bus = new RedisStreamsEventBus(redis, { blockMs: 50 });
    const { executor } = recordingExecutor();
    const { logger } = silent();

    let reads = 0;
    const counting: ConfigProvider = {
      async get() {
        reads += 1;
        return { enabled: true, config: { enabled: true } };
      },
    };

    const seen: string[] = [];
    const registry = new ModuleRegistry();
    registry.register(probeModule('counter', seen));

    const runtime = new ModuleListenerRuntime({
      bus,
      registry,
      executor,
      config: new CachingConfigProvider(counting, { ttlMs: 30_000 }),
      logger,
    });

    const subscriptions = runtime.start();
    await Promise.all(subscriptions.map((s) => s.ready));

    for (const event of burst()) await bus.publish(event);
    await waitFor(() => seen.length === 20);

    expect(reads).toBe(1);

    await Promise.all(subscriptions.map((s) => s.close()));
    await bus.close();
  }, 120_000);
});
