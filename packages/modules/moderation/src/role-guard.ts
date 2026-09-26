import { type GuildState, highestRolePosition } from '@proton/core';
import type { Refusal } from './perform.ts';

export interface RoleGuardInput {
  state: GuildState;
  roleId: string;
  actorId: string;
  actorRoleIds: string[] | undefined;
}

// Discord ranks a role change against the *actor's* highest role, and the executor's prechecks
// only ever judge Proton's. Without this a moderator with Manage Roles could name a role above
// their own and have Proton hand it out for them, which is exactly the escalation Discord refuses
// when they try it themselves.
export function guardRole(input: RoleGuardInput): Refusal | null {
  const { state, roleId } = input;

  if (roleId === state.everyoneRoleId) {
    return {
      refusal:
        "@everyone can't be added or removed. Every member already has it, and Discord doesn't " +
        'allow it to change.',
    };
  }

  const role = state.roles.get(roleId);
  if (!role) {
    return {
      refusal:
        `I don't have <@&${roleId}> in this server's role list yet, so I can't check that I'm ` +
        'allowed to change it. Try again in a moment.',
    };
  }

  if (role.managed === true) {
    return {
      refusal:
        `<@&${roleId}> is managed by Discord. It belongs to a bot, an integration or Server ` +
        'Boosting, so nobody can add or remove it by hand, including me.',
    };
  }

  if (role.position >= highestRolePosition(state.roles, state.botRoleIds)) {
    return {
      refusal:
        `<@&${roleId}> is at or above my highest role, so Discord won't let me add or remove ` +
        'it. Move my role higher in Server Settings → Roles.',
    };
  }

  if (input.actorId === state.ownerId) return null;

  if (input.actorRoleIds === undefined) {
    return {
      refusal:
        "I couldn't read your own roles, so I can't check that you outrank <@&" +
        `${roleId}>. Nothing was changed.`,
    };
  }

  if (role.position >= highestRolePosition(state.roles, input.actorRoleIds)) {
    return {
      refusal:
        `<@&${roleId}> is at or above your highest role, so I won't add or remove it for you. ` +
        "Discord wouldn't let you make that change yourself.",
    };
  }

  return null;
}

export interface TargetGuardInput {
  state: GuildState;
  actorId: string;
  actorRoleIds: string[] | undefined;
  targetId: string;
  targetRoleIds: readonly string[];
}

// The other half of Discord's actor-side rule: it refuses a role change unless the actor outranks
// the member being edited as well as the role being moved. guardRole covers the role; the
// executor's prechecks rank the target against Proton and never against the invoker. Without
// this, a junior moderator can have Proton put a mute role on an administrator — a change Discord
// refuses them outright when they make it themselves.
export function guardTarget(input: TargetGuardInput): Refusal | null {
  const { state } = input;

  // Discord lets you edit your own roles as long as the role itself is below you, and guardRole
  // has already established that.
  if (input.targetId === input.actorId) return null;

  if (input.actorId === state.ownerId) return null;

  if (input.actorRoleIds === undefined) {
    return {
      refusal:
        "I couldn't read your own roles, so I can't check that you outrank " +
        `<@${input.targetId}>. Nothing was changed.`,
    };
  }

  const actorHighest = highestRolePosition(state.roles, input.actorRoleIds);

  if (input.targetId === state.ownerId) {
    return { refusal: "I won't change the server owner's roles on your behalf." };
  }

  if (highestRolePosition(state.roles, input.targetRoleIds) >= actorHighest) {
    return {
      refusal:
        `<@${input.targetId}>'s highest role is at or above yours, so I won't change their ` +
        "roles for you. Discord wouldn't let you make that change yourself.",
    };
  }

  return null;
}
