import type { ModuleContext, ScheduledHandler } from '@proton/core';
import { z } from 'zod';
import { publishResult, refreshMessage } from './announce.ts';
import { type GiveawaysConfig, MODULE_ID } from './config.ts';
import { flushCounts } from './counter.ts';
import { bindDraw, clockOf, type GiveawaysDeps } from './deps.ts';
import { drawGiveaway } from './end.ts';
import { reconcile } from './reconcile.ts';
import { rerollGiveaway } from './reroll.ts';

export const START_JOB_ID = 'start';
export const END_JOB_ID = 'end';
export const FLUSH_JOB_ID = 'flush-counts';
export const RECONCILE_JOB_ID = 'reconcile';
export const CLAIM_JOB_ID = 'claim-expiry';

export const GIVEAWAY_JOB_IDS = [
  START_JOB_ID,
  END_JOB_ID,
  FLUSH_JOB_ID,
  RECONCILE_JOB_ID,
  CLAIM_JOB_ID,
] as const;

// The durable sweeper polls on REVERSAL_SWEEP_INTERVAL_MS (15s by default), so arming the flush
// any tighter than that buys nothing — the per-message lease is what actually holds the
// one-edit-per-5s budget.
export const FLUSH_INTERVAL_MS = 15_000;
export const RECONCILE_INTERVAL_MS = 5 * 60_000;
export const CLAIM_INTERVAL_MS = 5 * 60_000;

export const FLUSH_KEY = `${MODULE_ID}:flush`;
export const RECONCILE_KEY = `${MODULE_ID}:reconcile`;
export const CLAIM_KEY = `${MODULE_ID}:claim`;

export const endJobDataSchema = z.object({ giveawayId: z.string().min(1) });
export const startJobDataSchema = endJobDataSchema;

/**
 * `scheduled -> running`. The message is already posted (showing the start time), so this repaints
 * it into the active card and arms the draw. `activate` is a conditional update, so a redelivered
 * job or a manual start racing it produces exactly one activation.
 */
export function createStartHandler(deps: GiveawaysDeps): ScheduledHandler<GiveawaysConfig> {
  return async (data, ctx) => {
    const parsed = startJobDataSchema.safeParse(data);
    if (!parsed.success) return;

    const bound = bindDraw(deps);
    if ('unbound' in bound) return;

    const now = new Date(clockOf(deps)());
    const started = await bound.bound.store.activate(ctx.guildId, parsed.data.giveawayId, now);
    if (!started) return;

    await refreshMessage(
      ctx,
      bound.bound,
      started,
      `giveaways:${started.id}:start:${started.startsAt?.getTime() ?? now.getTime()}`,
    );

    await ctx.schedule?.(END_JOB_ID, started.endsAt, `${MODULE_ID}:${started.id}`, {
      giveawayId: started.id,
    });
  };
}

/**
 * Arms the three patrols. Without this the module declares four schedules and only ever writes
 * one: live counts never flush, a crashed draw stays in `drawing` forever, and no claim expires.
 *
 * Kept rather than replaced — `guild.available` fires for every guild on every gateway identify,
 * and replacing would push each patrol its whole interval further out every reconnect.
 */
export async function armPatrols(
  ctx: ModuleContext<GiveawaysConfig>,
  deps: GiveawaysDeps = {},
  now: number = clockOf(deps)(),
): Promise<boolean> {
  if (!ctx.schedule) return false;

  if (!ctx.config.enabled) {
    await Promise.all([
      ctx.cancel?.(FLUSH_JOB_ID, FLUSH_KEY).catch(() => undefined),
      ctx.cancel?.(RECONCILE_JOB_ID, RECONCILE_KEY).catch(() => undefined),
      ctx.cancel?.(CLAIM_JOB_ID, CLAIM_KEY).catch(() => undefined),
    ]);
    return false;
  }

  await Promise.all([
    ctx.schedule(FLUSH_JOB_ID, new Date(now + FLUSH_INTERVAL_MS), FLUSH_KEY, {}),
    ctx.schedule(RECONCILE_JOB_ID, new Date(now + RECONCILE_INTERVAL_MS), RECONCILE_KEY, {}),
    ctx.schedule(CLAIM_JOB_ID, new Date(now + CLAIM_INTERVAL_MS), CLAIM_KEY, {}),
  ]);

  return true;
}

export function createEndHandler(deps: GiveawaysDeps): ScheduledHandler<GiveawaysConfig> {
  return async (data, ctx) => {
    const parsed = endJobDataSchema.safeParse(data);

    if (!parsed.success) {
      ctx.logger.error(
        'a giveaway draw was scheduled without a giveaway id, so nothing could be drawn: ' +
          `${parsed.error.issues.map((issue) => issue.message).join('; ')}. The giveaway it ` +
          'belonged to has to be ended with /giveaway end.',
        { guildId: ctx.guildId, moduleId: MODULE_ID },
      );
      return;
    }

    const bound = bindDraw(deps);
    if ('unbound' in bound) return;

    const { giveawayId } = parsed.data;

    const drawn = await drawGiveaway(
      { ...bound.bound, ...(deps.members ? { members: deps.members } : {}) },
      { guildId: ctx.guildId, giveawayId, drawnBy: 'proton:schedule', reason: 'deadline' },
    );

    if (drawn.outcome === 'missing') {
      ctx.logger.warn(
        `the scheduled draw for giveaway '${giveawayId}' found no such giveaway, so nothing was ` +
          'drawn. It was probably deleted along with the server it belonged to.',
        { guildId: ctx.guildId, moduleId: MODULE_ID },
      );
      return;
    }

    if (drawn.outcome !== 'drawn') return;

    await publishResult(ctx, bound.bound, { giveaway: drawn.giveaway, summary: drawn.summary });
    await deps.dirty?.clear(ctx.guildId, giveawayId);
  };
}

export function createFlushHandler(deps: GiveawaysDeps): ScheduledHandler<GiveawaysConfig> {
  return async (_data, ctx) => {
    const bound = bindDraw(deps);
    if ('unbound' in bound || !deps.dirty) return;

    try {
      await flushCounts({
        dirty: deps.dirty,
        guildId: ctx.guildId,
        async edit(giveawayId) {
          const giveaway = await bound.bound.store.get(ctx.guildId, giveawayId);
          if (giveaway?.status !== 'running') return false;

          return refreshMessage(
            ctx,
            bound.bound,
            giveaway,
            // The window, not the count: two flushes a second apart must be two different edits,
            // and two flushes inside one window must not be.
            `giveaways:${giveaway.id}:count:${Math.floor(clockOf(deps)() / 5_000)}`,
          );
        },
      });
    } finally {
      // In a finally: a patrol that stops re-arming because one edit threw is a patrol that
      // silently never runs again.
      await ctx
        .schedule?.(FLUSH_JOB_ID, new Date(clockOf(deps)() + FLUSH_INTERVAL_MS), FLUSH_KEY, {})
        .catch(() => undefined);
    }
  };
}

export function createReconcileHandler(deps: GiveawaysDeps): ScheduledHandler<GiveawaysConfig> {
  return async (_data, ctx) => {
    const bound = bindDraw(deps);
    if ('unbound' in bound) return;

    try {
      const now = new Date(clockOf(deps)());

      const result = await reconcile({
        store: bound.bound.store,
        guildId: ctx.guildId,
        ...(deps.dirty ? { dirty: deps.dirty } : {}),
        ...(deps.now ? { now: deps.now } : {}),
      });

      for (const giveaway of result.dueToStart) {
        const started = await bound.bound.store.activate(giveaway.guildId, giveaway.id, now);
        if (!started) continue;

        await refreshMessage(ctx, bound.bound, started, `giveaways:${started.id}:start:recovered`);
        await ctx.schedule?.(END_JOB_ID, started.endsAt, `${MODULE_ID}:${started.id}`, {
          giveawayId: started.id,
        });
      }

      for (const giveaway of result.overdue) {
        const drawn = await drawGiveaway(
          { ...bound.bound, ...(deps.members ? { members: deps.members } : {}) },
          {
            guildId: giveaway.guildId,
            giveawayId: giveaway.id,
            drawnBy: 'proton:reconcile',
            reason: 'its deadline passed while Proton was not running',
          },
        );

        if (drawn.outcome === 'drawn') {
          await publishResult(ctx, bound.bound, {
            giveaway: drawn.giveaway,
            summary: drawn.summary,
          });
        }
      }

      if (result.released.length > 0) {
        ctx.logger.warn(
          `${result.released.length} giveaway(s) were stuck part-way through a draw and have ` +
            'been put back so they can be drawn again. That happens when a worker stops mid-draw.',
          { guildId: ctx.guildId, moduleId: MODULE_ID, giveawayIds: result.released },
        );
      }
    } finally {
      await ctx
        .schedule?.(
          RECONCILE_JOB_ID,
          new Date(clockOf(deps)() + RECONCILE_INTERVAL_MS),
          RECONCILE_KEY,
          {},
        )
        .catch(() => undefined);
    }
  };
}

export function createClaimHandler(deps: GiveawaysDeps): ScheduledHandler<GiveawaysConfig> {
  return async (_data, ctx) => {
    const bound = bindDraw(deps);
    if ('unbound' in bound) return;

    try {
      const now = new Date(clockOf(deps)());
      const expired = await bound.bound.store.expiredClaims(ctx.guildId, now, 50);

      // Bucketed by draw, not by giveaway: a giveaway whose second draw also went unclaimed
      // would otherwise have those winners forfeited against the first draw's id, match nothing,
      // and never be rerolled — the prize is simply lost.
      const byDraw = new Map<string, { giveawayId: string; userIds: string[] }>();
      for (const win of expired) {
        const bucket = byDraw.get(win.drawId) ?? { giveawayId: win.giveawayId, userIds: [] };
        bucket.userIds.push(win.userId);
        byDraw.set(win.drawId, bucket);
      }

      for (const [drawId, bucket] of byDraw) {
        const forfeited = await bound.bound.store.forfeit(drawId, bucket.userIds, now);
        if (forfeited === 0) continue;

        const rerolled = await rerollGiveaway(
          { ...bound.bound, ...(deps.members ? { members: deps.members } : {}) },
          {
            guildId: ctx.guildId,
            giveawayId: bucket.giveawayId,
            drawnBy: 'proton:claim-expiry',
            count: forfeited,
            reason: 'the winner did not claim in time',
          },
        );

        if (rerolled.outcome === 'rerolled') {
          await publishResult(ctx, bound.bound, {
            giveaway: rerolled.giveaway,
            summary: rerolled.summary,
            reroll: true,
          });
        }
      }
    } finally {
      await ctx
        .schedule?.(CLAIM_JOB_ID, new Date(clockOf(deps)() + CLAIM_INTERVAL_MS), CLAIM_KEY, {})
        .catch(() => undefined);
    }
  };
}
