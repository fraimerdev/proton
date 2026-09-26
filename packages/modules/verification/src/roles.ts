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
        "I haven't loaded this server's roles yet, so I can't check the " +
        `${label} role. Try again in a moment.`,
    };
  }

  if (roleId === state.everyoneRoleId) {
    return {
      ok: false,
      reason:
        `The ${label} role is set to @everyone, which can't be given or removed. An admin ` +
        'needs to choose another role in the Proton dashboard.',
    };
  }

  const role = state.roles.get(roleId);
  if (!role) {
    return {
      ok: false,
      reason:
        `The ${label} role (ID ${roleId}) doesn't exist anymore, or I can't see it. An admin ` +
        'needs to choose another role in the Proton dashboard.',
    };
  }

  const botPosition = highestRolePosition(state.roles, state.botRoleIds);
  if (role.position >= botPosition) {
    return {
      ok: false,
      reason:
        `The ${label} role (<@&${roleId}>) is at or above my highest role, so I can't give ` +
        'or remove it. An admin needs to move my role above it in Server Settings → Roles.',
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
        (roleId): RoleStep => ({ kind: 'remove_role', roleId, what: `removing <@&${roleId}>` }),
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
        (roleId): RoleStep => ({ kind: 'add_role', roleId, what: `giving back <@&${roleId}>` }),
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
