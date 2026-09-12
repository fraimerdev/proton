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
        '@everyone is not a role I can hand out — every member already has it, and Discord does ' +
        'not allow it to be added or removed.',
    };
  }

  const role = state.roles.get(roleId);
  if (!role) {
    return {
      refusal:
        `I don't have <@&${roleId}> in this server's role list yet, so I can't check I'm ` +
        'allowed to hand it out. Try again shortly.',
    };
  }

  if (role.managed === true) {
    return {
      refusal:
        `<@&${roleId}> is managed by Discord — it belongs to a bot, an integration or Server ` +
        'Boosting, and nobody can assign it by hand, me included.',
    };
  }

  if (role.position >= highestRolePosition(state.roles, state.botRoleIds)) {
    return {
      refusal:
        `<@&${roleId}> is above or equal to my own highest role, so Discord will not let me ` +
        'hand it out. Move my role higher in Server Settings → Roles.',
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
        `<@&${roleId}> is above or equal to your own highest role, so I won't hand it out on ` +
        'your behalf — Discord would refuse you the same change.',
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
        `<@${input.targetId}>'s highest role is above or equal to your own, so I won't change ` +
        'their roles on your behalf — Discord would refuse you the same change.',
    };
  }

  return null;
}
