import { z } from 'zod';
import {
  type GuildState,
  type GuildStateStore,
  highestRolePosition,
} from '../guild-state/types.ts';
import { has, Permissions } from '../permissions/bits.ts';
import { computeBasePermissions, computeChannelPermissions } from '../permissions/compute.ts';
import {
  hierarchyApplies,
  isChannelScopedFor,
  refusedOnAdministrators,
  requiredPermissionsFor,
  targetsMember,
} from './kinds.ts';
import {
  deleteRolePayloadSchema,
  roleChangePayloadSchema,
  snowflakeSchema,
  THREAD_TYPE_PRIVATE,
  THREAD_TYPE_PUBLIC,
} from './payloads.ts';
import type { PrecheckInput } from './prechecks.ts';
import type { ActionFailure, ActionRequest } from './types.ts';

const channelScopedPayloadSchema = z.object({ channelId: snowflakeSchema });

const directMessagePayloadSchema = z.object({
  channelId: snowflakeSchema,
  directMessage: z.literal(true),
});

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
  if (!isChannelScopedFor(request.kind, request.payload)) return undefined;

  const parsed = channelScopedPayloadSchema.safeParse(request.payload);
  return parsed.success ? parsed.data.channelId : hints.channelId;
}

function isDirectMessage(request: ActionRequest, state: GuildState | null): boolean {
  if (request.kind === 'create_dm') return true;
  if (request.kind !== 'send') return false;

  const parsed = directMessagePayloadSchema.safeParse(request.payload);
  return parsed.success && !state?.channels.has(parsed.data.channelId);
}

function roleSubjectId(request: ActionRequest): string | undefined {
  if (request.kind === 'delete_role') {
    const parsed = deleteRolePayloadSchema.safeParse(request.payload);
    return parsed.success ? parsed.data.roleId : undefined;
  }

  if (request.kind === 'add_role' || request.kind === 'remove_role') {
    const parsed = roleChangePayloadSchema.safeParse(request.payload);
    return parsed.success ? parsed.data.roleId : undefined;
  }

  return undefined;
}

function holdsAdministrator(state: GuildState, memberId: string, roleIds: string[]): boolean {
  const permissions = computeBasePermissions({
    guildOwnerId: state.ownerId,
    everyoneRoleId: state.everyoneRoleId,
    memberId,
    memberRoleIds: roleIds,
    roles: state.roles,
  });

  return has(permissions, Permissions.Administrator);
}

export type MemberRolesLookup = string[] | 'not_member' | null;

export interface ResolveContextDeps {
  store: GuildStateStore;
  botUserId: string;

  fetchMemberRoles?(guildId: string, userId: string): Promise<MemberRolesLookup>;
}

export interface ResolveContextHints {
  channelId?: string | undefined;

  appPermissions?: bigint | undefined;

  targetRoleIds?: string[] | undefined;

  targetAbsent?: boolean | undefined;
}

export type ResolveContextResult = { context: PrecheckInput } | { failure: ActionFailure };

export async function resolvePrecheckContext(
  deps: ResolveContextDeps,
  request: ActionRequest,
  hints: ResolveContextHints = {},
): Promise<ResolveContextResult> {
  const state = await deps.store.get(request.guildId);

  // Ahead of the state check, which a DM does not need; a channel the state knows is never a DM.
  if (isDirectMessage(request, state)) {
    return {
      context: {
        guildId: request.guildId,
        guildOwnerId: state?.ownerId ?? '',
        botUserId: deps.botUserId,
        botHighestRolePosition: state ? highestRolePosition(state.roles, state.botRoleIds) : 0,
        botChannelPermissions: 0n,
        requiredPermissions: 0n,
      },
    };
  }

  if (!state) {
    return {
      failure: {
        code: 'guild_state_unavailable',
        humanReason:
          "This server's roles and channels haven't loaded yet, so there's no safe way to check " +
          'whether this is allowed. Try again shortly.',
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

  const roleId = roleSubjectId(request);
  // A role missing from state goes on to Discord, whose 404 is how a caller learns it is gone.
  const role = roleId ? state.roles.get(roleId) : undefined;

  const context: PrecheckInput = {
    guildId: request.guildId,
    guildOwnerId: state.ownerId,
    botUserId: deps.botUserId,
    botHighestRolePosition: highestRolePosition(state.roles, state.botRoleIds),
    botChannelPermissions,
    requiredPermissions: required,
    ...(role ? { role: { id: role.id, position: role.position } } : {}),
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

  // Ban alone: Discord bans a user who never joined, and every other member kind needs a member.
  if (hints.targetAbsent === true && request.kind === 'ban') {
    return {
      context: {
        ...context,
        targetIsMember: false,
        target: { id: targetId, highestRolePosition: 0 },
      },
    };
  }

  // No target and no member fetch: runPrechecks refuses on this role before it reads the member.
  if (role && role.position >= context.botHighestRolePosition) return { context };

  const roleIds = hints.targetRoleIds ?? (await deps.fetchMemberRoles?.(request.guildId, targetId));

  if (roleIds === 'not_member') {
    return {
      failure: {
        code: 'target_not_member',
        humanReason: "That user isn't in this server, so there's no member to act on.",
      },
    };
  }

  if (!roleIds) {
    return {
      failure: {
        code: 'target_state_unavailable',
        humanReason:
          "That member's roles couldn't be looked up, so there's no way to confirm this is " +
          'allowed. Nothing was changed. Try again in a moment.',
      },
    };
  }

  const exemptAsAdministrator =
    refusedOnAdministrators(request.kind) && holdsAdministrator(state, targetId, roleIds);

  return {
    context: {
      ...context,
      target: {
        id: targetId,
        highestRolePosition: highestRolePosition(state.roles, roleIds),
        ...(exemptAsAdministrator ? { exemptAsAdministrator } : {}),
      },
    },
  };
}
