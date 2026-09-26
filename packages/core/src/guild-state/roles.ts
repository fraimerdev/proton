import { type GuildState, highestRolePosition } from './types.ts';

export const ROLE_GRANT_REFUSAL_CODES = ['everyone', 'missing', 'managed', 'above_proton'] as const;

export type RoleGrantRefusalCode = (typeof ROLE_GRANT_REFUSAL_CODES)[number];

export interface RoleGrantRefusal {
  code: RoleGrantRefusalCode;
  reason: string;
}

export function roleGrantRefusal(
  state: GuildState,
  roleId: string,
  missingHint?: string,
): RoleGrantRefusal | null {
  if (roleId === state.everyoneRoleId) {
    return { code: 'everyone', reason: 'it is @everyone, which Discord grants automatically.' };
  }

  const role = state.roles.get(roleId);
  if (!role) {
    return {
      code: 'missing',
      reason:
        missingHint === undefined
          ? 'it no longer exists in this server.'
          : `it no longer exists in this server. ${missingHint}`,
    };
  }

  if (role.managed) {
    return {
      code: 'managed',
      reason: 'it is managed by Discord or another integration, so nobody can assign it by hand.',
    };
  }

  const botPosition = highestRolePosition(state.roles, state.botRoleIds);
  if (role.position >= botPosition) {
    return {
      code: 'above_proton',
      reason:
        `it sits at position ${role.position}, and Proton's highest role is at position ` +
        `${botPosition}. Discord only lets Proton assign roles below its own, so drag Proton's ` +
        'role above it in Server Settings → Roles.',
    };
  }

  return null;
}
