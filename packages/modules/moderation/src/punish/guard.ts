import { type GuildState, highestRolePosition } from '@proton/core';
import type { Refusal } from '../perform.ts';
import type { PunishConfig, PunishKind } from './config.ts';
import { DIRECTION_VERB } from './types.ts';

export interface PunishGuardInput {
  state: Pick<GuildState, 'ownerId' | 'roles'>;
  actorId: string;
  actorRoleIds: readonly string[] | null | undefined;
  targetId: string;
  targetRoleIds: readonly string[];
  kind: PunishKind;
}

const WHERE =
  'This server only lets moderators punish members ranked below them (Moderation → Immunity).';

export function guardPunishTarget(input: PunishGuardInput): Refusal | null {
  const { state, kind } = input;
  const verb = DIRECTION_VERB[kind];

  if (input.targetId === state.ownerId) {
    return {
      refusal: `<@${input.targetId}> owns this server, so nobody can ${verb} them. Nothing was done.`,
    };
  }

  if (input.actorId === state.ownerId) return null;

  if (!input.actorRoleIds) {
    return {
      refusal:
        `I couldn't read your roles, so I can't check that you outrank <@${input.targetId}>. ` +
        `Nothing was done. ${WHERE}`,
    };
  }

  const actorHighest = highestRolePosition(state.roles, input.actorRoleIds);
  const targetHighest = highestRolePosition(state.roles, input.targetRoleIds);

  if (targetHighest >= actorHighest) {
    return {
      refusal:
        `<@${input.targetId}>'s highest role is the same as or above yours, so I won't ${verb} ` +
        `them for you. Nothing was done. ${WHERE}`,
    };
  }

  return null;
}

export function immuneRole(
  config: Pick<PunishConfig, 'immunity'>,
  kind: PunishKind,
  targetRoleIds: readonly string[],
): string | null {
  const held = new Set(targetRoleIds);
  const listed = [...config.immunity.global, ...config.immunity[kind]];

  return listed.find((roleId) => held.has(roleId)) ?? null;
}
