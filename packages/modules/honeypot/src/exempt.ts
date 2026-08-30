import { computeBasePermissions, type GuildState, Permissions } from '@proton/core';
import type { HoneypotConfig } from './config.ts';

export const HONEYPOT_EXEMPT_REASONS = [
  'administrator',
  'admin_role',
  'role',
  'unknown_roles',
] as const;

export type HoneypotExemptReason = (typeof HONEYPOT_EXEMPT_REASONS)[number];

export const EXEMPT_LABEL: Record<HoneypotExemptReason, string> = {
  administrator: 'they hold Administrator',
  admin_role: 'they hold the exempt admin role',
  role: 'they hold an exempt role',
  unknown_roles: 'Proton could not read their roles',
};

export interface ExemptInput {
  config: HoneypotConfig;
  userId: string;
  roleIds: readonly string[] | null;
  state: GuildState | null;
}

function configured(config: HoneypotConfig): boolean {
  return (
    config.exemptAdministrators ||
    config.exemptAdminRoleId !== undefined ||
    config.exemptRoleIds.length > 0
  );
}

/**
 * Base permissions, never channel permissions: Administrator cannot be granted by a channel
 * overwrite, and computeBasePermissions already answers ALL_PERMISSIONS for the guild owner, so
 * exempting administrators covers the owner without a second branch.
 */
export function exemptReason(input: ExemptInput): HoneypotExemptReason | null {
  const { config, userId, roleIds, state } = input;

  if (!configured(config)) return null;

  // Exempt, not caught. This module's worst failure is acting on somebody it should not have, and
  // an unreadable member is exactly when it cannot tell.
  if (roleIds === null) return 'unknown_roles';

  if (config.exemptAdminRoleId !== undefined && roleIds.includes(config.exemptAdminRoleId)) {
    return 'admin_role';
  }

  if (roleIds.some((roleId) => config.exemptRoleIds.includes(roleId))) return 'role';

  if (!config.exemptAdministrators) return null;

  if (!state) return 'unknown_roles';

  const permissions = computeBasePermissions({
    guildOwnerId: state.ownerId,
    everyoneRoleId: state.everyoneRoleId,
    memberId: userId,
    memberRoleIds: roleIds,
    roles: state.roles,
  });

  return (permissions & Permissions.Administrator) === Permissions.Administrator
    ? 'administrator'
    : null;
}
