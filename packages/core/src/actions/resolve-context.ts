import { type GuildStateStore, highestRolePosition } from '../guild-state/types.ts';
import { computeChannelPermissions } from '../permissions/compute.ts';
import { requiredPermissionsFor, targetsMember } from './kinds.ts';
import type { PrecheckInput } from './prechecks.ts';
import type { ActionFailure, ActionRequest } from './types.ts';

export interface ResolveContextDeps {
  store: GuildStateStore;
  botUserId: string;
  /**
   * Fetch one member's role ids when the interaction did not resolve them.
   * A single-member fetch — never Request Guild Members (§10.4).
   */
  fetchMemberRoles?(guildId: string, userId: string): Promise<string[] | null>;
}

export interface ResolveContextHints {
  /** Channel the action affects. */
  channelId?: string | undefined;
  /**
   * `app_permissions` from the originating interaction. Discord resolves the
   * bot's effective permissions in that channel for us (§10.5), so when the
   * action targets the interaction's own channel this is both authoritative and
   * free — no REST call, no dependence on cache freshness.
   */
  appPermissions?: bigint | undefined;
  /** Target's role ids from `data.resolved.members`, when present. */
  targetRoleIds?: string[] | undefined;
}

export type ResolveContextResult = { context: PrecheckInput } | { failure: ActionFailure };

/**
 * Assemble the real state I8 needs.
 *
 * **This fails closed.** If guild state is missing, or a member-targeting action
 * cannot determine the target's roles, it returns a failure rather than a
 * permissive context. The Gate 0 stub did the opposite — it returned
 * `guildOwnerId: ''` and `botHighestRolePosition: MAX_SAFE_INTEGER`, values
 * engineered so `runPrechecks` always passed. Under that stub the bot would
 * cheerfully ban the server owner while every test stayed green.
 */
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

  // Prefer Discord's own computation for the interaction channel; fall back to
  // computing from cached overwrites for any other channel.
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
    // Fail closed: unknown roles means unknown hierarchy, and guessing here is
    // how a bot ends up acting on someone it outranks only on paper.
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
