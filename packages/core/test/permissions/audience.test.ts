import { describe, expect, test } from 'bun:test';
import { channelAudience } from '../../src/permissions/audience.ts';
import { Permissions } from '../../src/permissions/bits.ts';
import type { GuildRole, Overwrite } from '../../src/permissions/compute.ts';

const EVERYONE = '900000000000000001';
const OWNER = '100000000000000001';
const MEMBER = '100000000000000002';
const STAFF = '400000000000000001';
const HELPER = '400000000000000002';
const ADMIN = '400000000000000003';
const MUTED = '400000000000000004';

const VIEW = Permissions.ViewChannel;

function rolesWith(everyone: bigint, extra: Partial<Record<string, bigint>> = {}) {
  const roles = new Map<string, GuildRole>([
    [EVERYONE, { id: EVERYONE, permissions: everyone, position: 0 }],
    [HELPER, { id: HELPER, permissions: extra[HELPER] ?? 0n, position: 1 }],
    [MUTED, { id: MUTED, permissions: extra[MUTED] ?? 0n, position: 2 }],
    [STAFF, { id: STAFF, permissions: extra[STAFF] ?? 0n, position: 5 }],
    [ADMIN, { id: ADMIN, permissions: Permissions.Administrator, position: 9 }],
  ]);
  return roles;
}

function overwrite(id: string, type: 0 | 1, allow: bigint, deny: bigint): Overwrite {
  return { id, type, allow, deny };
}

describe('channelAudience', () => {
  test('a channel hidden from @everyone and opened to staff is private to staff', () => {
    const audience = channelAudience({
      roles: rolesWith(VIEW),
      everyoneRoleId: EVERYONE,
      ownerId: OWNER,
      overwrites: [overwrite(EVERYONE, 0, 0n, VIEW), overwrite(STAFF, 0, VIEW, 0n)],
    });

    expect(audience).toEqual({
      everyone: false,
      roleIds: [STAFF],
      administratorRoleIds: [ADMIN],
      memberIds: [],
    });
  });

  test('a channel with no overwrites is open to everyone who can see the server', () => {
    const audience = channelAudience({
      roles: rolesWith(VIEW),
      everyoneRoleId: EVERYONE,
      ownerId: OWNER,
      overwrites: [],
    });

    expect(audience.everyone).toBe(true);
    expect(audience.roleIds).toEqual([STAFF, MUTED, HELPER]);
  });

  test('a role whose own overwrite denies the channel is left out even when @everyone can see it', () => {
    const audience = channelAudience({
      roles: rolesWith(VIEW),
      everyoneRoleId: EVERYONE,
      ownerId: OWNER,
      overwrites: [overwrite(MUTED, 0, 0n, VIEW)],
    });

    expect(audience.everyone).toBe(true);
    expect(audience.roleIds).not.toContain(MUTED);
  });

  test('a role that can see every channel by its server permissions is listed unless the channel denies it', () => {
    const roles = rolesWith(0n, { [STAFF]: VIEW });

    expect(
      channelAudience({ roles, everyoneRoleId: EVERYONE, ownerId: OWNER, overwrites: [] }).roleIds,
    ).toEqual([STAFF]);
    expect(
      channelAudience({
        roles,
        everyoneRoleId: EVERYONE,
        ownerId: OWNER,
        overwrites: [overwrite(STAFF, 0, 0n, VIEW)],
      }).roleIds,
    ).toEqual([]);
  });

  test('an @everyone deny hides the channel from a role that has the view only server-wide', () => {
    const audience = channelAudience({
      roles: rolesWith(0n, { [STAFF]: VIEW }),
      everyoneRoleId: EVERYONE,
      ownerId: OWNER,
      overwrites: [overwrite(EVERYONE, 0, 0n, VIEW)],
    });

    expect(audience.roleIds).toEqual([]);
  });

  test('Administrator roles are listed apart, whatever the overwrites deny them', () => {
    const audience = channelAudience({
      roles: rolesWith(0n),
      everyoneRoleId: EVERYONE,
      ownerId: OWNER,
      overwrites: [overwrite(EVERYONE, 0, 0n, VIEW), overwrite(ADMIN, 0, 0n, VIEW)],
    });

    expect(audience.administratorRoleIds).toEqual([ADMIN]);
    expect(audience.roleIds).not.toContain(ADMIN);
  });

  test('@everyone holding Administrator makes the channel visible to everyone', () => {
    const audience = channelAudience({
      roles: rolesWith(Permissions.Administrator),
      everyoneRoleId: EVERYONE,
      ownerId: OWNER,
      overwrites: [overwrite(EVERYONE, 0, 0n, VIEW)],
    });

    expect(audience.everyone).toBe(true);
  });

  test('members given the channel directly are listed, and members denied it are not', () => {
    const audience = channelAudience({
      roles: rolesWith(0n),
      everyoneRoleId: EVERYONE,
      ownerId: OWNER,
      overwrites: [
        overwrite(EVERYONE, 0, 0n, VIEW),
        overwrite(MEMBER, 1, VIEW, 0n),
        overwrite('100000000000000003', 1, 0n, VIEW),
      ],
    });

    expect(audience.memberIds).toEqual([MEMBER]);
    expect(audience.everyone).toBe(false);
  });

  test('a member overwrite that neither allows nor denies the view names nobody', () => {
    const audience = channelAudience({
      roles: rolesWith(0n),
      everyoneRoleId: EVERYONE,
      ownerId: OWNER,
      overwrites: [overwrite(MEMBER, 1, Permissions.SendMessages, 0n)],
    });

    expect(audience.memberIds).toEqual([]);
  });

  test('a server whose owner id is unknown still judges a role holder as a plain member', () => {
    const audience = channelAudience({
      roles: rolesWith(0n),
      everyoneRoleId: EVERYONE,
      ownerId: '',
      overwrites: [overwrite(EVERYONE, 0, 0n, VIEW)],
    });

    expect(audience.everyone).toBe(false);
    expect(audience.roleIds).toEqual([]);
  });
});
