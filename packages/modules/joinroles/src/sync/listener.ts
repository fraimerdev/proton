import {
  type EventListener,
  type EventType,
  joinrolesSyncRequestedSchema,
  type ModuleContext,
  type ProtonEvent,
} from '@proton/core';
import type { JoinrolesConfig } from '../config.ts';
import { JOINROLES_MODULE_ID, type JoinRolesDeps } from '../listeners.ts';
import {
  bookAutosync,
  JOINROLES_AUTOSYNC_JOB,
  JOINROLES_AUTOSYNC_KEY,
  SYNC_INTERVAL_MS,
} from './autosync.ts';
import { finishRun, JOINROLES_SYNC_JOB, SYNC_FAILURES, syncBatchKey } from './run.ts';
import { bookBatch } from './start.ts';

export const JOINROLES_SYNC_EVENT_TYPES: EventType[] = [
  'joinroles.sync_requested',
  'proton.config_changed',
  'guild.available',
];

const SCHEDULE_KEYS = ['syncScheduleEnabled', 'syncInterval'];

function field(payload: unknown, key: string): unknown {
  return typeof payload === 'object' && payload !== null
    ? (payload as Record<string, unknown>)[key]
    : undefined;
}

async function onRequested(
  deps: JoinRolesDeps,
  event: ProtonEvent,
  ctx: ModuleContext<JoinrolesConfig>,
  now: number,
): Promise<void> {
  const parsed = joinrolesSyncRequestedSchema.safeParse(event.payload);
  if (!parsed.success || parsed.data.guildId !== ctx.guildId) {
    ctx.logger.warn('ignored a Join Roles sync request that does not describe this server', {
      guildId: ctx.guildId,
      moduleId: JOINROLES_MODULE_ID,
      eventId: event.id,
    });
    return;
  }

  if (!deps.runs) {
    ctx.logger.error(
      'a Join Roles sync was asked for but this deployment has no run store wired into the ' +
        'module, so it cannot start.',
      { guildId: ctx.guildId, moduleId: JOINROLES_MODULE_ID },
    );
    return;
  }

  const run = await deps.runs.get(ctx.guildId);
  if (!run || run.runId !== parsed.data.runId || run.state !== 'queued') return;

  if (!ctx.schedule) {
    await finishRun(ctx, deps.runs, run, 'failed', SYNC_FAILURES.noScheduler, now);
    return;
  }

  await bookBatch(ctx, run.runId, now);
}

async function onConfigChanged(
  deps: JoinRolesDeps,
  event: ProtonEvent,
  ctx: ModuleContext<JoinrolesConfig>,
  now: number,
): Promise<void> {
  if (field(event.payload, 'moduleId') !== JOINROLES_MODULE_ID) return;

  // Not the event's enabledAfter: a switch-off redelivered after a switch-on would stop a new run.
  if (!ctx.config.enabled) {
    const runs = deps.runs;
    const run = await runs?.get(ctx.guildId);

    if (run && runs) {
      if (run.kind === 'sync') {
        await finishRun(ctx, runs, run, 'stopped', SYNC_FAILURES.switchedOff, now);
      } else {
        await runs.clear(ctx.guildId, run.runId);
      }

      await ctx.cancel?.(JOINROLES_SYNC_JOB, syncBatchKey(run.runId));
    }

    await ctx.cancel?.(JOINROLES_AUTOSYNC_JOB, JOINROLES_AUTOSYNC_KEY);
    return;
  }

  if (!ctx.config.syncScheduleEnabled) {
    await ctx.cancel?.(JOINROLES_AUTOSYNC_JOB, JOINROLES_AUTOSYNC_KEY);
    return;
  }

  const changed = field(event.payload, 'changedKeys');
  const replace = Array.isArray(changed) && changed.some((key) => SCHEDULE_KEYS.includes(key));

  await bookAutosync(ctx, deps.runs, now + SYNC_INTERVAL_MS[ctx.config.syncInterval], {
    replace,
    now,
  });
}

export function createJoinRolesSyncListener(deps: JoinRolesDeps): EventListener<JoinrolesConfig> {
  return {
    types: JOINROLES_SYNC_EVENT_TYPES,

    async handler(event, ctx) {
      const now = deps.now?.() ?? Date.now();

      if (event.type === 'joinroles.sync_requested') {
        await onRequested(deps, event, ctx, now);
        return;
      }

      if (event.type === 'proton.config_changed') {
        await onConfigChanged(deps, event, ctx, now);
        return;
      }

      if (ctx.config.enabled && ctx.config.syncScheduleEnabled) {
        await bookAutosync(ctx, deps.runs, now + SYNC_INTERVAL_MS[ctx.config.syncInterval], {
          replace: false,
          now,
        });
      }
    },
  };
}
