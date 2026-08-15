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

/** Nobody pressed a button — see `RULE_ENGINE_ACTOR` for the same reasoning. */
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

/**
 * Sticky roles: remember what a member holds, and give it back if they return.
 *
 * The two halves are driven by different events for a reason that is easy to get
 * backwards. `member.updated` is the only dispatch carrying a member's roles
 * while they are still in the guild, so it is the only place a snapshot can be
 * taken; `GUILD_MEMBER_REMOVE` carries the user id and nothing else, and by then
 * `GET member` answers 404. `member.joined` is where the snapshot is spent.
 *
 * Deliberately **not** expressed as a rule. Restoring roles is not a trigger and
 * an action — it reads per-member state, filters it against a hierarchy that can
 * have moved since, and reports what it refused. §4-P2's action vocabulary has
 * no way to say any of that, and widening it to fit is what `antiraid` records
 * declining to do for the same reason.
 */
export function createStickyListener(deps: AutoroleDeps): EventListener<AutoroleConfig> {
  return {
    types: AUTOROLE_EVENT_TYPES,
    async handler(event: ProtonEvent, ctx: ModuleContext<AutoroleConfig>): Promise<void> {
      if (!ctx.config.stickyEnabled) return;

      if (!deps.store) {
        // Named, not silent: a module that cannot do the thing it is enabled for
        // must say which part is unwired (§7).
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

/**
 * Record the member's current roles.
 *
 * Writes whatever the member actually holds, including the empty set — a guild
 * that strips someone's roles has made a decision, and a snapshot that refused
 * to record removals would hand those roles straight back on the next rejoin,
 * turning the feature into a way to undo a demotion.
 *
 * One consequence is worth stating rather than discovering: if a restore fails
 * partway, the `member.updated` events it generated leave the snapshot holding
 * the partial set. That is correct — it is the member's state now — but it means
 * a failed restore is not retried from the original snapshot. The skipped roles
 * are logged with reasons for exactly that case.
 */
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
      // Derived from the event id and the role, so a redelivered join restores
      // each role once (I4) rather than re-issuing the whole set per delivery.
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
