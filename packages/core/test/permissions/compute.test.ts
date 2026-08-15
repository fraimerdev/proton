import { describe, expect, test } from 'bun:test';
import { ALL_PERMISSIONS, has, Permissions } from '../../src/permissions/bits.ts';
import {
  applyOverwrites,
  computeBasePermissions,
  computeChannelPermissions,
  type GuildRole,
  type Overwrite,
  type PermissionContext,
} from '../../src/permissions/compute.ts';

const EVERYONE = '100000000000000000';
const OWNER = '200000000000000000';
const MEMBER = '300000000000000000';
const ROLE_A = '400000000000000001';
const ROLE_B = '400000000000000002';

function roles(...entries: Array<[string, bigint]>): Map<string, GuildRole> {
  return new Map(
    entries.map(([id, permissions], index) => [id, { id, permissions, position: index }]),
  );
}

function ctx(overrides: Partial<PermissionContext> = {}): PermissionContext {
  return {
    guildOwnerId: OWNER,
    everyoneRoleId: EVERYONE,
    memberId: MEMBER,
    memberRoleIds: [],
    roles: roles([EVERYONE, Permissions.ViewChannel | Permissions.SendMessages]),
    ...overrides,
  };
}

describe('computeBasePermissions', () => {
  test('starts from @everyone', () => {
    const result = computeBasePermissions(ctx());

    expect(result).toBe(Permissions.ViewChannel | Permissions.SendMessages);
  });

  test('unions every role the member holds', () => {
    const result = computeBasePermissions(
      ctx({
        memberRoleIds: [ROLE_A, ROLE_B],
        roles: roles(
          [EVERYONE, Permissions.ViewChannel],
          [ROLE_A, Permissions.SendMessages],
          [ROLE_B, Permissions.ManageMessages],
        ),
      }),
    );

    expect(result).toBe(
      Permissions.ViewChannel | Permissions.SendMessages | Permissions.ManageMessages,
    );
  });

  test('ADMINISTRATOR short-circuits to everything', () => {
    const result = computeBasePermissions(
      ctx({
        memberRoleIds: [ROLE_A],
        roles: roles([EVERYONE, 0n], [ROLE_A, Permissions.Administrator]),
      }),
    );

    expect(result).toBe(ALL_PERMISSIONS);
  });

  test('the guild owner always has everything, regardless of roles', () => {
    const result = computeBasePermissions(ctx({ memberId: OWNER, roles: roles([EVERYONE, 0n]) }));

    expect(result).toBe(ALL_PERMISSIONS);
  });

  test('ignores role ids that do not resolve', () => {
    const result = computeBasePermissions(
      ctx({
        memberRoleIds: ['999999999999999999'],
        roles: roles([EVERYONE, Permissions.ViewChannel]),
      }),
    );

    expect(result).toBe(Permissions.ViewChannel);
  });
});

describe('applyOverwrites', () => {
  const base = Permissions.ViewChannel | Permissions.SendMessages;

  test('applies the @everyone deny then its allow', () => {
    const overwrites: Overwrite[] = [
      { id: EVERYONE, type: 0, allow: Permissions.ManageMessages, deny: Permissions.SendMessages },
    ];

    const result = applyOverwrites(base, overwrites, ctx());

    expect(has(result, Permissions.SendMessages)).toBe(false);
    expect(has(result, Permissions.ManageMessages)).toBe(true);
  });

  test('unions role denies and allows, so an allow beats a deny across roles', () => {
    const overwrites: Overwrite[] = [
      { id: ROLE_A, type: 0, allow: 0n, deny: Permissions.SendMessages },
      { id: ROLE_B, type: 0, allow: Permissions.SendMessages, deny: 0n },
    ];

    const result = applyOverwrites(base, overwrites, ctx({ memberRoleIds: [ROLE_A, ROLE_B] }));

    expect(has(result, Permissions.SendMessages)).toBe(true);
  });

  test('a role deny with no matching allow removes the permission', () => {
    const overwrites: Overwrite[] = [
      { id: ROLE_A, type: 0, allow: 0n, deny: Permissions.SendMessages },
    ];

    const result = applyOverwrites(base, overwrites, ctx({ memberRoleIds: [ROLE_A] }));

    expect(has(result, Permissions.SendMessages)).toBe(false);
  });

  test('ignores overwrites for roles the member does not hold', () => {
    const overwrites: Overwrite[] = [
      { id: ROLE_A, type: 0, allow: 0n, deny: Permissions.SendMessages },
    ];

    const result = applyOverwrites(base, overwrites, ctx({ memberRoleIds: [] }));

    expect(has(result, Permissions.SendMessages)).toBe(true);
  });

  test('the member overwrite wins over role overwrites', () => {
    const overwrites: Overwrite[] = [
      { id: ROLE_A, type: 0, allow: Permissions.SendMessages, deny: 0n },
      { id: MEMBER, type: 1, allow: 0n, deny: Permissions.SendMessages },
    ];

    const result = applyOverwrites(base, overwrites, ctx({ memberRoleIds: [ROLE_A] }));

    expect(has(result, Permissions.SendMessages)).toBe(false);
  });

  test('ADMINISTRATOR ignores overwrites entirely', () => {
    const overwrites: Overwrite[] = [{ id: EVERYONE, type: 0, allow: 0n, deny: ALL_PERMISSIONS }];

    const result = applyOverwrites(ALL_PERMISSIONS, overwrites, ctx());

    expect(result).toBe(ALL_PERMISSIONS);
  });
});

describe('computeChannelPermissions', () => {
  test('a channel with no overwrites yields the base permissions', () => {
    const result = computeChannelPermissions(ctx(), []);

    expect(result).toBe(Permissions.ViewChannel | Permissions.SendMessages);
  });

  test('a synced channel inherits its category overwrites', () => {
    const parent: Overwrite[] = [
      { id: EVERYONE, type: 0, allow: 0n, deny: Permissions.SendMessages },
    ];

    const result = computeChannelPermissions(ctx(), [], parent);

    expect(has(result, Permissions.SendMessages)).toBe(false);
    expect(has(result, Permissions.ViewChannel)).toBe(true);
  });

  test('a channel with its own overwrites does not fall back to the category', () => {
    const own: Overwrite[] = [
      { id: EVERYONE, type: 0, allow: Permissions.ManageMessages, deny: 0n },
    ];
    const parent: Overwrite[] = [
      { id: EVERYONE, type: 0, allow: 0n, deny: Permissions.SendMessages },
    ];

    const result = computeChannelPermissions(ctx(), own, parent);

    expect(has(result, Permissions.SendMessages)).toBe(true);
    expect(has(result, Permissions.ManageMessages)).toBe(true);
  });
});

describe('timeout handling', () => {
  const now = 1_800_000_000_000;

  test('a timed-out member keeps only VIEW_CHANNEL and READ_MESSAGE_HISTORY', () => {
    const result = computeChannelPermissions(
      ctx({
        roles: roles([
          EVERYONE,
          Permissions.ViewChannel | Permissions.SendMessages | Permissions.ReadMessageHistory,
        ]),
        communicationDisabledUntil: now + 60_000,
        now,
      }),
    );

    expect(has(result, Permissions.ViewChannel)).toBe(true);
    expect(has(result, Permissions.ReadMessageHistory)).toBe(true);
    expect(has(result, Permissions.SendMessages)).toBe(false);
  });

  test('an expired timeout restores permissions', () => {
    const result = computeChannelPermissions(ctx({ communicationDisabledUntil: now - 1, now }));

    expect(has(result, Permissions.SendMessages)).toBe(true);
  });

  test('the guild owner is unaffected by a timeout', () => {
    const result = computeChannelPermissions(
      ctx({ memberId: OWNER, communicationDisabledUntil: now + 60_000, now }),
    );

    expect(result).toBe(ALL_PERMISSIONS);
  });
});
