import { describe, expect, test } from 'bun:test';
import {
  type ActionExecutor,
  type ActionRequest,
  type ActionResult,
  type ModuleManifest,
  ModuleRegistry,
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
