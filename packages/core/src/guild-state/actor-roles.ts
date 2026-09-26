import { hasWithAdmin, Permissions } from '../permissions/bits.ts';

export const ACTOR_ROLE_REFUSAL_CODES = [
  'everyone',
  'missing',
  'managed',
  'no_manage_roles',
  'unknown_actor_roles',
  'above_actor',
] as const;

export type ActorRoleRefusalCode = (typeof ACTOR_ROLE_REFUSAL_CODES)[number];

export interface ActorRoleRefusal {
  code: ActorRoleRefusalCode;
  reason: string;
}

export interface ActorRoleRefusalInput {
  roles: ReadonlyMap<string, { id: string; position: number; managed?: boolean }>;
  everyoneRoleId: string;
  ownerId: string;
  actorId: string;
  actorRoleIds: readonly string[] | null;
  actorPermissions: bigint;
  roleId: string;
}

export function actorRoleRefusal(input: ActorRoleRefusalInput): ActorRoleRefusal | null {
  const mention = `<@&${input.roleId}>`;

  if (input.roleId === input.everyoneRoleId) {
    return {
      code: 'everyone',
      reason: `${mention} is @everyone, which every member already has.`,
    };
  }

  const role = input.roles.get(input.roleId);
  if (!role) {
    return { code: 'missing', reason: `${mention} no longer exists in this server.` };
  }

  if (role.managed === true) {
    return {
      code: 'managed',
      reason:
        `${mention} is managed by Discord or an integration, so nobody can give it out by ` +
        'hand.',
    };
  }

  if (input.actorId === input.ownerId) return null;

  if (input.actorRoleIds === null) {
    return {
      code: 'unknown_actor_roles',
      reason:
        'The roles of the member making this change could not be read, so there is no way to ' +
        `check they rank above ${mention}.`,
    };
  }

  if (!hasWithAdmin(input.actorPermissions, Permissions.ManageRoles)) {
    return {
      code: 'no_manage_roles',
      reason:
        `Giving out ${mention} needs the Manage Roles permission, and the member making this ` +
        'change does not have it.',
    };
  }

  let highest = 0;
  for (const roleId of input.actorRoleIds) {
    const held = input.roles.get(roleId);
    if (held && held.position > highest) highest = held.position;
  }

  if (role.position >= highest) {
    return {
      code: 'above_actor',
      reason:
        `${mention} is at or above the highest role of the member making this change, and ` +
        'Discord only lets members give out roles below their own.',
    };
  }

  return null;
}
