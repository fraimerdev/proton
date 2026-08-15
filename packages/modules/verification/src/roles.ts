import { type GuildState, highestRolePosition } from '@proton/core';
import type { QuarantineRecord } from './store.ts';

export interface RoleStep {
  kind: 'add_role' | 'remove_role';
  roleId: string;

  what: string;
}

export type RoleCheck = { ok: true } | { ok: false; reason: string };

export function checkGrantable(state: GuildState | null, roleId: string, label: string): RoleCheck {
  if (!state) {
    return {
      ok: false,
      reason:
        "I don't have this server's role list yet, so I can't tell whether I'm allowed to " +
        `move the ${label} role. Try again shortly.`,
    };
  }

  if (roleId === state.everyoneRoleId) {
    return {
      ok: false,
      reason:
        `The ${label} role is set to @everyone, which Discord does not let anyone add or ` +
        'remove. Pick a real role in the Proton dashboard.',
    };
  }

  const role = state.roles.get(roleId);
  if (!role) {
    return {
      ok: false,
      reason:
        `The ${label} role (id ${roleId}) doesn't exist in this server any more, or I can't ` +
        'see it. Choose a role that exists in the Proton dashboard.',
    };
  }

  const botPosition = highestRolePosition(state.roles, state.botRoleIds);
  if (role.position >= botPosition) {
    return {
      ok: false,
      reason:
        `I can't grant the ${label} role (id ${roleId}): it sits at position ${role.position} ` +
        `and my own highest role is at position ${botPosition}. Discord only lets me assign ` +
        "roles below my own. Drag Proton's role above it in Server Settings → Roles.",
    };
  }

  return { ok: true };
}

function positionOf(state: GuildState, roleId: string): number {
  return state.roles.get(roleId)?.position ?? 0;
}

export interface QuarantinePlan {
  priorRoleIds: string[];
  steps: RoleStep[];
}

export function planQuarantine(input: {
  state: GuildState;
  memberRoleIds: readonly string[];
  quarantineRoleId: string;
}): QuarantinePlan {
  const { state, memberRoleIds, quarantineRoleId } = input;

  const priorRoleIds = [
    ...new Set(
      memberRoleIds.filter(
        (roleId) => roleId !== state.everyoneRoleId && roleId !== quarantineRoleId,
      ),
    ),
  ].sort((a, b) => positionOf(state, b) - positionOf(state, a));

  return {
    priorRoleIds,
    steps: [
      ...priorRoleIds.map(
        (roleId): RoleStep => ({ kind: 'remove_role', roleId, what: `removing role ${roleId}` }),
      ),
      {
        kind: 'add_role',
        roleId: quarantineRoleId,
        what: 'applying the quarantine role',
      },
    ],
  };
}

export interface ReleasePlan {
  steps: RoleStep[];

  vanishedRoleIds: string[];

  ungrantableRoleIds: string[];
}

export function planRelease(input: {
  state: GuildState;
  record: QuarantineRecord;
  quarantineRoleId: string;
}): ReleasePlan {
  const { state, record, quarantineRoleId } = input;

  const vanishedRoleIds: string[] = [];
  const ungrantableRoleIds: string[] = [];
  const restorable: string[] = [];

  for (const roleId of record.priorRoleIds) {
    const check = checkGrantable(state, roleId, 'recorded');
    if (check.ok) {
      restorable.push(roleId);
    } else if (state.roles.has(roleId)) {
      ungrantableRoleIds.push(roleId);
    } else {
      vanishedRoleIds.push(roleId);
    }
  }

  return {
    steps: [
      ...restorable.map(
        (roleId): RoleStep => ({ kind: 'add_role', roleId, what: `restoring role ${roleId}` }),
      ),
      {
        kind: 'remove_role',
        roleId: quarantineRoleId,
        what: 'removing the quarantine role',
      },
    ],
    vanishedRoleIds,
    ungrantableRoleIds,
  };
}
