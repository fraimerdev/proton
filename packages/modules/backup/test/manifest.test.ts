import { describe, expect, test } from 'bun:test';
import { ModuleRegistry, Permissions } from '@proton/core';
import { GatewayIntentBits } from 'discord-api-types/v10';
import { backupConfigSchema, backupDefaultConfig, MAX_RETAINED_BACKUPS } from '../src/config.ts';
import { backupModule } from '../src/index.ts';

function registry() {
  const registered = new ModuleRegistry();
  registered.register(backupModule);
  return registered;
}

describe('the manifest', () => {
  test('registers, which means its config renders as a form (§9)', () => {
    const paths = registry()
      .descriptors('backup')
      .map((descriptor) => descriptor.path);

    expect(paths).toContain('enabled');
    expect(paths).toContain('retainBackups');

    expect(paths).toHaveLength(Object.keys(backupConfigSchema.shape).length);
  });

  test('ships defaults its own schema accepts', () => {
    expect(backupConfigSchema.safeParse(backupDefaultConfig).success).toBe(true);
  });

  test('caps retention, because a snapshot is a whole server in one jsonb column', () => {
    expect(backupConfigSchema.safeParse({ retainBackups: MAX_RETAINED_BACKUPS + 1 }).success).toBe(
      false,
    );
    expect(backupConfigSchema.safeParse({ retainBackups: 0 }).success).toBe(false);
  });

  test('declares VIEW_CHANNEL, the permission the whole module turns on', () => {
    expect(backupModule.requiredPermissions).toEqual([Permissions.ViewChannel]);
  });

  test('does not gate itself on the permissions only a restore needs', () => {
    expect(backupModule.requiredPermissions).not.toContain(Permissions.ManageChannels);
    expect(backupModule.requiredPermissions).not.toContain(Permissions.ManageRoles);
  });

  test('is disabled with a reason naming the permission when it cannot see channels', () => {
    const status = registry().evaluate('backup', {
      grantedIntents: GatewayIntentBits.Guilds,
      botPermissions: Permissions.SendMessages,
    });

    expect(status.enabled).toBe(false);
    expect(status.disabledReason?.code).toBe('missing_permission');
    expect(status.disabledReason?.humanReason).toContain('View Channel');
    expect(status.disabledReason?.humanReason).toContain('Server Settings');
  });

  test('is disabled with a reason naming the intent when it cannot see the guild', () => {
    const status = registry().evaluate('backup', {
      grantedIntents: 0,
      botPermissions: Permissions.ViewChannel,
    });

    expect(status.enabled).toBe(false);
    expect(status.disabledReason?.code).toBe('missing_intent');
    expect(status.disabledReason?.humanReason).toContain('Guilds');
  });

  test('runs when it has both', () => {
    const status = registry().evaluate('backup', {
      grantedIntents: GatewayIntentBits.Guilds,
      botPermissions: Permissions.ViewChannel,
    });

    expect(status).toEqual({ id: 'backup', enabled: true });
  });

  test('ships no migration, because `backups` is a core table (§6)', () => {});

  test('declares no scheduled job, because nothing would run one', () => {
    expect(backupModule.jobs).toBeUndefined();
  });

  test('exposes one admin command, gated on Manage Server', () => {
    expect(backupModule.commands?.map((command) => command.name)).toEqual(['backup']);
    expect(backupModule.commands?.[0]?.data.default_member_permissions).toBe(
      String(Permissions.ManageGuild),
    );
  });

  test('every dashboard section names real config keys', () => {
    const keys = new Set(Object.keys(backupConfigSchema.shape));
    const claimed = backupModule.dashboard?.sections.flatMap((section) => section.fields) ?? [];

    expect(claimed.length).toBeGreaterThan(0);
    for (const field of claimed) expect(keys.has(field)).toBe(true);

    expect(new Set(claimed).size).toBe(keys.size);
  });
});
