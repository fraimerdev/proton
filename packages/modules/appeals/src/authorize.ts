import { Permissions, type ProtonEvent } from '@proton/core';
import type { AppealPanel, AppealsConfig } from './config.ts';
import { reviewerRolesFor } from './config.ts';

// Manage Server, not Ban Members: accepting an appeal can also be an untimeout or nothing at all,
// and a server that lets its moderators ban should still choose who may overturn one.
export const REVIEWER_PERMISSIONS = Permissions.ManageGuild;

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

export function readPermissions(event: ProtonEvent): bigint {
  const raw = record(record(event.payload)?.member)?.permissions;
  if (typeof raw !== 'string') return 0n;

  try {
    return BigInt(raw);
  } catch {
    return 0n;
  }
}

export function readRoleIds(event: ProtonEvent): string[] {
  const roles = record(record(event.payload)?.member)?.roles;
  if (!Array.isArray(roles)) return [];

  return roles.filter((role): role is string => typeof role === 'string');
}

export type ReviewerCheck = { ok: true } | { ok: false; humanReason: string };

/**
 * A named reviewer role is a grant, not a filter: a server that names one is saying those people
 * may review whether or not Discord would otherwise let them. Manage Server always may.
 */
export function mayReview(
  config: AppealsConfig,
  panel: AppealPanel,
  permissions: bigint,
  roleIds: readonly string[],
): ReviewerCheck {
  if ((permissions & REVIEWER_PERMISSIONS) === REVIEWER_PERMISSIONS) return { ok: true };

  const allowed = reviewerRolesFor(config, panel);
  if (allowed.length > 0 && roleIds.some((roleId) => allowed.includes(roleId))) return { ok: true };

  return {
    ok: false,
    humanReason:
      allowed.length > 0
        ? 'Only this server’s appeal reviewers can decide this one.'
        : 'Only somebody with Manage Server can decide an appeal here. An admin can name a ' +
          'reviewer role under Appeals in the Proton dashboard.',
  };
}
