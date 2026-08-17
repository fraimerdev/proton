import { describe, expect, test } from 'bun:test';
import type {
  ActionExecutor,
  ActionRequest,
  ActionResult,
  GuildRole,
  GuildState,
  Logger,
  ProtonEvent,
} from '@proton/core';
import { dispatch } from '@proton/fixtures';
import { normalise } from '@proton/gateway/normaliser';
import { type JoinrolesConfig, joinrolesConfigSchema } from '../src/config.ts';
import { createJoinRolesListener } from '../src/listeners.ts';
import type { StickyRoleStore } from '../src/store.ts';

const GUILD = '900000000000000001';
const MEMBER = '100000000000000002';

class FakeStore implements StickyRoleStore {
  readonly snapshots: Array<{ userId: string; roleIds: string[] }> = [];
  #recorded = new Map<string, string[]>();

  seed(userId: string, roleIds: string[]): void {
    this.#recorded.set(userId, roleIds);
  }

  async snapshot(_guildId: string, userId: string, roleIds: readonly string[]): Promise<void> {
    this.snapshots.push({ userId, roleIds: [...roleIds] });
    this.#recorded.set(userId, [...roleIds]);
  }

  async read(_guildId: string, userId: string): Promise<string[] | null> {
    return this.#recorded.get(userId) ?? null;
  }
}

class RecordingExecutor implements ActionExecutor {
  readonly requests: ActionRequest[] = [];
  result: ActionResult = { status: 'executed', caseId: 'case-1' };

  async execute(request: ActionRequest): Promise<ActionResult> {
    this.requests.push(request);
    return this.result;
  }
}

const silent: Logger = { info: () => {}, warn: () => {}, error: () => {} };

function collectingLogger(): { logger: Logger; lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    logger: {
      info: (m) => lines.push(m),
      warn: (m) => lines.push(m),
      error: (m) => lines.push(m),
    },
  };
}

function role(id: string, position: number): GuildRole {
  return { id, permissions: 0n, position };
}

const STATE: GuildState = {
  guildId: GUILD,
  ownerId: '100000000000000009',
  everyoneRoleId: GUILD,
  roles: new Map([
    [GUILD, role(GUILD, 0)],
    ['700000000000000001', role('700000000000000001', 10)],
    ['700000000000000002', role('700000000000000002', 20)],
    ['800000000000000001', role('800000000000000001', 50)],
  ]),
  botRoleIds: ['800000000000000001'],
  channels: new Map(),
  updatedAt: 0,
};

function config(overrides: Partial<JoinrolesConfig> = {}): JoinrolesConfig {
  return joinrolesConfigSchema.parse({ enabled: true, stickyEnabled: true, ...overrides });
}

function event(name: 'guildMemberUpdate' | 'guildMemberAdd'): ProtonEvent {
  const normalised = normalise(dispatch(name))[0];
  if (!normalised) throw new Error(`fixture ${name} did not normalise`);
  return normalised;
}

describe('sticky roles', () => {
  test('member.updated records the roles the member now holds', async () => {
    const store = new FakeStore();
    const listener = createJoinRolesListener({ store, guildState: { get: async () => STATE } });

    await listener.handler(event('guildMemberUpdate'), {
      guildId: GUILD,
      config: config(),
      executor: new RecordingExecutor(),
      logger: silent,
    });

    expect(store.snapshots).toHaveLength(1);
    expect(store.snapshots[0]?.roleIds).toEqual(['700000000000000001', '700000000000000002']);
  });

  test('an emptied role list is recorded, not ignored', async () => {
    const store = new FakeStore();
    store.seed(MEMBER, ['700000000000000001']);
    const listener = createJoinRolesListener({ store, guildState: { get: async () => STATE } });

    const stripped = event('guildMemberUpdate');
    (stripped.payload as Record<string, unknown>).roles = [];

    await listener.handler(stripped, {
      guildId: GUILD,
      config: config(),
      executor: new RecordingExecutor(),
      logger: silent,
    });

    expect(await store.read(GUILD, MEMBER)).toEqual([]);
  });

  test('member.joined restores what was recorded, through the executor', async () => {
    const store = new FakeStore();
    store.seed(MEMBER, ['700000000000000002', '700000000000000001']);
    const executor = new RecordingExecutor();
    const listener = createJoinRolesListener({ store, guildState: { get: async () => STATE } });

    await listener.handler(event('guildMemberAdd'), {
      guildId: GUILD,
      config: config(),
      executor,
      logger: silent,
    });

    expect(executor.requests).toHaveLength(2);
    expect(executor.requests.every((r) => r.kind === 'add_role')).toBe(true);

    expect(executor.requests.map((r) => (r.payload as { roleId: string }).roleId)).toEqual([
      '700000000000000001',
      '700000000000000002',
    ]);
  });

  test('a redelivered join reuses the same idempotency keys', async () => {
    const store = new FakeStore();
    store.seed(MEMBER, ['700000000000000001']);
    const executor = new RecordingExecutor();
    const listener = createJoinRolesListener({ store, guildState: { get: async () => STATE } });
    const ctx = {
      guildId: GUILD,
      config: config(),
      executor,
      logger: silent,
    };

    await listener.handler(event('guildMemberAdd'), ctx);
    await listener.handler(event('guildMemberAdd'), ctx);

    expect(executor.requests[0]?.idempotencyKey).toBe(executor.requests[1]?.idempotencyKey ?? '');
  });

  test('nothing recorded means nothing restored', async () => {
    const executor = new RecordingExecutor();
    const listener = createJoinRolesListener({
      store: new FakeStore(),
      guildState: { get: async () => STATE },
    });

    await listener.handler(event('guildMemberAdd'), {
      guildId: GUILD,
      config: config(),
      executor,
      logger: silent,
    });

    expect(executor.requests).toEqual([]);
  });

  test('disabled sticky roles neither record nor restore', async () => {
    const store = new FakeStore();
    store.seed(MEMBER, ['700000000000000001']);
    const executor = new RecordingExecutor();
    const listener = createJoinRolesListener({ store, guildState: { get: async () => STATE } });

    await listener.handler(event('guildMemberUpdate'), {
      guildId: GUILD,
      config: config({ stickyEnabled: false }),
      executor,
      logger: silent,
    });

    expect(store.snapshots).toEqual([]);
    expect(executor.requests).toEqual([]);
  });

  test('an unwired store is reported by name rather than going quiet', async () => {
    const { logger, lines } = collectingLogger();
    const listener = createJoinRolesListener({});

    await listener.handler(event('guildMemberUpdate'), {
      guildId: GUILD,
      config: config(),
      executor: new RecordingExecutor(),
      logger,
    });

    expect(lines.join(' ')).toContain('no role store is wired');
  });

  test('a refused grant is logged with the executor’s own reason', async () => {
    const store = new FakeStore();
    store.seed(MEMBER, ['700000000000000001']);
    const executor = new RecordingExecutor();
    executor.result = {
      status: 'failed_precheck',
      failure: { code: 'role_hierarchy', humanReason: 'that role sits above mine.' },
    };
    const { logger, lines } = collectingLogger();
    const listener = createJoinRolesListener({ store, guildState: { get: async () => STATE } });

    await listener.handler(event('guildMemberAdd'), {
      guildId: GUILD,
      config: config(),
      executor,
      logger,
    });

    expect(lines.join(' ')).toContain('that role sits above mine.');
  });
});
