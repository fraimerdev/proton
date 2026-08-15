import { describe, expect, test } from 'bun:test';
import { ModuleRegistry, Permissions, requiresAuditLog } from '@proton/core';
import { GatewayIntentBits } from 'discord-api-types/v10';
import { antinukeConfigSchema, antinukeDefaultConfig } from '../src/config.ts';
import { antinukeModule } from '../src/index.ts';

const GRANTED_INTENTS = GatewayIntentBits.Guilds | GatewayIntentBits.GuildModeration;

function registry() {
  const registered = new ModuleRegistry();
  registered.register(antinukeModule);
  return registered;
}

describe('the manifest', () => {
  test('registers, which means its config renders as a form (§9)', () => {
    const paths = registry()
      .descriptors('antinuke')
      .map((descriptor) => descriptor.path);

    expect(paths).toContain('enabled');
    expect(paths).toContain('channelDeleteLimit');
    expect(paths).toContain('alertChannelId');
    expect(paths).toContain('maintenanceMaxDuration');

    expect(paths).toHaveLength(Object.keys(antinukeConfigSchema.shape).length);
  });

  test('ships defaults its own schema accepts', () => {
    expect(antinukeConfigSchema.safeParse(antinukeDefaultConfig).success).toBe(true);
  });

  test('ships defaults that act on nobody irreversibly', () => {
    expect(antinukeDefaultConfig.afterStrip).toBe('none');
  });

  test('declares VIEW_AUDIT_LOG, because every event it listens for needs it', () => {
    const types = antinukeModule.listeners?.[0]?.types ?? [];

    expect(requiresAuditLog(types)).toBe(true);
    expect(antinukeModule.requiredPermissions).toContain(Permissions.ViewAuditLog);

    expect(antinukeModule.requiredPermissions).toContain(Permissions.ManageRoles);
  });

  test('does not gate itself on the permissions only an opt-in response needs', () => {
    expect(antinukeModule.requiredPermissions).not.toContain(Permissions.BanMembers);
    expect(antinukeModule.requiredPermissions).not.toContain(Permissions.SendMessages);
  });

  test('declares the intent that carries the audit dispatch', () => {
    expect(antinukeModule.requiredIntents).toContain(GatewayIntentBits.GuildModeration);
  });

  test('listens to the destructive classes and to nothing else', () => {
    expect(antinukeModule.listeners?.[0]?.types).toEqual([
      'channel.deleted',
      'role.deleted',
      'webhook.deleted',
      'emoji.deleted',
      'member.banned',
      'member.kicked',
    ]);
  });

  test('is disabled with a reason naming the permission when it cannot see the audit log', () => {
    const status = registry().evaluate('antinuke', {
      grantedIntents: GRANTED_INTENTS,
      botPermissions: Permissions.ManageRoles,
    });

    expect(status.enabled).toBe(false);
    expect(status.disabledReason?.code).toBe('missing_permission');
    expect(status.disabledReason?.humanReason).toContain('ViewAuditLog');
  });

  test('is disabled with a reason naming the intent when it cannot receive the dispatch', () => {
    const status = registry().evaluate('antinuke', {
      grantedIntents: GatewayIntentBits.Guilds,
      botPermissions: Permissions.ViewAuditLog | Permissions.ManageRoles,
    });

    expect(status.enabled).toBe(false);
    expect(status.disabledReason?.code).toBe('missing_intent');
    expect(status.disabledReason?.humanReason).toContain('GuildModeration');
  });

  test('runs when it has both', () => {
    const status = registry().evaluate('antinuke', {
      grantedIntents: GRANTED_INTENTS,
      botPermissions: Permissions.ViewAuditLog | Permissions.ManageRoles,
    });

    expect(status).toEqual({ id: 'antinuke', enabled: true });
  });

  test('every dashboard section names real config keys', () => {
    const keys = new Set(Object.keys(antinukeConfigSchema.shape));
    const claimed = antinukeModule.dashboard?.sections.flatMap((section) => section.fields) ?? [];

    expect(claimed.length).toBeGreaterThan(0);
    for (const field of claimed) expect(keys.has(field)).toBe(true);

    expect(new Set(claimed).size).toBe(keys.size);
  });

  test('exposes one admin command, gated on Manage Server', () => {
    expect(antinukeModule.commands?.map((command) => command.name)).toEqual(['antinuke']);
    expect(antinukeModule.commands?.[0]?.data.default_member_permissions).toBe(
      String(Permissions.ManageGuild),
    );
  });
});
