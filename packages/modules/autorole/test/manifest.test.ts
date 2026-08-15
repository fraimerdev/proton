import { describe, expect, test } from 'bun:test';
import { ModuleRegistry, Permissions } from '@proton/core';
import { GatewayIntentBits } from 'discord-api-types/v10';
import { autoroleConfigSchema, autoroleDefaultConfig } from '../src/config.ts';
import { autoroleModule, createAutoroleModule } from '../src/index.ts';

describe('autorole manifest', () => {
  test('registers cleanly, so the dashboard can render it', () => {
    const registry = new ModuleRegistry();

    expect(() => registry.register(autoroleModule)).not.toThrow();
    expect(registry.descriptors('autorole').length).toBeGreaterThan(0);
  });

  test('every configured field is renderable by the v1 form generator', () => {
    const registry = new ModuleRegistry();
    registry.register(autoroleModule);

    const kinds = new Set(registry.descriptors('autorole').map((d) => d.kind));

    expect(kinds.has('role-id')).toBe(true);
    expect(kinds.has('boolean')).toBe(true);
  });

  test('defaults are off, so an unconfigured guild gets nothing and no error', () => {
    expect(autoroleDefaultConfig.enabled).toBe(false);
    expect(autoroleDefaultConfig.stickyEnabled).toBe(false);
    expect(autoroleConfigSchema.safeParse(autoroleDefaultConfig).success).toBe(true);
  });

  test('declares the privileged intent it cannot work without', () => {
    expect(autoroleModule.requiredIntents).toContain(GatewayIntentBits.GuildMembers);
  });

  test('declares MANAGE_ROLES, the permission it needs for anything at all', () => {
    expect(autoroleModule.requiredPermissions).toContain(Permissions.ManageRoles);
  });

  test('reports a missing intent by name rather than going quiet', () => {
    const registry = new ModuleRegistry();
    registry.register(autoroleModule);

    const status = registry.evaluate('autorole', {
      grantedIntents: GatewayIntentBits.Guilds,
      botPermissions: Permissions.ManageRoles,
    });

    expect(status.enabled).toBe(false);
    expect(status.disabledReason?.code).toBe('missing_intent');
    expect(status.disabledReason?.humanReason).toContain('GuildMembers');
  });

  test('reports a missing permission by name and says where to grant it', () => {
    const registry = new ModuleRegistry();
    registry.register(autoroleModule);

    const status = registry.evaluate('autorole', {
      grantedIntents: GatewayIntentBits.Guilds | GatewayIntentBits.GuildMembers,
      botPermissions: 0n,
    });

    expect(status.disabledReason?.code).toBe('missing_permission');
    expect(status.disabledReason?.humanReason).toContain('ManageRoles');
    expect(status.disabledReason?.humanReason).toContain('Server Settings');
  });

  test('is a valid manifest with no store wired', () => {
    const registry = new ModuleRegistry();

    expect(() => registry.register(createAutoroleModule())).not.toThrow();
  });

  test('subscribes to both events it needs and no others', () => {
    const types = (autoroleModule.listeners ?? []).flatMap((l) => l.types);

    expect(new Set(types)).toEqual(new Set(['member.joined', 'member.updated']));
  });
});
