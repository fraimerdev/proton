import type { RolemenuMenu } from './config.ts';

/**
 * Which way a choice points, decided by the event rather than by the config.
 *
 * A button press is a `toggle`: the member gets what they do not have and loses
 * what they do, subject to the menu's mode. A reaction is not — Discord tells us
 * separately that one was added or removed, and "unreact to give the role back"
 * is what every member already expects a reaction role to do. Folding both into
 * one "toggle" would make `reaction.removed` flip the role *on* for anyone whose
 * role had been removed elsewhere, which is the opposite of what the member just
 * asked for.
 */
export const ROLEMENU_INTENTS = ['grant', 'revoke', 'toggle'] as const;
export type RolemenuIntent = (typeof ROLEMENU_INTENTS)[number];

export interface RoleChanges {
  /** The role the chosen binding names — what the member actually asked about. */
  roleId: string;
  add: string[];
  remove: string[];
}

export interface ResolveInput {
  menu: RolemenuMenu;
  bindingKey: string;
  intent: RolemenuIntent;
  /**
   * The member's roles as the dispatch reported them, or `null` when it did not.
   *
   * `null` is a real case, not a placeholder: MESSAGE_REACTION_REMOVE carries no
   * member object at all, so an un-react tells us who and where and nothing about
   * what they hold. It is distinguished from "holds nothing" because collapsing
   * the two would make an un-react remove nothing — the member appears not to
   * have the role, so there would be nothing to take away.
   */
  currentRoleIds: readonly string[] | null;
}

/** `true`/`false` when the dispatch told us, `null` when it did not. */
function holds(currentRoleIds: readonly string[] | null, roleId: string): boolean | null {
  return currentRoleIds === null ? null : currentRoleIds.includes(roleId);
}

/**
 * Decide what moves, given a menu, the choice that was made and what the member
 * already had.
 *
 * Pure, and the only place the three modes are interpreted. Returns `null` when
 * the key names no binding in this menu — a menu whose bindings were edited
 * after its message was posted, which the callers answer by saying so rather
 * than by silently doing nothing.
 *
 * The rule under all three modes is **act unless we know it is unnecessary**.
 * `PUT` and `DELETE` on a member role are both idempotent at Discord, so acting
 * under uncertainty costs one redundant call and leaves the member in the right
 * state, while declining to act under uncertainty leaves them in the wrong one
 * with nothing to say why.
 */
export function resolveRoleChanges(input: ResolveInput): RoleChanges | null {
  const { menu, bindingKey, intent, currentRoleIds } = input;

  const binding = menu.bindings.find((candidate) => candidate.key === bindingKey);
  if (!binding) return null;

  const roleId = binding.roleId;
  const held = holds(currentRoleIds, roleId);

  // An unknown role set toggles towards granting. The safe direction: a member
  // who presses a button and unexpectedly *gains* a role can press it again, and
  // one who unexpectedly loses one may not be able to get it back.
  const direction = intent === 'toggle' ? (held === true ? 'revoke' : 'grant') : intent;

  if (direction === 'revoke') {
    // `add-only` is the whole point of the mode: nothing this module does ever
    // takes the role away, whichever way the member pressed.
    if (menu.mode === 'add-only') return { roleId, add: [], remove: [] };
    return { roleId, add: [], remove: held === false ? [] : [roleId] };
  }

  const add = held === true ? [] : [roleId];

  /**
   * `unique` strips the rest of this menu, and only this menu.
   *
   * Bound roles the member does not hold are left alone so a colour picker costs
   * one call rather than one per colour — but with an unknown role set every
   * other bound role is stripped, because "which of the other colours do they
   * have" is exactly the question the dispatch failed to answer and the end state
   * is the same either way.
   */
  const remove =
    menu.mode === 'unique'
      ? [
          ...new Set(
            menu.bindings
              .map((candidate) => candidate.roleId)
              .filter((other) => other !== roleId && holds(currentRoleIds, other) !== false),
          ),
        ]
      : [];

  return { roleId, add, remove };
}
