import { describe, test } from 'bun:test';
import fc from 'fast-check';
import {
  ACTOR_ROLE_REFUSAL_CODES,
  type ActorRoleRefusalInput,
  actorRoleRefusal,
} from '../../src/guild-state/actor-roles.ts';
import { Permissions } from '../../src/permissions/bits.ts';

const EVERYONE = '900000000000000001';
const OWNER = '100000000000000001';
const ACTOR = '100000000000000002';
const ROLE_IDS = [
  '400000000000000001',
  '400000000000000002',
  '400000000000000003',
  '400000000000000004',
  '400000000000000005',
  '400000000000000006',
] as const;
const NOT_A_ROLE = '400000000000000099';

const role = fc.record({
  position: fc.integer({ min: 1, max: 12 }),
  managed: fc.boolean(),
});

const permissions = fc.oneof(
  fc.bigInt({ min: 0n, max: (1n << 53n) - 1n }),
  fc.constant(Permissions.ManageRoles),
  fc.constant(Permissions.Administrator),
  fc.constant(0n),
);

const input: fc.Arbitrary<ActorRoleRefusalInput> = fc
  .record({
    present: fc.subarray([...ROLE_IDS]),
    shapes: fc.array(role, { minLength: ROLE_IDS.length, maxLength: ROLE_IDS.length }),
    actorId: fc.constantFrom(OWNER, ACTOR),
    held: fc.option(fc.subarray([...ROLE_IDS, NOT_A_ROLE]), { nil: null }),
    actorPermissions: permissions,
    roleId: fc.constantFrom(...ROLE_IDS, EVERYONE, NOT_A_ROLE),
  })
  .map(({ present, shapes, actorId, held, actorPermissions, roleId }) => {
    const roles = new Map<string, { id: string; position: number; managed?: boolean }>([
      [EVERYONE, { id: EVERYONE, position: 0 }],
    ]);
    present.forEach((id, index) => {
      const shape = shapes[index] ?? { position: 1, managed: false };
      roles.set(id, { id, position: shape.position, managed: shape.managed });
    });

    return {
      roles,
      everyoneRoleId: EVERYONE,
      ownerId: OWNER,
      actorId,
      actorRoleIds: held,
      actorPermissions,
      roleId,
    };
  });

function highestHeld(value: ActorRoleRefusalInput): number {
  let highest = 0;
  for (const id of value.actorRoleIds ?? []) {
    highest = Math.max(highest, value.roles.get(id)?.position ?? 0);
  }
  return highest;
}

function canManageRoles(bits: bigint): boolean {
  return (
    (bits & Permissions.ManageRoles) === Permissions.ManageRoles ||
    (bits & Permissions.Administrator) === Permissions.Administrator
  );
}

describe('actorRoleRefusal properties', () => {
  test('never lets anyone but the owner give out a role at or above their own highest', () => {
    fc.assert(
      fc.property(input, (value) => {
        if (actorRoleRefusal(value) !== null || value.actorId === OWNER) return true;

        const target = value.roles.get(value.roleId);
        return target !== undefined && target.position < highestHeld(value);
      }),
      { numRuns: 1000 },
    );
  });

  test('never lets anyone but the owner give out a role without Manage Roles or Administrator', () => {
    fc.assert(
      fc.property(input, (value) => {
        const refusal = actorRoleRefusal(value);
        return (
          refusal !== null || value.actorId === OWNER || canManageRoles(value.actorPermissions)
        );
      }),
      { numRuns: 1000 },
    );
  });

  test('Administrator satisfies Manage Roles but never outranks a role above the actor', () => {
    fc.assert(
      fc.property(input, (value) => {
        const admin = { ...value, actorId: ACTOR, actorPermissions: Permissions.Administrator };
        const refusal = actorRoleRefusal(admin);

        if (refusal?.code === 'no_manage_roles') return false;

        const target = admin.roles.get(admin.roleId);
        const outranked =
          admin.actorRoleIds !== null &&
          target !== undefined &&
          target.managed !== true &&
          admin.roleId !== EVERYONE &&
          target.position >= highestHeld(admin);

        return !outranked || refusal?.code === 'above_actor';
      }),
      { numRuns: 1000 },
    );
  });

  test('the owner is refused only a role nobody could give out', () => {
    fc.assert(
      fc.property(input, (value) => {
        const refusal = actorRoleRefusal({ ...value, actorId: OWNER });
        return refusal === null || ['everyone', 'missing', 'managed'].includes(refusal.code);
      }),
      { numRuns: 1000 },
    );
  });

  test('@everyone, a missing role and a managed role are refused whoever asks', () => {
    fc.assert(
      fc.property(input, (value) => {
        const target = value.roles.get(value.roleId);
        const unassignable =
          value.roleId === EVERYONE || target === undefined || target.managed === true;

        return !unassignable || actorRoleRefusal(value) !== null;
      }),
      { numRuns: 1000 },
    );
  });

  test('roles the actor holds that the server no longer has change nothing', () => {
    fc.assert(
      fc.property(input, (value) => {
        if (value.actorRoleIds === null) return true;

        const without = {
          ...value,
          actorRoleIds: value.actorRoleIds.filter((id) => id !== NOT_A_ROLE),
        };
        const withGhost = { ...value, actorRoleIds: [...without.actorRoleIds, NOT_A_ROLE] };

        return actorRoleRefusal(without)?.code === actorRoleRefusal(withGhost)?.code;
      }),
      { numRuns: 1000 },
    );
  });

  test('holding one more role never turns a grant into a refusal', () => {
    fc.assert(
      fc.property(input, fc.constantFrom(...ROLE_IDS), (value, extra) => {
        if (value.actorRoleIds === null || actorRoleRefusal(value) !== null) return true;
        const wider = [...value.actorRoleIds, extra];
        return actorRoleRefusal({ ...value, actorRoleIds: wider }) === null;
      }),
      { numRuns: 1000 },
    );
  });

  test('roles that could not be read are refused for everyone but the owner', () => {
    fc.assert(
      fc.property(input, (value) => {
        const refusal = actorRoleRefusal({ ...value, actorId: ACTOR, actorRoleIds: null });
        return refusal !== null && !['above_actor', 'no_manage_roles'].includes(refusal.code);
      }),
      { numRuns: 1000 },
    );
  });

  test('every refusal is a known code and names the role without an em dash', () => {
    fc.assert(
      fc.property(input, (value) => {
        const refusal = actorRoleRefusal(value);
        if (refusal === null) return true;

        return (
          ACTOR_ROLE_REFUSAL_CODES.includes(refusal.code) &&
          refusal.reason.includes(`<@&${value.roleId}>`) &&
          !refusal.reason.includes('—') &&
          refusal.reason.endsWith('.')
        );
      }),
      { numRuns: 1000 },
    );
  });
});
