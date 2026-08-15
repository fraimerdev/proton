import type {
  EventListener,
  EventType,
  GuildState,
  ModuleContext,
  ProtonEvent,
} from '@proton/core';
import type { AutoroleConfig } from './config.ts';
import { planRestore } from './restore.ts';
import type { StickyRoleStore } from './store.ts';

export const AUTOROLE_MODULE_ID = 'autorole';

export const AUTOROLE_ACTOR = 'proton:autorole';

export const AUTOROLE_EVENT_TYPES: EventType[] = ['member.joined', 'member.updated'];

export interface AutoroleDeps {
  store?: StickyRoleStore;
  guildState?: { get(guildId: string): Promise<GuildState | null> };
}

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function nested(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

function roleIdsOf(payload: unknown): string[] {
  const roles = nested(payload, 'roles');
  return Array.isArray(roles) ? roles.filter((r): r is string => typeof r === 'string') : [];
}

function userIdOf(payload: unknown): string | null {
  return str(nested(nested(payload, 'user'), 'id'));
}

export function createStickyListener(deps: AutoroleDeps): EventListener<AutoroleConfig> {
  return {
    types: AUTOROLE_EVENT_TYPES,
    async handler(event: ProtonEvent, ctx: ModuleContext<AutoroleConfig>): Promise<void> {
      if (!ctx.config.stickyEnabled) return;

      if (!deps.store) {
        ctx.logger.error(
          'sticky roles are enabled in this server but no role store is wired into the worker, ' +
            'so nothing is being remembered and nothing will be restored.',
          { guildId: ctx.guildId, moduleId: AUTOROLE_MODULE_ID },
        );
        return;
      }

      const userId = userIdOf(event.payload);
      if (!userId) return;

      if (event.type === 'member.updated') {
        await snapshot(deps.store, event, ctx, userId);
        return;
      }

      await restore(deps, event, ctx, userId);
    },
  };
}

async function snapshot(
  store: StickyRoleStore,
  event: ProtonEvent,
  ctx: ModuleContext<AutoroleConfig>,
  userId: string,
): Promise<void> {
  await store.snapshot(ctx.guildId, userId, roleIdsOf(event.payload));
}

async function restore(
  deps: AutoroleDeps,
  event: ProtonEvent,
  ctx: ModuleContext<AutoroleConfig>,
  userId: string,
): Promise<void> {
  const recorded = await deps.store?.read(ctx.guildId, userId);
  if (!recorded || recorded.length === 0) return;

  const state = (await deps.guildState?.get(ctx.guildId)) ?? null;
  const plan = planRestore({
    state,
    recordedRoleIds: recorded,
    allowlist: ctx.config.stickyRoleIds,
  });

  for (const skip of plan.skipped) {
    ctx.logger.warn(`did not restore role ${skip.roleId} to ${userId}: ${skip.reason}`, {
      guildId: ctx.guildId,
      moduleId: AUTOROLE_MODULE_ID,
      userId,
      roleId: skip.roleId,
    });
  }

  for (const roleId of plan.restore) {
    const result = await ctx.executor.execute({
      guildId: ctx.guildId,
      moduleId: AUTOROLE_MODULE_ID,
      kind: 'add_role',
      actorId: AUTOROLE_ACTOR,
      targetId: userId,
      reason: 'Restoring roles held before leaving',

      idempotencyKey: `${event.id}:sticky:${roleId}`,
      dryRun: false,
      payload: { userId, roleId },
    });

    if (result.status === 'failed_precheck' || result.status === 'failed_api') {
      ctx.logger.error(
        `could not restore role ${roleId} to ${userId}: ${
          result.failure?.humanReason ?? 'unknown reason'
        }`,
        { guildId: ctx.guildId, moduleId: AUTOROLE_MODULE_ID, userId, roleId },
      );
    }
  }
}
