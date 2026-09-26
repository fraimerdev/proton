import { describe, expect, test } from 'bun:test';
import {
  type ActionExecutor,
  type ActionFailure,
  type ActionRequest,
  type ActionResult,
  isScopedActionExecutor,
  type ModuleManifest,
  ModuleRegistry,
  type ScopedActionExecutor,
} from '@proton/core';
import { z } from 'zod';
import { moduleExecutor, UndeclaredActionError } from '../src/module-actions.ts';

const GUILD = '900000000000000001';

function recording(): { executor: ActionExecutor; requests: ActionRequest[] } {
  const requests: ActionRequest[] = [];
  return {
    requests,
    executor: {
      async execute(request): Promise<ActionResult> {
        requests.push(request);
        return { status: 'executed' };
      },
    },
  };
}

function manifest(overrides: Partial<ModuleManifest> = {}): ModuleManifest {
  return {
    id: 'starboard',
    name: 'Starboard',
    category: 'engagement',
    configSchema: z.object({ enabled: z.boolean().default(true) }),
    defaultConfig: { enabled: true },
    schemaVersion: 1,
    requiredIntents: [],
    requiredPermissions: [],
    ...overrides,
  } as ModuleManifest;
}

function request(kind: ActionRequest['kind']): ActionRequest {
  return {
    guildId: GUILD,
    moduleId: 'starboard',
    kind,
    actorId: 'starboard',
    dryRun: false,
    idempotencyKey: `${GUILD}:1`,
  };
}

describe('the module executor', () => {
  test('passes through a kind the manifest declares', async () => {
    const registry = new ModuleRegistry();
    registry.register(manifest({ actionKinds: ['send'] }));
    const { executor, requests } = recording();

    await moduleExecutor(registry, 'starboard', executor).execute(request('send'));

    expect(requests.map((r) => r.kind)).toEqual(['send']);
  });

  test('refuses a kind the manifest does not declare, naming the module and the kind', async () => {
    const registry = new ModuleRegistry();
    registry.register(manifest({ actionKinds: ['send'] }));
    const { executor, requests } = recording();

    const guarded = moduleExecutor(registry, 'starboard', executor);

    expect(() => guarded.execute(request('delete_message'))).toThrow(UndeclaredActionError);
    expect(() => guarded.execute(request('delete_message'))).toThrow(/starboard/);
    expect(() => guarded.execute(request('delete_message'))).toThrow(/delete_message/);
    expect(() => guarded.execute(request('delete_message'))).toThrow(/actionKinds/);
    expect(requests).toEqual([]);
  });

  test('refuses everything from a module that declares no kinds at all', () => {
    const registry = new ModuleRegistry();
    registry.register(manifest());

    expect(() =>
      moduleExecutor(registry, 'starboard', recording().executor).execute(request('send')),
    ).toThrow(UndeclaredActionError);
  });

  test('refuses a module the registry has never heard of', () => {
    expect(() =>
      moduleExecutor(new ModuleRegistry(), 'ghost', recording().executor).execute(request('send')),
    ).toThrow(UndeclaredActionError);
  });
});

function prechecking(failure: ActionFailure | null): {
  executor: ScopedActionExecutor;
  prechecked: ActionRequest[];
  scopedWith: unknown[];
} {
  const prechecked: ActionRequest[] = [];
  const scopedWith: unknown[] = [];

  const executor: ScopedActionExecutor = {
    async execute(): Promise<ActionResult> {
      return { status: 'executed' };
    },
    async precheck(request) {
      prechecked.push(request);
      return failure;
    },
    scoped(hints) {
      scopedWith.push(hints);
      return executor;
    },
  };

  return { executor, prechecked, scopedWith };
}

describe('the module executor’s precheck', () => {
  const REFUSED: ActionFailure = { code: 'missing_permission', humanReason: 'no' };

  test('is forwarded for a declared kind, answer and all', async () => {
    const registry = new ModuleRegistry();
    registry.register(manifest({ actionKinds: ['ban'] }));
    const { executor, prechecked } = prechecking(REFUSED);

    const answer = await moduleExecutor(registry, 'starboard', executor).precheck?.(request('ban'));

    expect(answer).toEqual(REFUSED);
    expect(prechecked.map((r) => r.kind)).toEqual(['ban']);
  });

  test('refuses an undeclared kind exactly as execute does', () => {
    const registry = new ModuleRegistry();
    registry.register(manifest({ actionKinds: ['send'] }));
    const { executor, prechecked } = prechecking(null);

    const guarded = moduleExecutor(registry, 'starboard', executor);

    expect(() => guarded.precheck?.(request('ban'))).toThrow(UndeclaredActionError);
    expect(prechecked).toEqual([]);
  });

  test('survives scoping, which is how a module hands over its target hints', async () => {
    const registry = new ModuleRegistry();
    registry.register(manifest({ actionKinds: ['ban'] }));
    const { executor, prechecked, scopedWith } = prechecking(null);

    const scoped = moduleExecutor(registry, 'starboard', executor);
    if (!isScopedActionExecutor(scoped)) throw new Error('expected a scoped executor');
    const hinted = scoped.scoped({ targetAbsent: true, targetRoleIds: [] });

    expect(await hinted.precheck?.(request('ban'))).toBeNull();
    expect(scopedWith).toEqual([{ targetAbsent: true, targetRoleIds: [] }]);
    expect(prechecked).toHaveLength(1);
  });

  test('is absent when the executor it wraps has none, rather than passing everything', () => {
    const registry = new ModuleRegistry();
    registry.register(manifest({ actionKinds: ['ban'] }));

    expect(moduleExecutor(registry, 'starboard', recording().executor).precheck).toBeUndefined();
  });
});
