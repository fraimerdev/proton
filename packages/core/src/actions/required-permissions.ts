import { Permissions } from '../permissions/bits.ts';
import type { ActionKind } from './types.ts';

/**
 * What the bot must be able to do for each action kind.
 *
 * A `Record<ActionKind, …>` rather than a lookup with a default: widening
 * `ActionKind` in P1.B will make the compiler name every kind missing an entry,
 * so a new moderation command cannot ship with its permission requirement
 * quietly unset (which would mean it never precheck-fails and instead fails at
 * Discord with a bare 403).
 */
export const REQUIRED_PERMISSIONS: Record<ActionKind, bigint> = {
  send: Permissions.ViewChannel | Permissions.SendMessages,

  // Deliberately zero. Discord always permits an app to respond to its own
  // interaction, even in a channel it could not otherwise post in. Requiring
  // SendMessages here would refuse legitimate replies.
  interaction_reply: 0n,
};

/**
 * Whether the kind acts *on a member*, and therefore needs the hierarchy,
 * owner and self prechecks (I8).
 */
export const TARGETS_MEMBER: Record<ActionKind, boolean> = {
  send: false,
  interaction_reply: false,
};

export function requiredPermissionsFor(kind: ActionKind): bigint {
  return REQUIRED_PERMISSIONS[kind];
}

export function targetsMember(kind: ActionKind): boolean {
  return TARGETS_MEMBER[kind];
}
