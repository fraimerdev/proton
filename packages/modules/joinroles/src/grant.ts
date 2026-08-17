import { type GuildState, highestRolePosition } from '@proton/core';

export interface GrantPlan {
  grant: string[];

  skipped: Array<{ roleId: string; reason: string }>;
}

export function planGrant(input: {
  state: GuildState | null;
  wantedRoleIds: readonly string[];
  heldRoleIds: readonly string[];
}): GrantPlan {
  const { state, wantedRoleIds, heldRoleIds } = input;

  // Unlike planRestore, a missing role list does not stop us. Restoring is guessing among a
  // member's old roles; granting is applying an explicit admin setting, so we try and let the
  // executor's precheck or Discord name the refusal.
  if (!state) {
    return { grant: [...new Set(wantedRoleIds)], skipped: [] };
  }

  const held = new Set(heldRoleIds);
  const botPosition = highestRolePosition(state.roles, state.botRoleIds);

  const grant: string[] = [];
  const skipped: GrantPlan['skipped'] = [];

  for (const roleId of new Set(wantedRoleIds)) {
    if (roleId === state.everyoneRoleId) {
      skipped.push({ roleId, reason: 'it is @everyone, which Discord grants automatically.' });
      continue;
    }

    if (held.has(roleId)) {
      skipped.push({ roleId, reason: 'the member already has it.' });
      continue;
    }

    const role = state.roles.get(roleId);
    if (!role) {
      skipped.push({
        roleId,
        reason:
          'it no longer exists in this server. Remove it from the Join Roles list in the Proton ' +
          'dashboard.',
      });
      continue;
    }

    if (role.managed) {
      skipped.push({
        roleId,
        reason: 'it is managed by Discord or another integration, so nobody can assign it by hand.',
      });
      continue;
    }

    if (role.position >= botPosition) {
      skipped.push({
        roleId,
        reason:
          `it sits at position ${role.position} and my own highest role is at position ` +
          `${botPosition}. Discord only lets me assign roles below my own — drag Proton's ` +
          'role above it in Server Settings → Roles.',
      });
      continue;
    }

    grant.push(roleId);
  }

  grant.sort((a, b) => (state.roles.get(a)?.position ?? 0) - (state.roles.get(b)?.position ?? 0));

  return { grant, skipped };
}
