import { describe, expect, test } from 'bun:test';
import { type ModuleManifest, ModuleRegistry, Permissions } from '@proton/core';
import { GatewayIntentBits } from 'discord-api-types/v10';
import { antiraidModule } from '../src/index.ts';

const ALL_INTENTS = GatewayIntentBits.Guilds | GatewayIntentBits.GuildMembers;
const ALL_PERMISSIONS = Permissions.ManageRoles | Permissions.KickMembers;

function registry(): ModuleRegistry {
  const built = new ModuleRegistry();
  built.register(antiraidModule as ModuleManifest);
  return built;
}

describe('antiraid manifest', () => {
  test('registers — its config schema is one the dashboard can render', () => {
    expect(() => registry()).not.toThrow();
  });

  test('every config field gets a form control of the right kind', () => {
    const byPath = new Map(
      registry()
        .descriptors('antiraid')
        .map((d) => [d.path, d.kind]),
    );

    expect(byPath.get('enabled')).toBe('boolean');
    expect(byPath.get('joinWindow')).toBe('duration');
    expect(byPath.get('joinThreshold')).toBe('number');
    expect(byPath.get('newAccountAge')).toBe('duration');
    expect(byPath.get('brandNewAccountAge')).toBe('duration');
    expect(byPath.get('scoreThreshold')).toBe('number');
    expect(byPath.get('response')).toBe('enum');
    // A role picker, not a text box — an admin pasting a role id by hand is how
    // the quarantine rung ends up pointing at a role that no longer exists.
    expect(byPath.get('verificationRoleId')).toBe('role-id');
    expect(byPath.get('quarantineRoleId')).toBe('role-id');
    expect(byPath.get('alertChannelId')).toBe('channel-id');
  });

  test('every dashboard section names fields that exist', () => {
    const paths = new Set(
      registry()
        .descriptors('antiraid')
        .map((d) => d.path),
    );
    for (const section of antiraidModule.dashboard?.sections ?? []) {
      for (const field of section.fields) expect(paths.has(field)).toBe(true);
    }
  });

  test('listens for joins and nothing else', () => {
    expect(antiraidModule.listeners?.[0]?.types).toEqual(['member.joined']);
    // No commands and no preset rules: the score has no expression in §4-P2's
    // closed predicate set, which is why this is a listener at all.
    expect(antiraidModule.commands).toBeUndefined();
    expect(antiraidModule.rules).toBeUndefined();
  });

  test('runs when the intents and permissions are granted', () => {
    const status = registry().evaluate('antiraid', {
      grantedIntents: ALL_INTENTS,
      botPermissions: ALL_PERMISSIONS,
    });

    expect(status.enabled).toBe(true);
  });
});

describe('antiraid failure paths', () => {
  test('disables itself and names GUILD_MEMBERS when the intent is missing', () => {
    const status = registry().evaluate('antiraid', {
      grantedIntents: GatewayIntentBits.Guilds,
      botPermissions: ALL_PERMISSIONS,
    });

    // Without it GUILD_MEMBER_ADD is never dispatched, so the join counter would
    // read zero through a raid of a thousand accounts — silence indistinguishable
    // from a quiet server. Naming the intent and the portal is the difference
    // between a fixable problem and "the bot did nothing".
    expect(status.enabled).toBe(false);
    expect(status.disabledReason?.code).toBe('missing_intent');
    expect(status.disabledReason?.humanReason).toContain('GuildMembers');
    expect(status.disabledReason?.humanReason).toContain('developer portal');
  });

  test('disables itself and names MANAGE_ROLES when the permission is missing', () => {
    const status = registry().evaluate('antiraid', {
      grantedIntents: ALL_INTENTS,
      botPermissions: Permissions.KickMembers,
    });

    expect(status.enabled).toBe(false);
    expect(status.disabledReason?.code).toBe('missing_permission');
    expect(status.disabledReason?.humanReason).toContain('ManageRoles');
  });

  test('disables itself and names KICK_MEMBERS when the permission is missing', () => {
    const status = registry().evaluate('antiraid', {
      grantedIntents: ALL_INTENTS,
      botPermissions: Permissions.ManageRoles,
    });

    // A hard gate rather than a per-rung precheck, unlike `cases`: a guild that
    // finds out at 3am that the bot cannot kick has learned it at the one moment
    // the answer is useless.
    expect(status.enabled).toBe(false);
    expect(status.disabledReason?.humanReason).toContain('KickMembers');
  });
});
