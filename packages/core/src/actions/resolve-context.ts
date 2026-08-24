import { z } from 'zod';
import { type GuildStateStore, highestRolePosition } from '../guild-state/types.ts';
import { computeChannelPermissions } from '../permissions/compute.ts';
import {
  hierarchyApplies,
  isChannelScoped,
  requiredPermissionsFor,
  targetsMember,
} from './kinds.ts';
import { snowflakeSchema, THREAD_TYPE_PRIVATE, THREAD_TYPE_PUBLIC } from './payloads.ts';
import type { PrecheckInput } from './prechecks.ts';
import type { ActionFailure, ActionRequest } from './types.ts';

const channelScopedPayloadSchema = z.object({ channelId: snowflakeSchema });

const THREAD_TYPE_ANNOUNCEMENT = 10;

const THREAD_CHANNEL_TYPES: ReadonlySet<number> = new Set([
  THREAD_TYPE_ANNOUNCEMENT,
  THREAD_TYPE_PUBLIC,
  THREAD_TYPE_PRIVATE,
]);

interface ChannelTypeCarrier {
  id: string;
  type?: number;
}

function isThread(channel: ChannelTypeCarrier | undefined): boolean {
  return channel?.type !== undefined && THREAD_CHANNEL_TYPES.has(channel.type);
}

function actionChannelId(request: ActionRequest, hints: ResolveContextHints): string | undefined {
  if (!isChannelScoped(request.kind)) return undefined;

  const parsed = channelScopedPayloadSchema.safeParse(request.payload);
  return parsed.success ? parsed.data.channelId : hints.channelId;
}

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

  const channelId = actionChannelId(request, hints);

  // Not `channelId === hints.channelId` alone: with both undefined that is trivially true, and a
  // guild-scoped action would be judged by the app_permissions of the channel it was typed in.
  const appPermissions =
    channelId !== undefined && channelId === hints.channelId ? hints.appPermissions : undefined;

  const channel = channelId ? state.channels.get(channelId) : undefined;

  const inThread = isThread(channel);
  const required = requiredPermissionsFor(request.kind, request.payload, inThread);
  const threadParentId = inThread ? (channel?.parentId ?? undefined) : undefined;

  const botChannelPermissions =
    appPermissions ??
    computeChannelPermissions(
      {
        guildOwnerId: state.ownerId,
        everyoneRoleId: state.everyoneRoleId,
        memberId: deps.botUserId,
        memberRoleIds: state.botRoleIds,
        roles: state.roles,
      },
      channel?.overwrites ?? [],
      state.channels.get(channel?.parentId ?? '')?.overwrites ?? [],
    );

  const context: PrecheckInput = {
    guildId: request.guildId,
    guildOwnerId: state.ownerId,
    botUserId: deps.botUserId,
    botHighestRolePosition: highestRolePosition(state.roles, state.botRoleIds),
    botChannelPermissions,
    requiredPermissions: required,
    ...(channelId ? { channelId } : {}),
    ...(threadParentId ? { threadParentId } : {}),
    ...(channelId && !channel && appPermissions === undefined
      ? { channelOverwritesUnknown: true }
      : {}),
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

  // A kind Discord does not rank needs no role lookup: fetching them anyway spent a member fetch
  // per voice move and turned a cold member cache into a refused move ('target_state_unavailable')
  // for an action whose only requirement is MOVE_MEMBERS.
  if (!hierarchyApplies(request.kind)) {
    return {
      context: { ...context, hierarchy: false, target: { id: targetId, highestRolePosition: 0 } },
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
