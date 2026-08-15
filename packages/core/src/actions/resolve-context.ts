import { type GuildStateStore, highestRolePosition } from '../guild-state/types.ts';
import { computeChannelPermissions } from '../permissions/compute.ts';
import { requiredPermissionsFor, targetsMember } from './kinds.ts';
import type { PrecheckInput } from './prechecks.ts';
import type { ActionFailure, ActionRequest } from './types.ts';

export interface ResolveContextDeps {
  store: GuildStateStore;
  botUserId: string;

  fetchMemberRoles?(guildId: string, userId: string): Promise<string[] | null>;
}

export interface ResolveContextHints {
  channelId?: string | undefined;

  appPermissions?: bigint | undefined;

  targetRoleIds?: string[] | undefined;
}

export type ResolveContextResult = { context: PrecheckInput } | { failure: ActionFailure };

export async function resolvePrecheckContext(
  deps: ResolveContextDeps,
  request: ActionRequest,
  hints: ResolveContextHints = {},
): Promise<ResolveContextResult> {
  const state = await deps.store.get(request.guildId);

  if (!state) {
    return {
      failure: {
        code: 'guild_state_unavailable',
        humanReason:
          "I don't have this server's role and channel state yet, so I can't safely check " +
          'whether this action is allowed. Try again shortly.',
      },
    };
  }

  const required = requiredPermissionsFor(request.kind);

  const botChannelPermissions =
    hints.appPermissions ??
    computeChannelPermissions(
      {
        guildOwnerId: state.ownerId,
        everyoneRoleId: state.everyoneRoleId,
        memberId: deps.botUserId,
        memberRoleIds: state.botRoleIds,
        roles: state.roles,
      },
      hints.channelId ? (state.channels.get(hints.channelId)?.overwrites ?? []) : [],
      hints.channelId
        ? (state.channels.get(state.channels.get(hints.channelId)?.parentId ?? '')?.overwrites ??
            [])
        : [],
    );

  const context: PrecheckInput = {
    guildId: request.guildId,
    guildOwnerId: state.ownerId,
    botUserId: deps.botUserId,
    botHighestRolePosition: highestRolePosition(state.roles, state.botRoleIds),
    botChannelPermissions,
    requiredPermissions: required,
    ...(hints.channelId ? { channelId: hints.channelId } : {}),
  };

  if (!targetsMember(request.kind)) {
    return { context };
  }

  const targetId = request.targetId;
  if (!targetId) {
    return {
      failure: {
        code: 'missing_target',
        humanReason: `The '${request.kind}' action needs a target member, but none was supplied.`,
      },
    };
  }

  const roleIds = hints.targetRoleIds ?? (await deps.fetchMemberRoles?.(request.guildId, targetId));

  if (!roleIds) {
    return {
      failure: {
        code: 'target_state_unavailable',
        humanReason:
          "I couldn't look up that member's roles, so I can't confirm I'm allowed to act on " +
          'them. This usually means they just left the server.',
      },
    };
  }

  return {
    context: {
      ...context,
      target: { id: targetId, highestRolePosition: highestRolePosition(state.roles, roleIds) },
    },
  };
}
