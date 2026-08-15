import { ALL_PERMISSIONS, Permissions, TIMEOUT_ALLOWED_PERMISSIONS } from './bits.ts';

export interface Overwrite {
  id: string;
  type: 0 | 1;
  allow: bigint;
  deny: bigint;
}

export interface GuildRole {
  id: string;
  permissions: bigint;

  position: number;

  managed?: boolean;
}

export interface PermissionContext {
  guildOwnerId: string;

  everyoneRoleId: string;
  memberId: string;
  memberRoleIds: readonly string[];
  roles: ReadonlyMap<string, GuildRole>;

  communicationDisabledUntil?: number | null;
  now?: number;
}

export function computeBasePermissions(ctx: PermissionContext): bigint {
  if (ctx.memberId === ctx.guildOwnerId) return ALL_PERMISSIONS;

  let permissions = ctx.roles.get(ctx.everyoneRoleId)?.permissions ?? 0n;

  for (const roleId of ctx.memberRoleIds) {
    const role = ctx.roles.get(roleId);
    if (role) permissions |= role.permissions;
  }

  if ((permissions & Permissions.Administrator) === Permissions.Administrator) {
    return ALL_PERMISSIONS;
  }

  return permissions;
}

export function applyOverwrites(
  base: bigint,
  overwrites: readonly Overwrite[],
  ctx: PermissionContext,
): bigint {
  if ((base & Permissions.Administrator) === Permissions.Administrator) {
    return ALL_PERMISSIONS;
  }

  let permissions = base;

  const everyone = overwrites.find((o) => o.id === ctx.everyoneRoleId && o.type === 0);
  if (everyone) {
    permissions &= ~everyone.deny;
    permissions |= everyone.allow;
  }

  const memberRoles = new Set(ctx.memberRoleIds);
  let roleAllow = 0n;
  let roleDeny = 0n;

  for (const overwrite of overwrites) {
    if (overwrite.type !== 0) continue;
    if (overwrite.id === ctx.everyoneRoleId) continue;
    if (!memberRoles.has(overwrite.id)) continue;

    roleAllow |= overwrite.allow;
    roleDeny |= overwrite.deny;
  }

  permissions &= ~roleDeny;
  permissions |= roleAllow;

  const member = overwrites.find((o) => o.id === ctx.memberId && o.type === 1);
  if (member) {
    permissions &= ~member.deny;
    permissions |= member.allow;
  }

  return permissions;
}

export function computeChannelPermissions(
  ctx: PermissionContext,
  overwrites: readonly Overwrite[] = [],
  parentOverwrites?: readonly Overwrite[],
): bigint {
  const base = computeBasePermissions(ctx);
  const effective = overwrites.length > 0 ? overwrites : (parentOverwrites ?? []);
  const withOverwrites = applyOverwrites(base, effective, ctx);

  return applyTimeout(withOverwrites, ctx);
}

export function applyTimeout(permissions: bigint, ctx: PermissionContext): bigint {
  const until = ctx.communicationDisabledUntil;
  if (until == null) return permissions;

  const now = ctx.now ?? Date.now();
  if (until <= now) return permissions;
  if (ctx.memberId === ctx.guildOwnerId) return permissions;
  if ((permissions & Permissions.Administrator) === Permissions.Administrator) return permissions;

  return permissions & TIMEOUT_ALLOWED_PERMISSIONS;
}
