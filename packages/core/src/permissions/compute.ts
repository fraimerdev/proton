import { ALL_PERMISSIONS, Permissions, TIMEOUT_ALLOWED_PERMISSIONS } from './bits.ts';

/** A channel permission overwrite. `type` follows Discord: 0 = role, 1 = member. */
export interface Overwrite {
  id: string;
  type: 0 | 1;
  allow: bigint;
  deny: bigint;
}

export interface GuildRole {
  id: string;
  permissions: bigint;
  /**
   * Vertical position in the role list. Permission computation ignores it, but
   * hierarchy prechecks (I8) cannot work without it — a bot may only act on
   * members whose highest role sits strictly below its own.
   */
  position: number;
  /**
   * Discord owns this role — a booster role, an integration's role, another
   * bot's role.
   *
   * Permission computation ignores it, like `position`. It matters to anything
   * that *assigns* roles: Discord answers 403 for a managed role regardless of
   * hierarchy, so attempting one spends a rate-limit token to be told no, and the
   * 403 names neither the role nor the reason. Sticky-role restore checks it.
   *
   * Optional because a `GuildState` built before this field existed, or from a
   * payload that omitted it, should read as "not known to be managed" rather than
   * failing to parse — the check that consumes it fails open, and a role that is
   * genuinely managed still fails at Discord with the behaviour it had before.
   */
  managed?: boolean;
}

export interface PermissionContext {
  guildOwnerId: string;
  /** The guild's @everyone role id — equal to the guild id on Discord. */
  everyoneRoleId: string;
  memberId: string;
  memberRoleIds: readonly string[];
  roles: ReadonlyMap<string, GuildRole>;
  /** Epoch ms; a member is timed out while this is in the future. */
  communicationDisabledUntil?: number | null;
  now?: number;
}

/**
 * Guild-level permissions, before any channel overwrites.
 *
 * Order matters: owner short-circuits, then @everyone unions with every role the
 * member holds, then ADMINISTRATOR short-circuits.
 */
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

/**
 * Apply a channel's overwrites to already-computed base permissions.
 *
 * Discord's documented order, and the order matters at every step:
 *   1. @everyone deny, then @everyone allow
 *   2. the union of all role denies, then the union of all role allows
 *   3. the member-specific deny, then allow
 *
 * Role overwrites are accumulated and applied as one pair rather than role by
 * role. Applying them individually would let one role's allow silently reinstate
 * a permission a later role denied, which is the classic source of "why can they
 * still post in there" bugs.
 */
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

/**
 * Effective permissions for a member in a channel.
 *
 * `parentOverwrites` models a synced channel: Discord copies a category's
 * overwrites onto synced children, so a channel with none of its own inherits
 * the category's.
 */
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

/**
 * A timed-out member keeps only VIEW_CHANNEL and READ_MESSAGE_HISTORY.
 *
 * The guild owner is exempt — Discord cannot time out the owner, and PLAN.md §15
 * is explicit that trying to act on the owner is a losing game.
 */
export function applyTimeout(permissions: bigint, ctx: PermissionContext): bigint {
  const until = ctx.communicationDisabledUntil;
  if (until == null) return permissions;

  const now = ctx.now ?? Date.now();
  if (until <= now) return permissions;
  if (ctx.memberId === ctx.guildOwnerId) return permissions;
  if ((permissions & Permissions.Administrator) === Permissions.Administrator) return permissions;

  return permissions & TIMEOUT_ALLOWED_PERMISSIONS;
}
