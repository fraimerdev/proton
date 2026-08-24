import type { ModuleContext, ScheduledHandler } from '@proton/core';
import { MODULE_ID, type TempVcConfig } from './config.ts';
import { bindService, type TempVcDeps } from './deps.ts';
import { STALE_RESERVATION_MS } from './voice.ts';

export const SWEEP_JOB_ID = 'tempvc.sweep';

/**
 * The natural key of the rolling patrol, kept distinct from the per-row jobs so arming one never
 * replaces the other.
 */
export const PATROL_KEY = 'patrol';

/** How often the patrol comes back round while a guild still has live channels. */
export const PATROL_INTERVAL_MS = 60_000;

/** A bound on one pass, so a guild with a hundred stale rows cannot monopolise the worker. */
export const SWEEP_BATCH = 25;

export interface SweepReport {
  deleted: number;
  spared: number;
  forgotten: number;
}

/**
 * Armed at the deadline itself rather than polled. `scheduleDelete` writes the deadline and asks
 * for exactly one job at that moment, keyed on the row, so a rejoin-then-leave replaces the job
 * instead of stacking a second one.
 */
export async function armSweep(
  ctx: ModuleContext<TempVcConfig>,
  rowId: string,
  at: Date,
): Promise<void> {
  await ctx.schedule?.(SWEEP_JOB_ID, at, rowId, { rowId });
}

export function createSweepHandler(deps: TempVcDeps): ScheduledHandler<TempVcConfig> {
  return async (data, ctx) => {
    const rowId = (data as { rowId?: unknown } | null)?.rowId;

    if (typeof rowId === 'string') {
      await sweep(ctx, deps, rowId);
      return;
    }

    await patrol(ctx, deps);
  };
}

/**
 * The safety net for everything voiceStateUpdate cannot see. A channel that emptied while the
 * worker was down fired no event, so no deadline was ever written and no per-row job exists —
 * `guild.available` catches that only on a fresh gateway IDENTIFY, which a worker restart or a
 * RESUME never triggers.
 *
 * It re-arms itself only while the guild still has live channels, so a server that uses none of
 * this costs nothing.
 */
export async function patrol(
  ctx: ModuleContext<TempVcConfig>,
  deps: TempVcDeps,
  now: Date = new Date(),
): Promise<SweepReport> {
  const bound = bindService(deps);
  if ('unbound' in bound) return { deleted: 0, spared: 0, forgotten: 0 };

  const { repository, store } = bound;

  for (const row of await repository.liveIn(ctx.guildId)) {
    if (row.channelId === null) {
      // A reservation this old never became a channel. Forgetting it frees the owner's slot.
      if (row.createdAt.getTime() < now.getTime() - STALE_RESERVATION_MS) {
        await repository.forget(row.id);
      }
      continue;
    }

    if (row.deleteAfter !== null) continue;

    const occupants = await store.occupants(ctx.guildId, row.channelId);
    if (occupants.length === 0) {
      // Given the same deadline a live emptying would have, so a rejoin still spares it.
      await repository.scheduleDelete(row.id, new Date(now.getTime() + PATROL_INTERVAL_MS));
    }
  }

  const report = await sweep(ctx, deps, undefined, now);

  await armPatrol(ctx, deps, now);

  return report;
}

/** Arms the next patrol, but only while there is something left to patrol. */
export async function armPatrol(
  ctx: ModuleContext<TempVcConfig>,
  deps: TempVcDeps,
  now: Date = new Date(),
): Promise<boolean> {
  const bound = bindService(deps);
  if ('unbound' in bound) return false;

  if ((await bound.repository.liveIn(ctx.guildId)).length === 0) return false;

  await ctx.schedule?.(SWEEP_JOB_ID, new Date(now.getTime() + PATROL_INTERVAL_MS), PATROL_KEY, {});

  return true;
}

/**
 * Deletes only what is still empty when the deadline arrives. Occupancy is re-read here rather than
 * trusted from when the deadline was written, because the whole point of the delay is that somebody
 * may have walked back in — Discord fires leave-then-join whenever a member switches channel.
 *
 * Passing no row sweeps everything overdue, which is what the reconcile path wants after a restart.
 */
export async function sweep(
  ctx: ModuleContext<TempVcConfig>,
  deps: TempVcDeps,
  rowId?: string,
  now: Date = new Date(),
): Promise<SweepReport> {
  const report: SweepReport = { deleted: 0, spared: 0, forgotten: 0 };

  const bound = bindService(deps);
  if ('unbound' in bound) return report;

  const { service, repository, store } = bound;

  const due =
    rowId === undefined
      ? await repository.due(now, SWEEP_BATCH)
      : await (async () => {
          const row = await repository.byId(rowId);

          return row && row.deleteAfter !== null && row.deleteAfter <= now && row.status === 'live'
            ? [row]
            : [];
        })();

  for (const row of due) {
    if (row.channelId === null) {
      await repository.forget(row.id);
      report.forgotten += 1;
      continue;
    }

    const occupants = await store.occupants(ctx.guildId, row.channelId);
    if (occupants.length > 0) {
      await repository.cancelDelete(row.id);
      report.spared += 1;
      continue;
    }

    if (await service.destroy(ctx, row, 'empty for longer than the configured delay')) {
      report.deleted += 1;
    }
  }

  if (report.deleted > 0 || report.forgotten > 0) {
    ctx.logger.info(
      `swept temporary voice channels: deleted ${report.deleted}, spared ${report.spared}, ` +
        `forgot ${report.forgotten}`,
      { guildId: ctx.guildId, moduleId: MODULE_ID },
    );
  }

  return report;
}
