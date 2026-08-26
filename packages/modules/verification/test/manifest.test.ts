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
      'mode',
      'panelChannelId',
      'panelTitle',
      'panelBody',
      'panelButtonLabel',
      'unverifiedRoleId',
      'verifiedRoleId',
      'applyUnverifiedOnJoin',
      'captchaDelivery',
      'captchaLength',
      'captchaAttempts',
      'captchaExpiry',
      'failureAction',
      'failureTimeout',
      'quarantineRoleId',
    ]);

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
    expect(verificationDefaultConfig.enabled).toBe(false);
    expect(verificationDefaultConfig.unverifiedRoleId).toBeUndefined();
    expect(verificationDefaultConfig.verifiedRoleId).toBeUndefined();
    expect(verificationDefaultConfig.quarantineRoleId).toBeUndefined();
  });

  test('asks for Manage Roles and nothing else', () => {
    expect(verificationModule.requiredPermissions).toEqual([Permissions.ManageRoles]);
  });

  test('declares the privileged intent that carries the join dispatch', () => {
    expect(verificationModule.requiredIntents).toContain(GatewayIntentBits.GuildMembers);
  });

  test('listens to joins, to its own components and modals, and to every config save', () => {
    expect(verificationModule.listeners?.map((listener) => listener.types)).toEqual([
      ['member.joined'],
      ['interaction.component'],
      ['interaction.modal'],
      ['proton.config_changed', 'verification.web_passed'],
    ]);
  });

  test('declares every kind its panel, captcha and failure action execute', () => {
    // moduleExecutor throws UndeclaredActionError on anything absent here, so a failure action
    // left off this list is a member who is told they were kicked and is not.
    expect(new Set(verificationModule.actionKinds)).toEqual(
      new Set([
        'add_role',
        'remove_role',
        'interaction_reply',
        'interaction_followup',
        'send',
        'edit_message',
        'delete_message',
        'create_dm',
        'kick',
        'ban',
        'timeout',
      ]),
    );
  });

  test('is disabled with a reason naming the intent when it cannot see joins', () => {
    const status = registry().evaluate('verification', {
      grantedIntents: GatewayIntentBits.Guilds,
      botPermissions: Permissions.ManageRoles,
    });

    expect(status.enabled).toBe(false);
    expect(status.disabledReason?.code).toBe('missing_intent');
    expect(status.disabledReason?.humanReason).toContain('Server Members Intent');
  });

  test('is disabled with a reason naming the permission when it cannot move roles', () => {
    const status = registry().evaluate('verification', {
      grantedIntents: GRANTED_INTENTS,
      botPermissions: Permissions.ViewChannel,
    });

    expect(status.enabled).toBe(false);
    expect(status.disabledReason?.code).toBe('missing_permission');
    expect(status.disabledReason?.humanReason).toContain('Manage Roles');
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
