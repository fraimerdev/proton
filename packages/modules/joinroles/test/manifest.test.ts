import { describe, expect, test } from 'bun:test';
import { ModuleRegistry, Permissions } from '@proton/core';
import { GatewayIntentBits } from 'discord-api-types/v10';
import { joinrolesConfigSchema, joinrolesDefaultConfig } from '../src/config.ts';
import { createJoinRolesModule, joinrolesModule } from '../src/index.ts';
import { JOINROLES_AUTOSYNC_JOB } from '../src/sync/autosync.ts';
import { JOINROLES_SYNC_JOB } from '../src/sync/run.ts';
import { FakeLister, MemoryRunStore } from './sync-harness.ts';

describe('join roles manifest', () => {
  test('registers cleanly, so the dashboard can render it', () => {
    const registry = new ModuleRegistry();

    expect(() => registry.register(joinrolesModule)).not.toThrow();
    expect(registry.descriptors('joinroles').length).toBeGreaterThan(0);
  });

  test('every configured field is renderable by the v1 form generator', () => {
    const registry = new ModuleRegistry();
    registry.register(joinrolesModule);

    const kinds = new Set(registry.descriptors('joinroles').map((d) => d.kind));

    expect(kinds.has('role-id')).toBe(true);
    expect(kinds.has('boolean')).toBe(true);
  });

  test('defaults are off, so an unconfigured guild gets nothing and no error', () => {
    expect(joinrolesDefaultConfig.enabled).toBe(false);
    expect(joinrolesDefaultConfig.stickyEnabled).toBe(false);
    expect(joinrolesConfigSchema.safeParse(joinrolesDefaultConfig).success).toBe(true);
  });

  test('declares the privileged intent it cannot work without', () => {
    expect(joinrolesModule.requiredIntents).toContain(GatewayIntentBits.GuildMembers);
  });

  test('declares MANAGE_ROLES, the permission it needs for anything at all', () => {
    expect(joinrolesModule.requiredPermissions).toContain(Permissions.ManageRoles);
  });

  test('reports a missing intent by name rather than going quiet', () => {
    const registry = new ModuleRegistry();
    registry.register(joinrolesModule);

    const status = registry.evaluate('joinroles', {
      grantedIntents: GatewayIntentBits.Guilds,
      botPermissions: Permissions.ManageRoles,
    });

    expect(status.enabled).toBe(false);
    expect(status.disabledReason?.code).toBe('missing_intent');
    expect(status.disabledReason?.humanReason).toContain('Server Members Intent');
  });

  test('reports a missing permission by name and says where to grant it', () => {
    const registry = new ModuleRegistry();
    registry.register(joinrolesModule);

    const status = registry.evaluate('joinroles', {
      grantedIntents: GatewayIntentBits.Guilds | GatewayIntentBits.GuildMembers,
      botPermissions: 0n,
    });

    expect(status.disabledReason?.code).toBe('missing_permission');
    expect(status.disabledReason?.humanReason).toContain('Manage Roles');
    expect(status.disabledReason?.humanReason).toContain('Server Settings');
  });

  test('is a valid manifest with no store wired', () => {
    const registry = new ModuleRegistry();

    expect(() => registry.register(createJoinRolesModule())).not.toThrow();
  });

  test('subscribes to the events it needs and no others', () => {
    const types = (joinrolesModule.listeners ?? []).flatMap((l) => l.types);

    expect(new Set(types)).toEqual(
      new Set([
        'member.joined',
        'member.updated',
        'joinroles.sync_requested',
        'proton.config_changed',
        'guild.available',
      ]),
    );
  });

  test('declares the sync batch and the scheduled sync, each with its handler', () => {
    expect(joinrolesModule.schedules).toEqual([JOINROLES_SYNC_JOB, JOINROLES_AUTOSYNC_JOB]);
    expect(Object.keys(joinrolesModule.scheduledHandlers ?? {}).sort()).toEqual(
      [JOINROLES_AUTOSYNC_JOB, JOINROLES_SYNC_JOB].sort(),
    );
  });

  test('still only ever adds a role, and emits nothing of its own', () => {
    expect(joinrolesModule.actionKinds).toEqual(['add_role']);
    expect(joinrolesModule.emits ?? []).toEqual([]);
  });

  test('registers cleanly with every sync binding wired', () => {
    const registry = new ModuleRegistry();
    const module = createJoinRolesModule({
      runs: new MemoryRunStore(),
      members: new FakeLister(),
      botUserId: '100000000000000099',
    });

    expect(() => registry.register(module)).not.toThrow();
    expect(registry.maySchedule('joinroles', JOINROLES_SYNC_JOB)).toBe(true);
    expect(registry.maySchedule('joinroles', JOINROLES_AUTOSYNC_JOB)).toBe(true);
  });

  test('the sync settings are renderable fields in their own section', () => {
    const registry = new ModuleRegistry();
    registry.register(joinrolesModule);

    const paths = registry.descriptors('joinroles').map((d) => d.path);
    const sync = joinrolesModule.dashboard?.sections.find((s) => s.id === 'sync');

    expect(sync?.fields).toEqual([
      'syncExcludeEnabled',
      'syncExcludeRoleIds',
      'syncScheduleEnabled',
      'syncInterval',
    ]);
    for (const field of sync?.fields ?? []) expect(paths).toContain(field);
  });
});
