import { describe, expect, test } from 'bun:test';
import {
  type CaseInput,
  type CaseRecorder,
  type DedupeStore,
  DefaultActionExecutor,
  type EventBus,
  type Logger,
  ModuleRegistry,
  newId,
  Permissions,
  type ProtonEvent,
  type RestProxyClient,
  type RestRequestOptions,
  type RestResponse,
  requiredPermissionsFor,
} from '@proton/core';
import { dispatch } from '@proton/fixtures';
import { normalise } from '@proton/gateway/normaliser';
import { permissionsModule } from '@proton/module-permissions';
import { pingDefaultConfig, pingModule } from '@proton/module-ping';
import { type ConfigProvider, ModuleRuntime } from '../src/runtime.ts';

const CHANNEL = '500000000000000001';
const OWNER = '200000000000000001';
const BOT = '1200000000000000001';

const MEMBER_ROLE = '400000000000000001';

const MOD_ROLE = '410000000000000009';

class MemoryDedupe implements DedupeStore {
  readonly #claimed = new Set<string>();

  async claim(key: string): Promise<boolean> {
    if (this.#claimed.has(key)) return false;
    this.#claimed.add(key);
    return true;
  }

  async release(key: string): Promise<void> {
    this.#claimed.delete(key);
  }

  async has(key: string): Promise<boolean> {
    return this.#claimed.has(key);
  }
}

class MemoryRecorder implements CaseRecorder {
  readonly recorded: CaseInput[] = [];

  async record(input: CaseInput): Promise<{ caseId: string }> {
    this.recorded.push(input);
    return { caseId: newId() };
  }
}

class FakeRest implements RestProxyClient {
  readonly calls: RestRequestOptions[] = [];

  async request(options: RestRequestOptions): Promise<RestResponse> {
    this.calls.push(options);
    return { status: 200, body: {} };
  }
}

const bus: EventBus = {
  publish: async () => undefined,
  subscribe: (group) => ({ group, close: async () => undefined }),
};

interface Options {
  overrides?: Record<string, string[]>;

  permissionsEnabled?: boolean;

  brokenConfig?: boolean;
}

function harness(options: Options = {}) {
  const rest = new FakeRest();
  const logs: Array<{ level: string; message: string }> = [];
  const logger: Logger = {
    info: (message) => logs.push({ level: 'info', message }),
    warn: (message) => logs.push({ level: 'warn', message }),
    error: (message) => logs.push({ level: 'error', message }),
  };

  const registry = new ModuleRegistry();
  registry.register(pingModule);
  registry.register(permissionsModule);

  const config: ConfigProvider = {
    async get(_guildId, moduleId) {
      if (moduleId === 'permissions') {
        return {
          enabled: options.permissionsEnabled ?? true,
          config: options.brokenConfig
            ? { enabled: true, overrides: { ban: 'the mod role' } }
            : { enabled: true, overrides: options.overrides ?? {} },
        };
      }
      return { enabled: true, config: pingDefaultConfig };
    },
  };

  const executor = new DefaultActionExecutor({
    dedupe: new MemoryDedupe(),
    rest,
    recorder: new MemoryRecorder(),

    resolveContext: async (request) => ({
      guildId: request.guildId,
      guildOwnerId: OWNER,
      botUserId: BOT,
      botHighestRolePosition: 10,
      botChannelPermissions: Permissions.ViewChannel | Permissions.SendMessages,
      requiredPermissions: requiredPermissionsFor(request.kind),
      channelId: CHANNEL,
    }),
  });

  const runtime = new ModuleRuntime({ bus, registry, executor, config, logger });

  return {
    rest,
    logs,

    replyContent(): string | null {
      const call = rest.calls.find((c) => c.path.startsWith('/interactions/'));
      const body = call?.body as { data?: { content?: string; flags?: number } } | undefined;
      return body?.data?.content ?? null;
    },
    replyFlags(): number | undefined {
      const call = rest.calls.find((c) => c.path.startsWith('/interactions/'));
      return (call?.body as { data?: { flags?: number } } | undefined)?.data?.flags;
    },
    run: (event: ProtonEvent) => runtime.handle(event),
  };
}

function pingBy(roleIds: string[]): ProtonEvent {
  const raw = dispatch('interactionCreatePing');
  (raw.d.member as { roles: string[] }).roles = roleIds;

  const event = normalise(raw)[0];
  if (!event) throw new Error('fixture did not normalise');
  return event;
}

describe('guild command overrides', () => {
  test('a command with no override runs as normal', async () => {
    const h = harness({ overrides: { kick: [MOD_ROLE] } });

    await h.run(pingBy([MEMBER_ROLE]));

    expect(h.replyContent()).toBe(pingDefaultConfig.response);
  });

  test('an override the member satisfies lets the command through', async () => {
    const h = harness({ overrides: { ping: [MOD_ROLE] } });

    await h.run(pingBy([MEMBER_ROLE, MOD_ROLE]));

    expect(h.replyContent()).toBe(pingDefaultConfig.response);
  });

  test('an override the member lacks refuses the command and names the role', async () => {
    const h = harness({ overrides: { ping: [MOD_ROLE] } });

    await h.run(pingBy([MEMBER_ROLE]));

    const reply = h.replyContent();
    expect(reply).not.toBe(pingDefaultConfig.response);
    expect(reply).toContain(`<@&${MOD_ROLE}>`);
    expect(reply).toContain(MOD_ROLE);
    expect(reply).toContain('/ping');

    expect(h.replyFlags()).toBe(64);

    expect(h.rest.calls).toHaveLength(1);
    expect(
      h.logs.some((l) => l.level === 'warn' && l.message.includes('missing_required_role')),
    ).toBe(true);
  });

  test('a redelivered refusal is sent once', async () => {
    const h = harness({ overrides: { ping: [MOD_ROLE] } });
    const event = pingBy([MEMBER_ROLE]);

    await h.run(event);
    await h.run(event);

    expect(h.rest.calls).toHaveLength(1);
  });

  test('switching the module off in a guild stops it enforcing anything', async () => {
    const h = harness({ overrides: { ping: [MOD_ROLE] }, permissionsEnabled: false });

    await h.run(pingBy([MEMBER_ROLE]));

    expect(h.replyContent()).toBe(pingDefaultConfig.response);
  });

  test('an unreadable overrides config is reported, not enforced', async () => {
    const h = harness({ brokenConfig: true });

    await h.run(pingBy([MEMBER_ROLE]));

    expect(h.replyContent()).toBe(pingDefaultConfig.response);
    expect(h.logs.some((l) => l.level === 'error' && l.message.includes('NOT being applied'))).toBe(
      true,
    );
  });

  test('a runtime without the permissions module dispatches as before', async () => {
    const rest = new FakeRest();
    const registry = new ModuleRegistry();
    registry.register(pingModule);

    const runtime = new ModuleRuntime({
      bus,
      registry,
      executor: new DefaultActionExecutor({
        dedupe: new MemoryDedupe(),
        rest,
        recorder: new MemoryRecorder(),
        resolveContext: async (request) => ({
          guildId: request.guildId,
          guildOwnerId: OWNER,
          botUserId: BOT,
          botHighestRolePosition: 10,
          botChannelPermissions: Permissions.ViewChannel | Permissions.SendMessages,
          requiredPermissions: requiredPermissionsFor(request.kind),
          channelId: CHANNEL,
        }),
      }),
      config: {
        get: async (_guildId, moduleId) => {
          if (moduleId === 'permissions') throw new Error('the API would 404 here');
          return { enabled: true, config: pingDefaultConfig };
        },
      },
      logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
    });

    await runtime.handle(pingBy([MEMBER_ROLE]));

    const body = rest.calls[0]?.body as { data?: { content?: string } } | undefined;
    expect(body?.data?.content).toBe(pingDefaultConfig.response);
  });
});
