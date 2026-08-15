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

  /**
   * The escape hatch for §9's deliberately closed vocabulary: a module may store
   * per-guild data richer than the generator renders — cases' escalation ladder
   * is an array of objects — as long as it names the narrower schema the form is
   * built from. Without this the module could not be registered at all, and the
   * only ways out would be widening the generator into a rule builder or moving
   * the data out of config, losing I5 validation and the I7 audit diff.
   */
  test('generates the form from formSchema when the config schema is richer', () => {
    const registry = new ModuleRegistry();
    const configSchema = z.object({
      enabled: z.boolean().default(true),
      ladder: z.array(z.object({ at: z.number() })).default([]),
    });

    // The full schema is still refused — the boundary has not moved.
    expect(() =>
      registry.register(manifest({ configSchema, defaultConfig: { enabled: true } })),
    ).toThrow(/ladder/);

    registry.register(
      manifest({
        configSchema,
        formSchema: configSchema.omit({ ladder: true }),
        defaultConfig: { enabled: true, ladder: [] },
      }),
    );

    expect(registry.descriptors('ping').map((d) => d.path)).toEqual(['enabled']);
  });

  /**
   * A form field with no config key behind it saves into nothing: the module's
   * own schema drops the unknown key and the admin watches their setting revert.
   */
  test('refuses a formSchema field the config schema does not define', () => {
    const registry = new ModuleRegistry();
    const broken = manifest({
      formSchema: z.object({ enabled: z.boolean(), typo: z.string() }),
    });

    expect(() => registry.register(broken)).toThrow(ModuleRegistrationError);
    expect(() => registry.register(broken)).toThrow(/typo/);
  });

  /**
   * Preset rules and jobs are plain data (§4-P2), so they survive registration
   * untouched and the engine and scheduler can load them exactly as they load
   * rows a guild admin created.
   */
  test('keeps a manifest’s declared rules and jobs', () => {
    const registry = new ModuleRegistry();
    registry.register(
      manifest({
        rules: [
          {
            id: 'escalate-on-third-warn',
            trigger: { kind: 'event', event: 'moderation.warned' },
            conditions: [{ kind: 'rate-over-window', limit: 3, window: '24h' }],
            actions: [{ kind: 'timeout', duration: '1h', reason: 'Third warning' }],
            enabled: true,
            priority: 10,
          },
        ],
        jobs: [{ id: 'sweep-expired', cron: '*/5 * * * *' }],
      }),
    );

    const registered = registry.get('ping');
    expect(registered?.rules?.[0]?.actions[0]?.kind).toBe('timeout');
    expect(registered?.jobs?.[0]?.cron).toBe('*/5 * * * *');
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

  /**
   * The audit-log path specifically (§8 Phase 2). Discord delivers
   * GUILD_AUDIT_LOG_ENTRY_CREATE only to bots holding VIEW_AUDIT_LOG and only
   * under the GUILD_MODERATION intent, and it signals neither refusal — a
   * security module without them looks exactly like a peaceful guild. This is
   * the only place that difference can be made visible, so it is pinned here
   * rather than left to the generic permission case above.
   */
  test('disables an audit-log consumer that lacks VIEW_AUDIT_LOG or GUILD_MODERATION', () => {
    const registry = new ModuleRegistry();
    registry.register(
      manifest({
        name: 'Anti-Nuke',
        requiredIntents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildModeration],
        requiredPermissions: [Permissions.ViewAuditLog],
      }),
    );

    const noIntent = registry.evaluate('ping', env);

    expect(noIntent.disabledReason?.code).toBe('missing_intent');
    expect(noIntent.disabledReason?.humanReason).toContain('GuildModeration');

    const withIntent = registry.evaluate('ping', {
      ...env,
      grantedIntents: env.grantedIntents | GatewayIntentBits.GuildModeration,
    });

    expect(withIntent.disabledReason?.code).toBe('missing_permission');
    expect(withIntent.disabledReason?.humanReason).toContain('ViewAuditLog');
    expect(withIntent.disabledReason?.humanReason).toContain('Server Settings');
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

/**
 * The `emits` allowlist — the narrow opening in I3 that lets a module publish
 * `xp.level_gained` without being handed the bus.
 *
 * What is being protected here is not the ability to publish, which is
 * harmless in itself, but the ability to publish *someone else's* event type. A
 * module that could forge `moderation.warned` could drive another guild's
 * escalation ladder into banning people, and nothing downstream would be able to
 * tell the forged event from a real one — they are the same shape by design.
 */
describe('emits allowlist', () => {
  test('a module may publish only what it declares', () => {
    const registry = new ModuleRegistry();
    registry.register(manifest({ id: 'leveling', emits: ['xp.level_gained'] }));

    expect(registry.mayEmit('leveling', 'xp.level_gained')).toBe(true);
    expect(registry.mayEmit('leveling', 'moderation.warned')).toBe(false);
  });

  test('a module declaring nothing may publish nothing', () => {
    const registry = new ModuleRegistry();
    registry.register(manifest());

    expect(registry.mayEmit('ping', 'xp.level_gained')).toBe(false);
  });

  test('an unregistered module may publish nothing', () => {
    expect(new ModuleRegistry().mayEmit('ghost', 'xp.level_gained')).toBe(false);
  });

  /**
   * This is the set the gateway's `NORMALISED_EVENT_TYPES` is unioned with, so
   * that a listener on an internal event is not reported as subscribing to
   * something nothing emits.
   */
  test('collects every declared type across modules, without duplicates', () => {
    const registry = new ModuleRegistry();
    registry.register(manifest({ id: 'leveling', emits: ['xp.level_gained'] }));
    registry.register(manifest({ id: 'cases', emits: ['moderation.warned', 'xp.level_gained'] }));

    expect(new Set(registry.emittedTypes())).toEqual(
      new Set(['xp.level_gained', 'moderation.warned']),
    );
    expect(registry.emittedTypes()).toHaveLength(2);
  });

  /**
   * Harmless at runtime but always a mistake, and invisible in `emittedTypes()`
   * because that is a union. Caught where it can name the module.
   */
  test('refuses a manifest that lists the same type twice', () => {
    const registry = new ModuleRegistry();

    expect(() =>
      registry.register(manifest({ emits: ['xp.level_gained', 'xp.level_gained'] })),
    ).toThrow(ModuleRegistrationError);
  });
});
