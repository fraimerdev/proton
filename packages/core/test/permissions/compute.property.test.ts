import { describe, test } from 'bun:test';
import fc from 'fast-check';
import { ALL_PERMISSIONS, has, Permissions } from '../../src/permissions/bits.ts';
import {
  applyOverwrites,
  computeBasePermissions,
  type Overwrite,
  type PermissionContext,
} from '../../src/permissions/compute.ts';

const EVERYONE = '100000000000000000';
const OWNER = '200000000000000000';
const MEMBER = '300000000000000000';
const ROLE_IDS = ['400000000000000001', '400000000000000002', '400000000000000003'] as const;

/** Arbitrary permission bitfield across the full 0..1<<53 range Discord uses. */
const permissionBits = fc.bigInt({ min: 0n, max: (1n << 53n) - 1n });

const overwriteArb: fc.Arbitrary<Overwrite> = fc.record({
  id: fc.constantFrom(EVERYONE, ...ROLE_IDS, MEMBER),
  type: fc.constantFrom<0 | 1>(0, 1),
  allow: permissionBits,
  deny: permissionBits,
});

function baseCtx(overrides: Partial<PermissionContext> = {}): PermissionContext {
  return {
    guildOwnerId: OWNER,
    everyoneRoleId: EVERYONE,
    memberId: MEMBER,
    memberRoleIds: ROLE_IDS,
    roles: new Map(),
    ...overrides,
  };
}

describe('permission math properties', () => {
  test('ADMINISTRATOR yields every permission for any overwrite set', () => {
    fc.assert(
      fc.property(fc.array(overwriteArb, { maxLength: 12 }), (overwrites) => {
        const result = applyOverwrites(ALL_PERMISSIONS, overwrites, baseCtx());
        return result === ALL_PERMISSIONS;
      }),
      { numRuns: 300 },
    );
  });

  test('the result never grants a bit absent from both the base and every allow', () => {
    fc.assert(
      fc.property(permissionBits, fc.array(overwriteArb, { maxLength: 12 }), (base, overwrites) => {
        // ADMINISTRATOR legitimately expands to everything; exclude it here.
        const nonAdminBase = base & ~Permissions.Administrator;
        const result = applyOverwrites(nonAdminBase, overwrites, baseCtx());

        const grantable = overwrites.reduce((acc, o) => acc | o.allow, nonAdminBase);
        return (result & ~grantable) === 0n;
      }),
      { numRuns: 300 },
    );
  });

  test('the guild owner always has everything, whatever their roles say', () => {
    fc.assert(
      fc.property(permissionBits, (everyonePerms) => {
        const result = computeBasePermissions(
          baseCtx({
            memberId: OWNER,
            roles: new Map([[EVERYONE, { id: EVERYONE, permissions: everyonePerms, position: 0 }]]),
          }),
        );
        return result === ALL_PERMISSIONS;
      }),
      { numRuns: 200 },
    );
  });

  /**
   * The bigint guard. Every bit at 1<<43 and above was introduced by the 2026
   * permission splits; doing this arithmetic in `number` silently drops them,
   * and the failure mode is "the bot mysteriously lacks a permission it was
   * granted" rather than a crash.
   */
  test('high bits survive the full overwrite pipeline intact', () => {
    const highBits = [
      Permissions.CreateGuildExpressions,
      Permissions.CreateEvents,
      Permissions.SetVoiceChannelStatus,
      Permissions.PinMessages,
      Permissions.BypassSlowmode,
    ];

    fc.assert(
      fc.property(fc.subarray(highBits, { minLength: 1 }), (bits) => {
        const granted = bits.reduce((acc, bit) => acc | bit, 0n);
        const result = applyOverwrites(granted, [], baseCtx());

        return bits.every((bit) => has(result, bit));
      }),
      { numRuns: 200 },
    );
  });

  test('applying an empty overwrite list is the identity', () => {
    fc.assert(
      fc.property(permissionBits, (base) => {
        const nonAdminBase = base & ~Permissions.Administrator;
        return applyOverwrites(nonAdminBase, [], baseCtx()) === nonAdminBase;
      }),
      { numRuns: 300 },
    );
  });

  test('a deny of everything leaves nothing, for any starting non-admin base', () => {
    fc.assert(
      fc.property(permissionBits, (base) => {
        const nonAdminBase = base & ~Permissions.Administrator;
        const overwrites: Overwrite[] = [
          { id: EVERYONE, type: 0, allow: 0n, deny: ALL_PERMISSIONS },
        ];

        const result = applyOverwrites(nonAdminBase, overwrites, baseCtx());
        return (result & ALL_PERMISSIONS) === 0n;
      }),
      { numRuns: 300 },
    );
  });
});
