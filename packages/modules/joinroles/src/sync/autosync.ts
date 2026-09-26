import type { ModuleContext, ScheduledHandler } from '@proton/core';
import { z } from 'zod';
import type { JoinrolesConfig, SyncInterval } from '../config.ts';
import { JOINROLES_MODULE_ID, type JoinRolesDeps } from '../listeners.ts';
import { startRun } from './start.ts';
import type { JoinRolesRunStore } from './store.ts';

export const JOINROLES_AUTOSYNC_JOB = 'joinroles.autosync';

export const JOINROLES_AUTOSYNC_KEY = 'joinroles:autosync';

export const AUTOSYNC_BUSY_RETRY_MS = 60 * 60_000;

export const AUTOSYNC_OVERDUE_MS = 10 * 60_000;

export const SYNC_INTERVAL_MS: Record<SyncInterval, number> = {
  daily: 24 * 60 * 60_000,
  weekly: 7 * 24 * 60 * 60_000,
};

export const autosyncDataSchema = z.object({ slot: z.number().int().nonnegative() });

export function autosyncRunId(slot: number): string {
  return `s${slot}`;
}

function when(ms: number): string {
  return new Date(ms).toISOString();
}

export async function bookAutosync(
  ctx: ModuleContext<JoinrolesConfig>,
  runs: JoinRolesRunStore | undefined,
  at: number,
  options: { replace: boolean; now: number },
): Promise<void> {
  const meta = { guildId: ctx.guildId, moduleId: JOINROLES_MODULE_ID };

  if (!ctx.schedule) {
    ctx.logger.error(
      'this server has Join Roles set to sync on a schedule, but this deployment has no durable ' +
        'scheduler wired into the module runtime, so no scheduled sync will run.',
      meta,
    );
    return;
  }

  const data = { slot: at };
  const book = (replace: boolean) =>
    ctx.schedule?.(JOINROLES_AUTOSYNC_JOB, new Date(at), JOINROLES_AUTOSYNC_KEY, data, { replace });

  if ((await book(options.replace))?.scheduled) {
    await runs?.setAutosyncAt(ctx.guildId, at);
    return;
  }

  if (options.replace || !runs) return;

  // A live row runs within a sweep of its time, so one still booked 10 minutes on was given up on.
  const due = await runs.autosyncAt(ctx.guildId);
  if (due !== null && options.now < due + AUTOSYNC_OVERDUE_MS) return;

  if (!(await book(true))?.scheduled) return;

  await runs.setAutosyncAt(ctx.guildId, at);

  ctx.logger.warn(
    due === null
      ? 'Proton had no record of when the scheduled Join Roles sync was due, so it was booked ' +
          `again for ${when(at)}.`
      : `the scheduled Join Roles sync due at ${when(due)} never ran, so it was booked again ` +
          `for ${when(at)}.`,
    meta,
  );
}

export function createAutosyncHandler(deps: JoinRolesDeps): ScheduledHandler<JoinrolesConfig> {
  return async (data, ctx) => {
    const { config } = ctx;
    if (!config.enabled || !config.syncScheduleEnabled) return;

    const now = deps.now?.() ?? Date.now();
    const next = now + SYNC_INTERVAL_MS[config.syncInterval];
    const runs = deps.runs;

    if (!runs) {
      ctx.logger.error(
        'a scheduled Join Roles sync came due but this deployment has no run store wired into ' +
          'the module, so it did not run.',
        { guildId: ctx.guildId, moduleId: JOINROLES_MODULE_ID },
      );
      return;
    }

    if (config.memberRoleIds.length === 0 && config.botRoleIds.length === 0) {
      await bookAutosync(ctx, runs, next, { replace: true, now });
      return;
    }

    const parsed = autosyncDataSchema.safeParse(data);
    const runId = autosyncRunId(parsed.success ? parsed.data.slot : now);

    if ((await runs.last(ctx.guildId))?.runId === runId) {
      await bookAutosync(ctx, runs, next, { replace: true, now });
      return;
    }

    const outcome = await startRun(ctx, runs, {
      runId,
      kind: 'sync',
      trigger: 'schedule',
      actorId: null,
      now,
    });

    await bookAutosync(ctx, runs, outcome === 'busy' ? now + AUTOSYNC_BUSY_RETRY_MS : next, {
      replace: true,
      now,
    });
  };
}
