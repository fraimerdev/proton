import { describe, expect, test } from 'bun:test';
import { ModuleRegistry, Permissions } from '@proton/core';
import { GatewayIntentBits } from 'discord-api-types/v10';
import { verificationConfigSchema, verificationDefaultConfig } from '../src/config.ts';
import { verificationModule } from '../src/index.ts';

const GRANTED_INTENTS = GatewayIntentBits.Guilds | GatewayIntentBits.GuildMembers;

function registry() {
  const registered = new ModuleRegistry();
  registered.register(verificationModule);
  return registered;
}

describe('the manifest', () => {
  test('registers, which means its config renders as a form (§9)', () => {
    const paths = registry()
      .descriptors('verification')
      .map((descriptor) => descriptor.path);

    expect(paths).toEqual([
      'enabled',
      'unverifiedRoleId',
      'verifiedRoleId',
      'applyUnverifiedOnJoin',
      'quarantineRoleId',
    ]);
    // Every config key is renderable, so no bespoke editor is owed.
    expect(paths).toHaveLength(Object.keys(verificationConfigSchema.shape).length);
  });

  test('renders the three role fields as role pickers, not text boxes', () => {
    const kinds = new Map(
      registry()
        .descriptors('verification')
        .map((descriptor) => [descriptor.path, descriptor.kind]),
    );

    expect(kinds.get('unverifiedRoleId')).toBe('role-id');
    expect(kinds.get('verifiedRoleId')).toBe('role-id');
    expect(kinds.get('quarantineRoleId')).toBe('role-id');
  });

  test('ships defaults its own schema accepts', () => {
    expect(verificationConfigSchema.safeParse(verificationDefaultConfig).success).toBe(true);
  });

  test('ships defaults that gate nobody and quarantine nobody', () => {
    // An enabled gate with no role chosen would apply a role the admin never
    // picked to everyone who joins.
    expect(verificationDefaultConfig.enabled).toBe(false);
    expect(verificationDefaultConfig.unverifiedRoleId).toBeUndefined();
    expect(verificationDefaultConfig.verifiedRoleId).toBeUndefined();
    expect(verificationDefaultConfig.quarantineRoleId).toBeUndefined();
  });

  test('asks for Manage Roles and nothing else', () => {
    // Every operation is a role moving on or off a member. Requiring more would
    // disable verification in servers that correctly declined to grant it.
    expect(verificationModule.requiredPermissions).toEqual([Permissions.ManageRoles]);
  });

  test('declares the privileged intent that carries the join dispatch', () => {
    // Without GuildMembers, GUILD_MEMBER_ADD is never sent and every member
    // walks in ungated while the module reports itself healthy.
    expect(verificationModule.requiredIntents).toContain(GatewayIntentBits.GuildMembers);
  });

  test('listens to joins and to nothing else', () => {
    expect(verificationModule.listeners?.[0]?.types).toEqual(['member.joined']);
  });

  test('is disabled with a reason naming the intent when it cannot see joins', () => {
    const status = registry().evaluate('verification', {
      grantedIntents: GatewayIntentBits.Guilds,
      botPermissions: Permissions.ManageRoles,
    });

    expect(status.enabled).toBe(false);
    expect(status.disabledReason?.code).toBe('missing_intent');
    expect(status.disabledReason?.humanReason).toContain('GuildMembers');
  });

  test('is disabled with a reason naming the permission when it cannot move roles', () => {
    const status = registry().evaluate('verification', {
      grantedIntents: GRANTED_INTENTS,
      botPermissions: Permissions.ViewChannel,
    });

    expect(status.enabled).toBe(false);
    expect(status.disabledReason?.code).toBe('missing_permission');
    expect(status.disabledReason?.humanReason).toContain('ManageRoles');
  });

  test('runs when it has both', () => {
    const status = registry().evaluate('verification', {
      grantedIntents: GRANTED_INTENTS,
      botPermissions: Permissions.ManageRoles,
    });

    expect(status).toEqual({ id: 'verification', enabled: true });
  });

  test('exposes /verify to everyone and the quarantine pair to role managers', () => {
    const commands = new Map(
      (verificationModule.commands ?? []).map((command) => [command.name, command]),
    );

    expect([...commands.keys()]).toEqual(['verify', 'quarantine', 'unquarantine']);

    // /verify is the gate: restricting it to a Discord permission would restrict
    // it to people already past the gate.
    expect(commands.get('verify')?.data.default_member_permissions ?? null).toBeNull();
    expect(commands.get('quarantine')?.data.default_member_permissions).toBe(
      String(Permissions.ManageRoles),
    );
    expect(commands.get('unquarantine')?.data.default_member_permissions).toBe(
      String(Permissions.ManageRoles),
    );
  });

  test('every dashboard section names real config keys, and none is left off', () => {
    const keys = new Set(Object.keys(verificationConfigSchema.shape));
    const claimed = verificationModule.dashboard?.sections.flatMap((s) => s.fields) ?? [];

    expect(claimed.length).toBeGreaterThan(0);
    for (const field of claimed) expect(keys.has(field)).toBe(true);
    expect(new Set(claimed).size).toBe(keys.size);
  });
});
