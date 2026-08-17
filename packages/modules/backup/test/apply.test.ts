import { describe, expect, test } from 'bun:test';
import type {
  ActionExecutor,
  ActionRequest,
  ActionResult,
  CommandContext,
  Logger,
} from '@proton/core';
import { applyRestore } from '../src/apply.ts';
import type { BackupConfig } from '../src/config.ts';
import type { RestoreOp } from '../src/restore.ts';

const GUILD = '900000000000000001';
const OLD_CATEGORY = '500000000000000010';
const NEW_CATEGORY = '600000000000000010';

class FakeExecutor implements ActionExecutor {
  readonly requests: ActionRequest[] = [];
  results: ActionResult[] = [];
  fallback: ActionResult = { status: 'executed', caseId: 'c' };

  async execute(request: ActionRequest): Promise<ActionResult> {
    this.requests.push(request);
    return this.results.shift() ?? this.fallback;
  }
}

const silent: Logger = { info: () => {}, warn: () => {}, error: () => {} };

function ctx(): CommandContext<BackupConfig> {
  return {
    guildId: GUILD,
    channelId: '500000000000000001',
    userId: '100000000000000001',
    config: {} as BackupConfig,
    executor: new FakeExecutor(),
    logger: silent,
    options: {} as CommandContext<BackupConfig>['options'],
    interaction: { id: '1', token: 't' },
    idempotencyKey: 'k',
  };
}

function role(name: string): RestoreOp {
  return {
    op: 'create_role',
    role: {
      id: '700000000000000001',
      name,
      permissions: '0',
      position: 1,
      color: 0,
      hoist: false,
      mentionable: false,
      managed: false,
    },
  };
}

function channel(overrides: Record<string, unknown> = {}): RestoreOp {
  return {
    op: 'create_channel',
    channel: {
      id: '500000000000000002',
      type: 0,
      position: 1,
      parentId: null,
      obfuscated: false,
      name: 'general',
      topic: null,
      nsfw: null,
      rateLimitPerUser: null,
      bitrate: null,
      userLimit: null,
      overwrites: [],
      ...overrides,
    },
  } as RestoreOp;
}

describe('applyRestore', () => {
  test('creates roles and channels through the executor', async () => {
    const executor = new FakeExecutor();

    const applied = await applyRestore(ctx(), executor, 'b1', [role('Mod'), channel()]);

    expect(applied.createdRoles).toBe(1);
    expect(applied.createdChannels).toBe(1);
    expect(applied.failures).toEqual([]);
    expect(executor.requests.map((r) => r.kind)).toEqual(['create_role', 'create_channel']);
  });

  test('roles are created before any channel', async () => {
    const executor = new FakeExecutor();

    await applyRestore(ctx(), executor, 'b1', [channel(), role('Mod')]);

    expect(executor.requests[0]?.kind).toBe('create_role');
  });

  test('categories are created before the channels inside them', async () => {
    const executor = new FakeExecutor();
    const category = channel({ id: OLD_CATEGORY, type: 4, name: 'Text' });
    const child = channel({ parentId: OLD_CATEGORY, name: 'general' });

    await applyRestore(ctx(), executor, 'b1', [child, category]);

    const names = executor.requests.map((r) => (r.payload as { name: string }).name);
    expect(names).toEqual(['Text', 'general']);
  });

  /**
   * The snapshot's parentId is the id the category had before it was deleted. Passing it through
   * unchanged would parent the channel to something that no longer exists.
   */
  test('children are re-parented to the newly created category', async () => {
    const executor = new FakeExecutor();
    executor.results = [
      { status: 'executed', caseId: 'c', body: { id: NEW_CATEGORY } },
      { status: 'executed', caseId: 'c', body: { id: '600000000000000011' } },
    ];

    await applyRestore(ctx(), executor, 'b1', [
      channel({ id: OLD_CATEGORY, type: 4, name: 'Text' }),
      channel({ parentId: OLD_CATEGORY, name: 'general' }),
    ]);

    const child = executor.requests[1]?.payload as { parentId?: string };
    expect(child.parentId).toBe(NEW_CATEGORY);
  });

  test('a category whose id Discord withheld is reported, not silently flattened', async () => {
    const executor = new FakeExecutor();
    executor.results = [{ status: 'executed', caseId: 'c' }];

    const applied = await applyRestore(ctx(), executor, 'b1', [
      channel({ id: OLD_CATEGORY, type: 4, name: 'Text' }),
    ]);

    expect(applied.failures.join(' ')).toContain('top level');
  });

  test('a refusal is reported with the executor’s own reason and does not stop the rest', async () => {
    const executor = new FakeExecutor();
    executor.results = [
      { status: 'failed_precheck', failure: { code: 'x', humanReason: 'no Manage Roles here.' } },
    ];

    const applied = await applyRestore(ctx(), executor, 'b1', [role('Mod'), channel()]);

    expect(applied.createdRoles).toBe(0);
    expect(applied.createdChannels).toBe(1);
    expect(applied.failures.join(' ')).toContain('no Manage Roles here.');
  });

  test('an unreadable channel name is skipped rather than sent as null', async () => {
    const executor = new FakeExecutor();

    const applied = await applyRestore(ctx(), executor, 'b1', [channel({ name: null })]);

    expect(executor.requests).toEqual([]);
    expect(applied.failures).toHaveLength(1);
  });

  /** Re-running the same restore must not double every channel (I4). */
  test('the same op in the same backup reuses its idempotency key', async () => {
    const first = new FakeExecutor();
    const second = new FakeExecutor();

    await applyRestore(ctx(), first, 'b1', [role('Mod')]);
    await applyRestore(ctx(), second, 'b1', [role('Mod')]);

    expect(first.requests[0]?.idempotencyKey).toBe(second.requests[0]?.idempotencyKey ?? '');
  });

  test('a different backup gets a different key', async () => {
    const first = new FakeExecutor();
    const second = new FakeExecutor();

    await applyRestore(ctx(), first, 'b1', [role('Mod')]);
    await applyRestore(ctx(), second, 'b2', [role('Mod')]);

    expect(first.requests[0]?.idempotencyKey).not.toBe(second.requests[0]?.idempotencyKey);
  });

  /** A restore is the invoker's decision, so it is never withheld by the I12 dev rail. */
  test('restore ops are never dry-run', async () => {
    const executor = new FakeExecutor();

    await applyRestore(ctx(), executor, 'b1', [role('Mod'), channel()]);

    expect(executor.requests.every((r) => r.dryRun === false)).toBe(true);
  });
});
