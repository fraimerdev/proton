import type {
  EventListener,
  EventType,
  GuildState,
  ModuleContext,
  ProtonEvent,
} from '@proton/core';
import type { JoinrolesConfig } from './config.ts';
import { planGrant } from './grant.ts';
import type { PendingGrantStore } from './pending.ts';
import { planRestore } from './restore.ts';
import type { StickyRoleStore } from './store.ts';

export const JOINROLES_MODULE_ID = 'joinroles';

export const JOINROLES_ACTOR = 'proton:joinroles';

export const JOINROLES_EVENT_TYPES: EventType[] = ['member.joined', 'member.updated'];

export interface JoinRolesDeps {
  store?: StickyRoleStore;
  pending?: PendingGrantStore;
  guildState?: { get(guildId: string): Promise<GuildState | null> };
  botUserId?: string;
}

export interface MemberFacts {
  userId: string;
  isBot: boolean;
  pending: boolean;
  roleIds: string[];
  joinedAt: string;
}

export function joinrolesKey(
  guildId: string,
  userId: string,
  joinedAt: string,
  purpose: 'grant' | 'sticky',
  roleId: string,
): string {
  return `joinroles:${guildId}:${userId}:${joinedAt}:${purpose}:${roleId}`;
}

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function nested(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

export function readMember(payload: unknown): MemberFacts | null {
  const user = nested(payload, 'user');
  const userId = str(nested(user, 'id'));
  if (!userId) return null;

  const roles = nested(payload, 'roles');

  return {
    userId,
    isBot: nested(user, 'bot') === true,
    pending: nested(payload, 'pending') === true,
    roleIds: Array.isArray(roles) ? roles.filter((r): r is string => typeof r === 'string') : [],
    joinedAt: str(nested(payload, 'joined_at')) ?? '',
  };
}

export function createJoinRolesListener(deps: JoinRolesDeps): EventListener<JoinrolesConfig> {
  return {
    types: JOINROLES_EVENT_TYPES,
    async handler(event: ProtonEvent, ctx: ModuleContext<JoinrolesConfig>): Promise<void> {
      const member = readMember(event.payload);
      if (!member) return;
      if (deps.botUserId && member.userId === deps.botUserId) return;

      if (event.type === 'member.updated') {
        await onMemberUpdated(deps, ctx, member);
        return;
      }

      await onMemberJoined(deps, ctx, member);
    },
  };
}

function wanted(config: JoinrolesConfig, member: MemberFacts): string[] {
  return member.isBot ? config.botRoleIds : config.memberRoleIds;
}

async function onMemberJoined(
  deps: JoinRolesDeps,
  ctx: ModuleContext<JoinrolesConfig>,
  member: MemberFacts,
): Promise<void> {
  const granted = await maybeGrant(deps, ctx, member);

  if (!ctx.config.stickyEnabled || member.isBot) return;
  await restore(deps, ctx, member, granted);
}

async function onMemberUpdated(
  deps: JoinRolesDeps,
  ctx: ModuleContext<JoinrolesConfig>,
  member: MemberFacts,
): Promise<void> {
  if (ctx.config.stickyEnabled && !member.isBot) {
    await snapshot(deps, ctx, member);
  }

  if (!ctx.config.enabled || !ctx.config.grantWhenScreeningPasses || member.pending) return;
  if (!deps.pending) return;

  // Only a member we deliberately deferred is granted here. Granting on any pending -> false
  // would re-add roles a moderator has since removed by hand.
  if (!(await deps.pending.take(ctx.guildId, member.userId))) return;

  await grant(deps, ctx, member);
}

async function maybeGrant(
  deps: JoinRolesDeps,
  ctx: ModuleContext<JoinrolesConfig>,
  member: MemberFacts,
): Promise<string[]> {
  const roleIds = wanted(ctx.config, member);

  if (!ctx.config.enabled) {
    if (roleIds.length > 0) {
      ctx.logger.info(
        `${roleIds.length} role(s) are configured to be granted on join, but "Grant roles on ` +
          'join" is switched off for this server, so nothing was granted.',
        { guildId: ctx.guildId, moduleId: JOINROLES_MODULE_ID, userId: member.userId },
      );
    }
    return [];
  }

  if (roleIds.length === 0) return [];

  if (ctx.config.grantWhenScreeningPasses && member.pending) {
    if (deps.pending) {
      await deps.pending.mark(ctx.guildId, member.userId);
      ctx.logger.info(
        'member has not accepted Membership Screening yet; their join roles are held until they do.',
        { guildId: ctx.guildId, moduleId: JOINROLES_MODULE_ID, userId: member.userId },
      );
      return [];
    }

    // Granting early beats granting never, so an unwired store falls through to an immediate grant.
    ctx.logger.error(
      'this server waits for Membership Screening before granting join roles, but no pending-grant ' +
        'store is wired into the worker, so the roles were granted immediately instead.',
      { guildId: ctx.guildId, moduleId: JOINROLES_MODULE_ID, userId: member.userId },
    );
  }

  return grant(deps, ctx, member);
}

async function grant(
  deps: JoinRolesDeps,
  ctx: ModuleContext<JoinrolesConfig>,
  member: MemberFacts,
): Promise<string[]> {
  const state = (await deps.guildState?.get(ctx.guildId)) ?? null;
  const plan = planGrant({
    state,
    wantedRoleIds: wanted(ctx.config, member),
    heldRoleIds: member.roleIds,
  });

  for (const skip of plan.skipped) {
    ctx.logger.warn(`did not grant role ${skip.roleId} to ${member.userId}: ${skip.reason}`, {
      guildId: ctx.guildId,
      moduleId: JOINROLES_MODULE_ID,
      userId: member.userId,
      roleId: skip.roleId,
    });
  }

  const granted: string[] = [];

  for (const roleId of plan.grant) {
    const result = await ctx.executor.execute({
      guildId: ctx.guildId,
      moduleId: JOINROLES_MODULE_ID,
      kind: 'add_role',
      actorId: JOINROLES_ACTOR,
      targetId: member.userId,
      reason: member.isBot ? 'Join Roles: bot added' : 'Join Roles: member joined',

      idempotencyKey: joinrolesKey(ctx.guildId, member.userId, member.joinedAt, 'grant', roleId),
      dryRun: false,
      payload: { userId: member.userId, roleId },
    });

    if (result.status === 'failed_precheck' || result.status === 'failed_api') {
      ctx.logger.error(
        `could not grant role ${roleId} to ${member.userId}: ${
          result.failure?.humanReason ?? 'unknown reason'
        }`,
        { guildId: ctx.guildId, moduleId: JOINROLES_MODULE_ID, userId: member.userId, roleId },
      );
      continue;
    }

    granted.push(roleId);
  }

  return granted;
}

async function snapshot(
  deps: JoinRolesDeps,
  ctx: ModuleContext<JoinrolesConfig>,
  member: MemberFacts,
): Promise<void> {
  if (!deps.store) {
    ctx.logger.error(UNBOUND_STORE, { guildId: ctx.guildId, moduleId: JOINROLES_MODULE_ID });
    return;
  }

  await deps.store.snapshot(ctx.guildId, member.userId, member.roleIds);
}

const UNBOUND_STORE =
  'sticky roles are enabled in this server but no role store is wired into the worker, ' +
  'so nothing is being remembered and nothing will be restored.';

async function restore(
  deps: JoinRolesDeps,
  ctx: ModuleContext<JoinrolesConfig>,
  member: MemberFacts,
  alreadyGranted: readonly string[],
): Promise<void> {
  if (!deps.store) {
    ctx.logger.error(UNBOUND_STORE, { guildId: ctx.guildId, moduleId: JOINROLES_MODULE_ID });
    return;
  }

  const recorded = await deps.store.read(ctx.guildId, member.userId);
  if (!recorded || recorded.length === 0) return;

  const state = (await deps.guildState?.get(ctx.guildId)) ?? null;
  const granted = new Set(alreadyGranted);
  const plan = planRestore({
    state,
    recordedRoleIds: recorded.filter((roleId) => !granted.has(roleId)),
    allowlist: ctx.config.stickyRoleIds,
  });

  for (const skip of plan.skipped) {
    ctx.logger.warn(`did not restore role ${skip.roleId} to ${member.userId}: ${skip.reason}`, {
      guildId: ctx.guildId,
      moduleId: JOINROLES_MODULE_ID,
      userId: member.userId,
      roleId: skip.roleId,
    });
  }

  for (const roleId of plan.restore) {
    const result = await ctx.executor.execute({
      guildId: ctx.guildId,
      moduleId: JOINROLES_MODULE_ID,
      kind: 'add_role',
      actorId: JOINROLES_ACTOR,
      targetId: member.userId,
      reason: 'Restoring roles held before leaving',

      idempotencyKey: joinrolesKey(ctx.guildId, member.userId, member.joinedAt, 'sticky', roleId),
      dryRun: false,
      payload: { userId: member.userId, roleId },
    });

    if (result.status === 'failed_precheck' || result.status === 'failed_api') {
      ctx.logger.error(
        `could not restore role ${roleId} to ${member.userId}: ${
          result.failure?.humanReason ?? 'unknown reason'
        }`,
        { guildId: ctx.guildId, moduleId: JOINROLES_MODULE_ID, userId: member.userId, roleId },
      );
    }
  }
}
