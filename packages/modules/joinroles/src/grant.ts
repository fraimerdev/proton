import { type GuildState, roleGrantRefusal } from '@proton/core';
import type { GrantRefusalCode } from './sync/view.ts';

export interface GrantPlan {
  grant: string[];

  skipped: Array<{ roleId: string; reason: string }>;
}

export interface GrantRefusal {
  roleId: string;
  code: GrantRefusalCode;
  reason: string;
}

export interface GrantableRoles {
  grantable: string[];
  refused: GrantRefusal[];
}

const MISSING_ROLE_HINT =
  'Remove it from Member roles or Bot roles on the Join Roles page in the Proton dashboard.';

function refusal(state: GuildState, roleId: string): GrantRefusal | null {
  const why = roleGrantRefusal(state, roleId, MISSING_ROLE_HINT);
  return why === null ? null : { roleId, code: why.code, reason: why.reason };
}

function byPosition(state: GuildState, roleIds: string[]): string[] {
  return roleIds.sort(
    (a, b) => (state.roles.get(a)?.position ?? 0) - (state.roles.get(b)?.position ?? 0),
  );
}

export function grantableRoles(state: GuildState, roleIds: readonly string[]): GrantableRoles {
  const grantable: string[] = [];
  const refused: GrantRefusal[] = [];

  for (const roleId of new Set(roleIds)) {
    const why = refusal(state, roleId);
    if (why) refused.push(why);
    else grantable.push(roleId);
  }

  return { grantable: byPosition(state, grantable), refused };
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
  const { refused } = grantableRoles(state, wantedRoleIds);
  const refusedById = new Map(refused.map((entry) => [entry.roleId, entry]));

  const grant: string[] = [];
  const skipped: GrantPlan['skipped'] = [];

  for (const roleId of new Set(wantedRoleIds)) {
    const refusedRole = refusedById.get(roleId);

    if (refusedRole?.code === 'everyone') {
      skipped.push({ roleId, reason: refusedRole.reason });
      continue;
    }

    if (held.has(roleId)) {
      skipped.push({ roleId, reason: 'the member already has it.' });
      continue;
    }

    if (refusedRole) {
      skipped.push({ roleId, reason: refusedRole.reason });
      continue;
    }

    grant.push(roleId);
  }

  return { grant: byPosition(state, grant), skipped };
}
