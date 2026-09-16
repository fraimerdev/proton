import { describe, expect, test } from 'bun:test';
import { GatewayIntentBits } from 'discord-api-types/v10';
import { z } from 'zod';
import type { ModuleManifest } from '../../src/modules/manifest.ts';
import { ModuleRegistrationError, ModuleRegistry } from '../../src/modules/registry.ts';
import { Permissions } from '../../src/permissions/bits.ts';
import type { ModuleTemplates } from '../../src/placeholders/config-templates.ts';
import type { SimulationAdapter, SimulationDescriptor } from '../../src/simulation/types.ts';

const templates = {
  surfaces: { 'ping.reply': {} },
  collect: () => [],
} as unknown as ModuleTemplates;

function descriptor(overrides: Partial<SimulationDescriptor> = {}): SimulationDescriptor {
  return {
    id: 'ping.reply',
    moduleId: 'ping',
    label: 'Reply',
    summary: 'What /ping answers with.',
    surfaceId: 'ping.reply',
    configPath: 'response',
    output: 'message',
    delivery: 'channel',
    subject: false,
    inputs: [],
    ...overrides,
  };
}

function adapter(overrides: Partial<SimulationDescriptor> = {}): SimulationAdapter {
  return {
    descriptor: descriptor(overrides),
    build: () => ({ ok: false, humanReason: 'nothing to build', diagnostics: [] }),
  };
}

function manifest(simulations: SimulationAdapter[]): ModuleManifest {
  const configSchema = z.object({ enabled: z.boolean().default(true) });

  return {
    id: 'ping',
    name: 'Ping',
    category: 'utility',
    configSchema,
    defaultConfig: { enabled: true },
    schemaVersion: 1,
    requiredIntents: [GatewayIntentBits.Guilds],
    requiredPermissions: [Permissions.ViewChannel],
    templates,
    simulations,
  } as unknown as ModuleManifest;
}

describe('simulations at registration', () => {
  test('registers and is findable by id', () => {
    const registry = new ModuleRegistry();
    registry.register(manifest([adapter()]));

    expect(registry.simulations('ping')).toHaveLength(1);
    expect(registry.simulation('ping', 'ping.reply')?.descriptor.label).toBe('Reply');
    expect(registry.simulation('ping', 'ping.nothing')).toBeUndefined();
  });

  test('refuses a surface the module does not declare', () => {
    const registry = new ModuleRegistry();

    expect(() => registry.register(manifest([adapter({ surfaceId: 'welcome.join' })]))).toThrow(
      ModuleRegistrationError,
    );
  });

  test('accepts a simulation with no surface, for a message that holds no placeholders', () => {
    const registry = new ModuleRegistry();
    const bare = adapter();
    Reflect.deleteProperty(bare.descriptor as Record<string, unknown>, 'surfaceId');

    expect(() => registry.register(manifest([bare]))).not.toThrow();
  });

  test('refuses two simulations sharing an id', () => {
    const registry = new ModuleRegistry();

    expect(() => registry.register(manifest([adapter(), adapter()]))).toThrow(
      ModuleRegistrationError,
    );
  });

  test('refuses a simulation claiming another module', () => {
    const registry = new ModuleRegistry();

    expect(() => registry.register(manifest([adapter({ moduleId: 'welcome' })]))).toThrow(
      ModuleRegistrationError,
    );
  });

  test('refuses a channel delivery that does not produce a message', () => {
    const registry = new ModuleRegistry();

    expect(() =>
      registry.register(manifest([adapter({ output: 'text', delivery: 'channel' })])),
    ).toThrow(ModuleRegistrationError);
  });

  test('refuses an input declared twice', () => {
    const registry = new ModuleRegistry();
    const repeated = adapter({
      inputs: [
        { key: 'level', label: 'Level', kind: 'integer', min: 1, max: 9, fallback: 1 },
        { key: 'level', label: 'Level again', kind: 'integer', min: 1, max: 9, fallback: 1 },
      ],
    });

    expect(() => registry.register(manifest([repeated]))).toThrow(ModuleRegistrationError);
  });
});
