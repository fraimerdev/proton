import { describe, expect, test } from 'bun:test';
import { GatewayIntentBits } from 'discord-api-types/v10';
import { z } from 'zod';
import { protonFields } from '../../src/config/descriptor.ts';
import type { ModuleManifest } from '../../src/modules/manifest.ts';
import {
  ModuleRegistrationError,
  ModuleRegistry,
  type RegistryEnvironment,
} from '../../src/modules/registry.ts';
import { Permissions } from '../../src/permissions/bits.ts';

/**
 * A trivial manifest factory.
 *
 * This is the mechanical half of Gate 0's "adding a second module takes < 1 day"
 * criterion: the contract suite below is parameterised over manifests, so a new
 * module is a fixture here, never new framework code.
 */
function manifest(overrides: Partial<ModuleManifest> = {}): ModuleManifest {
  const configSchema = z.object({
    enabled: z.boolean().default(true),
    response: z.string().min(1).max(200).default('Pong!'),
  });

  return {
    id: 'ping',
    name: 'Ping',
    category: 'utility',
    configSchema,
    defaultConfig: { enabled: true, response: 'Pong!' },
    schemaVersion: 1,
    requiredIntents: [GatewayIntentBits.Guilds],
    requiredPermissions: [Permissions.ViewChannel, Permissions.SendMessages],
    migrations: [],
    ...overrides,
  } as ModuleManifest;
}

const env: RegistryEnvironment = {
  grantedIntents: GatewayIntentBits.Guilds | GatewayIntentBits.GuildMembers,
  botPermissions: Permissions.ViewChannel | Permissions.SendMessages,
};

describe('ModuleRegistry registration', () => {
  test('registers a valid manifest', () => {
    const registry = new ModuleRegistry();
    registry.register(manifest());

    expect(registry.get('ping')?.name).toBe('Ping');
    expect(registry.all()).toHaveLength(1);
  });

  test('refuses a duplicate module id', () => {
    const registry = new ModuleRegistry();
    registry.register(manifest());

    expect(() => registry.register(manifest())).toThrow(ModuleRegistrationError);
  });

  /**
   * P4's "drift is impossible" property. A schema change that forgets to update
   * defaultConfig would otherwise ship a module no guild can enable, and the
   * failure would appear as a validation error in production.
   */
  test('refuses a defaultConfig that does not satisfy its own schema', () => {
    const registry = new ModuleRegistry();
    const broken = manifest({
      configSchema: z.object({ enabled: z.boolean(), threshold: z.string() }),
      defaultConfig: { enabled: true },
    });

    expect(() => registry.register(broken)).toThrow(/defaultConfig/);
  });

  test('refuses a config schema the dashboard cannot render', () => {
    const registry = new ModuleRegistry();
    const broken = manifest({
      configSchema: z.object({ mode: z.union([z.string(), z.boolean()]) }),
      defaultConfig: { mode: 'a' },
    });

    // Caught at load time, in this module's own tests — not at render time in a
    // guild admin's browser.
    expect(() => registry.register(broken)).toThrow();
  });

  test('exposes descriptors generated from the config schema', () => {
    const registry = new ModuleRegistry();
    registry.register(
      manifest({
        configSchema: z.object({
          enabled: z.boolean().default(true),
          channel: z.string().register(protonFields, { field: 'channel-id' }),
        }),
        defaultConfig: { enabled: true, channel: '1' },
      }),
    );

    expect(registry.descriptors('ping').map((d) => d.kind)).toEqual(['boolean', 'channel-id']);
  });
});

describe('ModuleRegistry gating', () => {
  test('enables a module whose requirements are met', () => {
    const registry = new ModuleRegistry();
    registry.register(manifest());

    expect(registry.evaluate('ping', env)).toEqual({ id: 'ping', enabled: true });
  });

  test('disables a module missing an intent and names which intent', () => {
    const registry = new ModuleRegistry();
    registry.register(manifest({ requiredIntents: [GatewayIntentBits.MessageContent] }));

    const status = registry.evaluate('ping', env);

    expect(status.enabled).toBe(false);
    expect(status.disabledReason?.code).toBe('missing_intent');
    expect(status.disabledReason?.humanReason).toContain('MessageContent');
    // And says where to fix it.
    expect(status.disabledReason?.humanReason).toContain('developer portal');
  });

  test('disables a module missing a permission and names which one and where', () => {
    const registry = new ModuleRegistry();
    registry.register(manifest({ requiredPermissions: [Permissions.ManageRoles] }));

    const status = registry.evaluate('ping', env);

    expect(status.enabled).toBe(false);
    expect(status.disabledReason?.code).toBe('missing_permission');
    expect(status.disabledReason?.humanReason).toContain('ManageRoles');
    expect(status.disabledReason?.humanReason).toContain('Server Settings');
  });

  test('disables a module whose dependency is not loaded', () => {
    const registry = new ModuleRegistry();
    registry.register(manifest({ dependsOn: ['cases'] }));

    const status = registry.evaluate('ping', env);

    expect(status.disabledReason?.code).toBe('missing_dependency');
    expect(status.disabledReason?.humanReason).toContain('cases');
  });

  test('gates on entitlement tier without any per-module code', () => {
    const registry = new ModuleRegistry();
    registry.register(manifest({ requiredEntitlement: 'pro' }));

    expect(registry.evaluate('ping', { ...env, tier: 'free' }).disabledReason?.code).toBe(
      'insufficient_entitlement',
    );
    expect(registry.evaluate('ping', { ...env, tier: 'pro' }).enabled).toBe(true);
  });

  test('reports an unknown module rather than throwing', () => {
    const registry = new ModuleRegistry();

    expect(registry.evaluate('nope', env).enabled).toBe(false);
  });
});

describe('aggregate requirements', () => {
  test('computes the invite permission integer from manifests, never by hand', () => {
    const registry = new ModuleRegistry();
    registry.register(manifest());
    registry.register(
      manifest({ id: 'second', name: 'Second', requiredPermissions: [Permissions.ManageMessages] }),
    );

    // PLAN.md §10.3 — this is the number that goes in the invite URL.
    expect(registry.invitePermissions()).toBe(
      Permissions.ViewChannel | Permissions.SendMessages | Permissions.ManageMessages,
    );
  });

  test('computes the gateway intent bitfield from manifests', () => {
    const registry = new ModuleRegistry();
    registry.register(manifest());
    registry.register(
      manifest({ id: 'second', name: 'Second', requiredIntents: [GatewayIntentBits.GuildMembers] }),
    );

    expect(registry.requiredIntents()).toBe(
      GatewayIntentBits.Guilds | GatewayIntentBits.GuildMembers,
    );
  });

  test('a second module needs no framework change — only a manifest', () => {
    const registry = new ModuleRegistry();
    registry.register(manifest());
    registry.register(manifest({ id: 'echo', name: 'Echo' }));

    expect(registry.all().map((m) => m.id)).toEqual(['ping', 'echo']);
    expect(registry.evaluate('echo', env).enabled).toBe(true);
  });
});
