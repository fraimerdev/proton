import type { RolemenuMenu } from './config.ts';

export const ROLEMENU_INTENTS = ['grant', 'revoke', 'toggle'] as const;
export type RolemenuIntent = (typeof ROLEMENU_INTENTS)[number];

export interface RoleChanges {
  roleId: string;
  add: string[];
  remove: string[];
}

export interface ResolveInput {
  menu: RolemenuMenu;
  bindingKey: string;
  intent: RolemenuIntent;

  currentRoleIds: readonly string[] | null;
}

function holds(currentRoleIds: readonly string[] | null, roleId: string): boolean | null {
  return currentRoleIds === null ? null : currentRoleIds.includes(roleId);
}

export function resolveRoleChanges(input: ResolveInput): RoleChanges | null {
  const { menu, bindingKey, intent, currentRoleIds } = input;

  const binding = menu.bindings.find((candidate) => candidate.key === bindingKey);
  if (!binding) return null;

  const roleId = binding.roleId;
  const held = holds(currentRoleIds, roleId);

  const direction = intent === 'toggle' ? (held === true ? 'revoke' : 'grant') : intent;

  if (direction === 'revoke') {
    if (menu.mode === 'add-only') return { roleId, add: [], remove: [] };
    return { roleId, add: [], remove: held === false ? [] : [roleId] };
  }

  const add = held === true ? [] : [roleId];

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
