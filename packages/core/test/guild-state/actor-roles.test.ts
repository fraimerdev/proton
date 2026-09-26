import { describe, expect, test } from 'bun:test';
import { type ActorRoleRefusalInput, actorRoleRefusal } from '../../src/guild-state/actor-roles.ts';
import { Permissions } from '../../src/permissions/bits.ts';

const EVERYONE = '900000000000000001';
const OWNER = '100000000000000001';
const ACTOR = '100000000000000002';
const HELPER = '400000000000000001';
const MODERATOR = '400000000000000002';
const ADMIN = '400000000000000003';
const BOOSTER = '400000000000000004';

const roles = new Map([
  [EVERYONE, { id: EVERYONE, position: 0 }],
  [HELPER, { id: HELPER, position: 2 }],
  [MODERATOR, { id: MODERATOR, position: 5 }],
  [ADMIN, { id: ADMIN, position: 9 }],
  [BOOSTER, { id: BOOSTER, position: 3, managed: true }],
]);

function asking(overrides: Partial<ActorRoleRefusalInput>): ActorRoleRefusalInput {
  return {
    roles,
    everyoneRoleId: EVERYONE,
    ownerId: OWNER,
    actorId: ACTOR,
    actorRoleIds: [MODERATOR],
    actorPermissions: Permissions.ManageRoles,
    roleId: HELPER,
    ...overrides,
  };
}

describe('actorRoleRefusal', () => {
  test('lets a member with Manage Roles give out a role below their own', () => {
    expect(actorRoleRefusal(asking({}))).toBeNull();
  });

  test('refuses a role at the actor’s own rank, as Discord does', () => {
    expect(actorRoleRefusal(asking({ roleId: MODERATOR }))?.code).toBe('above_actor');
  });

  test('refuses a role above the actor and names it', () => {
    const refusal = actorRoleRefusal(asking({ roleId: ADMIN }));

    expect(refusal?.code).toBe('above_actor');
    expect(refusal?.reason).toContain(`<@&${ADMIN}>`);
  });

  test('refuses a member without Manage Roles', () => {
    expect(actorRoleRefusal(asking({ actorPermissions: Permissions.KickMembers }))?.code).toBe(
      'no_manage_roles',
    );
  });

  test('takes Administrator for Manage Roles but still ranks the role', () => {
    const admin = { actorPermissions: Permissions.Administrator };

    expect(actorRoleRefusal(asking(admin))).toBeNull();
    expect(actorRoleRefusal(asking({ ...admin, roleId: ADMIN }))?.code).toBe('above_actor');
  });

  test('lets the owner give out any role Discord allows, whatever they hold', () => {
    expect(
      actorRoleRefusal(
        asking({ actorId: OWNER, actorRoleIds: [], actorPermissions: 0n, roleId: ADMIN }),
      ),
    ).toBeNull();
  });

  test('refuses @everyone, a deleted role and a managed role even for the owner', () => {
    const owner = { actorId: OWNER };

    expect(actorRoleRefusal(asking({ ...owner, roleId: EVERYONE }))?.code).toBe('everyone');
    expect(actorRoleRefusal(asking({ ...owner, roleId: '400000000000000099' }))?.code).toBe(
      'missing',
    );
    expect(actorRoleRefusal(asking({ ...owner, roleId: BOOSTER }))?.code).toBe('managed');
  });

  test('refuses when the actor’s roles could not be read, rather than guessing', () => {
    const refusal = actorRoleRefusal(asking({ actorRoleIds: null }));

    expect(refusal?.code).toBe('unknown_actor_roles');
    expect(refusal?.reason).toContain(`<@&${HELPER}>`);
  });

  test('a member holding only @everyone can give out nothing', () => {
    expect(actorRoleRefusal(asking({ actorRoleIds: [] }))?.code).toBe('above_actor');
  });
});
