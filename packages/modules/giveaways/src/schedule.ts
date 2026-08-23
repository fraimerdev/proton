import type { ScheduledHandler } from '@proton/core';
import { z } from 'zod';
import { publishResult, refreshMessage } from './announce.ts';
import { type GiveawaysConfig, MODULE_ID } from './config.ts';
import { flushCounts } from './counter.ts';
import { bindDraw, type GiveawaysDeps } from './deps.ts';
import { drawGiveaway } from './end.ts';
import { reconcile } from './reconcile.ts';
import { rerollGiveaway } from './reroll.ts';

export const END_JOB_ID = 'end';
export const FLUSH_JOB_ID = 'flush-counts';
export const RECONCILE_JOB_ID = 'reconcile';
export const CLAIM_JOB_ID = 'claim-expiry';

export const GIVEAWAY_JOB_IDS = [END_JOB_ID, FLUSH_JOB_ID, RECONCILE_JOB_ID, CLAIM_JOB_ID] as const;

export const endJobDataSchema = z.object({ giveawayId: z.string().min(1) });

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
    await deps.dirty?.clear(giveawayId);
  };
}

export function createFlushHandler(deps: GiveawaysDeps): ScheduledHandler<GiveawaysConfig> {
  return async (_data, ctx) => {
    const bound = bindDraw(deps);
    if ('unbound' in bound || !deps.dirty) return;

    await flushCounts({
      dirty: deps.dirty,
      async edit(giveawayId) {
        const giveaway = await bound.bound.store.get(ctx.guildId, giveawayId);
        if (giveaway?.status !== 'running') return false;

        return refreshMessage(
          ctx,
          bound.bound,
          giveaway,
          // The window, not the count: two flushes a second apart must be two different edits,
          // and two flushes inside one window must not be.
          `giveaways:${giveaway.id}:count:${Math.floor((deps.now?.() ?? Date.now()) / 5_000)}`,
        );
      },
    });
  };
}

export function createReconcileHandler(deps: GiveawaysDeps): ScheduledHandler<GiveawaysConfig> {
  return async (_data, ctx) => {
    const bound = bindDraw(deps);
    if ('unbound' in bound) return;

    const result = await reconcile({
      store: bound.bound.store,
      ...(deps.dirty ? { dirty: deps.dirty } : {}),
      ...(deps.now ? { now: deps.now } : {}),
    });

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
        `${result.released.length} giveaway(s) were stuck part-way through a draw and have been ` +
          'put back so they can be drawn again. That happens when a worker stops mid-draw.',
        { guildId: ctx.guildId, moduleId: MODULE_ID, giveawayIds: result.released },
      );
    }
  };
}

export function createClaimHandler(deps: GiveawaysDeps): ScheduledHandler<GiveawaysConfig> {
  return async (_data, ctx) => {
    const bound = bindDraw(deps);
    if ('unbound' in bound) return;

    const now = new Date(deps.now?.() ?? Date.now());
    const expired = await bound.bound.store.expiredClaims(now, 50);

    const byGiveaway = new Map<string, { drawId: string; userIds: string[] }>();
    for (const win of expired) {
      const bucket = byGiveaway.get(win.giveawayId) ?? { drawId: win.drawId, userIds: [] };
      bucket.userIds.push(win.userId);
      byGiveaway.set(win.giveawayId, bucket);
    }

    for (const [giveawayId, bucket] of byGiveaway) {
      const forfeited = await bound.bound.store.forfeit(bucket.drawId, bucket.userIds, now);
      if (forfeited === 0) continue;

      const rerolled = await rerollGiveaway(
        { ...bound.bound, ...(deps.members ? { members: deps.members } : {}) },
        {
          guildId: ctx.guildId,
          giveawayId,
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
  };
}
