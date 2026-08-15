import { Permissions } from '../permissions/bits.ts';

/**
 * Every state change Proton can make (PLAN.md §4-P3, widened for Gate 1).
 *
 * The union is the source of truth. `REQUIRED_PERMISSIONS`, `TARGETS_MEMBER`
 * and the executor's payload switch are all `Record<ActionKind, …>` or
 * exhaustive switches, so adding a kind makes the compiler name every place
 * that must account for it. A kind cannot ship half-wired.
 */
export const ACTION_KINDS = [
  'send',
  'interaction_reply',
  'ban',
  'unban',
  'kick',
  'timeout',
  'untimeout',
  'add_role',
  'remove_role',
  'purge',
  'slowmode',
  'lockdown',
  'unlock',
] as const;

export type ActionKind = (typeof ACTION_KINDS)[number];

/**
 * Narrow a string read back from storage.
 *
 * `scheduled_actions.kind` is a text column written by a possibly older build,
 * so it is a claim about an action kind rather than one of ours.
 */
export function isActionKind(value: string): value is ActionKind {
  return (ACTION_KINDS as readonly string[]).includes(value);
}

/**
 * What the bot must be able to do for each kind.
 *
 * `interaction_reply` is deliberately zero: Discord always permits an app to
 * answer its own interaction, even in a channel it could not otherwise post in.
 * Requiring SendMessages there would refuse legitimate replies — including the
 * reply explaining why some *other* action was refused.
 */
export const REQUIRED_PERMISSIONS: Record<ActionKind, bigint> = {
  send: Permissions.ViewChannel | Permissions.SendMessages,
  interaction_reply: 0n,

  ban: Permissions.BanMembers,
  unban: Permissions.BanMembers,
  kick: Permissions.KickMembers,
  timeout: Permissions.ModerateMembers,
  untimeout: Permissions.ModerateMembers,

  add_role: Permissions.ManageRoles,
  remove_role: Permissions.ManageRoles,

  // Bulk delete needs history access to see what it is deleting.
  purge: Permissions.ManageMessages | Permissions.ReadMessageHistory,
  slowmode: Permissions.ManageChannels,

  // Channel overwrites are governed by MANAGE_ROLES, not MANAGE_CHANNELS.
  lockdown: Permissions.ManageRoles,
  unlock: Permissions.ManageRoles,
};

/**
 * Whether the kind acts on a guild member, and so needs the hierarchy, owner
 * and self prechecks (I8).
 *
 * `unban` is false on purpose: a banned user is not a member, has no roles in
 * the guild, and there is no hierarchy to respect. Marking it true would make
 * every unban fail closed on an unresolvable member.
 */
export const TARGETS_MEMBER: Record<ActionKind, boolean> = {
  send: false,
  interaction_reply: false,

  ban: true,
  unban: false,
  kick: true,
  timeout: true,
  untimeout: true,
  add_role: true,
  remove_role: true,

  purge: false,
  slowmode: false,
  lockdown: false,
  unlock: false,
};

/**
 * Kinds that undo another kind.
 *
 * A kind absent here cannot carry an `expiresAt`: the executor refuses the
 * request rather than performing an action nothing will ever lift.
 * `planReversal` translates each pairing's payload.
 */
export const REVERSAL_OF: Partial<Record<ActionKind, ActionKind>> = {
  ban: 'unban',
  timeout: 'untimeout',
  add_role: 'remove_role',
  lockdown: 'unlock',
};

export function requiredPermissionsFor(kind: ActionKind): bigint {
  return REQUIRED_PERMISSIONS[kind];
}

export function targetsMember(kind: ActionKind): boolean {
  return TARGETS_MEMBER[kind];
}

export function reversalOf(kind: ActionKind): ActionKind | undefined {
  return REVERSAL_OF[kind];
}

/** Kinds whose effect is destructive and so default to dry-run in dev (I12). */
export const DESTRUCTIVE_KINDS: ReadonlySet<ActionKind> = new Set<ActionKind>([
  'ban',
  'kick',
  'purge',
  'lockdown',
]);

export function isDestructive(kind: ActionKind): boolean {
  return DESTRUCTIVE_KINDS.has(kind);
}
