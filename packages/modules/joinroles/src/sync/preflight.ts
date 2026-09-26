import {
  computeBasePermissions,
  type GuildState,
  hasWithAdmin,
  Permissions,
  permissionLabel,
} from '@proton/core';
import type { JoinrolesConfig } from '../config.ts';
import { grantableRoles } from '../grant.ts';
import type { BlockedRole, SyncFailure } from './view.ts';

export type SyncPreflight =
  | { ok: true; memberRoleIds: string[]; botRoleIds: string[]; blockedRoles: BlockedRole[] }
  | { ok: false; failure: SyncFailure; blockedRoles: BlockedRole[] };

export const NOTHING_TO_SYNC: SyncFailure = {
  code: 'nothing_to_sync',
  message:
    'No member or bot roles are set, so there is nothing to sync. Choose them and save first.',
};

export const MISSING_MANAGE_ROLES: SyncFailure = {
  code: 'missing_permission',
  message:
    `Proton is missing the ${permissionLabel('ManageRoles')} permission in this server. ` +
    "Turn it on for Proton's role in Server Settings → Roles, then sync again.",
};

export const ROLES_BLOCKED: SyncFailure = {
  code: 'roles_blocked',
  message: 'None of the join roles can be given.',
};

export function preflightSync(
  state: GuildState,
  config: Pick<JoinrolesConfig, 'memberRoleIds' | 'botRoleIds'>,
  botUserId: string,
): SyncPreflight {
  if (config.memberRoleIds.length === 0 && config.botRoleIds.length === 0) {
    return { ok: false, failure: NOTHING_TO_SYNC, blockedRoles: [] };
  }

  const permissions = computeBasePermissions({
    guildOwnerId: state.ownerId,
    everyoneRoleId: state.everyoneRoleId,
    memberId: botUserId,
    memberRoleIds: state.botRoleIds,
    roles: state.roles,
  });

  if (!hasWithAdmin(permissions, Permissions.ManageRoles)) {
    return { ok: false, failure: MISSING_MANAGE_ROLES, blockedRoles: [] };
  }

  const members = grantableRoles(state, config.memberRoleIds);
  const bots = grantableRoles(state, config.botRoleIds);

  const blocked = new Map<string, BlockedRole>();
  for (const { roleId, code } of [...members.refused, ...bots.refused]) {
    blocked.set(roleId, { roleId, code });
  }
  const blockedRoles = [...blocked.values()];

  if (members.grantable.length === 0 && bots.grantable.length === 0) {
    return { ok: false, failure: ROLES_BLOCKED, blockedRoles };
  }

  return {
    ok: true,
    memberRoleIds: members.grantable,
    botRoleIds: bots.grantable,
    blockedRoles,
  };
}
