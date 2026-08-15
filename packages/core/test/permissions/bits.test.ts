import { describe, expect, test } from 'bun:test';
import {
  ALL_PERMISSIONS,
  combinePermissions,
  has,
  hasWithAdmin,
  missing,
  Permissions,
  permissionNames,
} from '../../src/permissions/bits.ts';

describe('permission bit values', () => {
  test('the 2026 permission splits are where §10.3 says they are', () => {
    expect(Permissions.PinMessages).toBe(1n << 51n);
    expect(Permissions.CreateGuildExpressions).toBe(1n << 43n);
    expect(Permissions.CreateEvents).toBe(1n << 44n);
    expect(Permissions.SetVoiceChannelStatus).toBe(1n << 48n);
  });

  test('BYPASS_SLOWMODE is 1<<52 — the bit §10.3 omits', () => {
    expect(Permissions.BypassSlowmode).toBe(1n << 52n);
  });

  test('common bits are unchanged', () => {
    expect(Permissions.BanMembers).toBe(1n << 2n);
    expect(Permissions.Administrator).toBe(1n << 3n);
    expect(Permissions.ManageGuild).toBe(1n << 5n);
    expect(Permissions.ViewChannel).toBe(1n << 10n);
    expect(Permissions.SendMessages).toBe(1n << 11n);
    expect(Permissions.ManageMessages).toBe(1n << 13n);
    expect(Permissions.ModerateMembers).toBe(1n << 40n);
  });

  test('PIN_MESSAGES is no longer implied by MANAGE_MESSAGES', () => {
    const manageOnly = Permissions.ManageMessages;

    expect(has(manageOnly, Permissions.PinMessages)).toBe(false);
  });

  test('high bits survive bigint arithmetic', () => {
    const combined = Permissions.BypassSlowmode | Permissions.PinMessages;

    expect(has(combined, Permissions.BypassSlowmode)).toBe(true);
    expect(has(combined, Permissions.PinMessages)).toBe(true);
    expect(combined).toBe(6755399441055744n);
  });

  test('Number bitwise operators cannot express these bits at all', () => {
    expect(1 << 52).toBe(1 << 20);
    expect(1 << 52).not.toBe(4503599627370496);

    expect(Permissions.BypassSlowmode).toBe(4503599627370496n);
    expect(typeof Permissions.BypassSlowmode).toBe('bigint');
  });
});

describe('permission helpers', () => {
  test('has() requires every requested bit, not just one', () => {
    const perms = Permissions.ViewChannel | Permissions.SendMessages;

    expect(has(perms, Permissions.ViewChannel)).toBe(true);
    expect(has(perms, Permissions.ViewChannel | Permissions.SendMessages)).toBe(true);
    expect(has(perms, Permissions.ViewChannel | Permissions.ManageMessages)).toBe(false);
  });

  test('hasWithAdmin() treats ADMINISTRATOR as granting everything', () => {
    expect(hasWithAdmin(Permissions.Administrator, Permissions.BanMembers)).toBe(true);
    expect(has(Permissions.Administrator, Permissions.BanMembers)).toBe(false);
  });

  test('missing() reports exactly what is absent, for admin-facing errors', () => {
    const perms = Permissions.ViewChannel;
    const required = Permissions.ViewChannel | Permissions.SendMessages;

    expect(missing(perms, required)).toBe(Permissions.SendMessages);
    expect(permissionNames(missing(perms, required))).toEqual(['SendMessages']);
  });

  test('combinePermissions() unions what modules declare, for the invite URL', () => {
    const combined = combinePermissions([
      Permissions.ViewChannel,
      Permissions.SendMessages,
      Permissions.ViewChannel,
    ]);

    expect(combined).toBe(Permissions.ViewChannel | Permissions.SendMessages);
  });

  test('ALL_PERMISSIONS contains every known bit', () => {
    expect(has(ALL_PERMISSIONS, Permissions.Administrator)).toBe(true);
    expect(has(ALL_PERMISSIONS, Permissions.BypassSlowmode)).toBe(true);
    expect(has(ALL_PERMISSIONS, Permissions.PinMessages)).toBe(true);
  });
});
