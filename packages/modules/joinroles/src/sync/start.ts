import type { ModuleContext, ScheduleOutcome } from '@proton/core';
import type { JoinrolesConfig } from '../config.ts';
import { JOINROLES_MODULE_ID } from '../listeners.ts';
import { JOINROLES_SYNC_JOB, type SyncBatchData, syncBatchKey } from './run.ts';
import { claimRun, type JoinRolesRunStore } from './store.ts';
import { queuedRun, type SyncRun, type SyncTrigger } from './view.ts';

export type StartOutcome = 'started' | 'running' | 'busy' | 'unscheduled';

export async function bookBatch(
  ctx: ModuleContext<JoinrolesConfig>,
  runId: string,
  now: number,
): Promise<ScheduleOutcome | null> {
  if (!ctx.schedule) return null;

  const data: SyncBatchData = { runId };

  return ctx.schedule(JOINROLES_SYNC_JOB, new Date(now), syncBatchKey(runId), data, {
    replace: false,
  });
}

export async function startRun(
  ctx: ModuleContext<JoinrolesConfig>,
  runs: JoinRolesRunStore,
  input: {
    runId: string;
    kind: SyncRun['kind'];
    trigger: SyncTrigger;
    actorId: string | null;
    now: number;
  },
): Promise<StartOutcome> {
  if (!ctx.schedule) return 'unscheduled';

  const claim = await claimRun(runs, queuedRun({ ...input, guildId: ctx.guildId }), input.now);

  if (!claim.claimed) {
    if (claim.current?.runId !== input.runId) return 'busy';
    if (claim.current.state !== 'queued') return 'running';
  } else if (claim.replaced) {
    ctx.logger.warn(
      `a Join Roles ${claim.replaced.kind} had reported no progress since ` +
        `${new Date(claim.replaced.heartbeatAt).toISOString()}, so a ${input.trigger} sync ` +
        'replaced it.',
      {
        guildId: ctx.guildId,
        moduleId: JOINROLES_MODULE_ID,
        runId: input.runId,
        replacedRunId: claim.replaced.runId,
      },
    );
  }

  await bookBatch(ctx, input.runId, input.now);
  return 'started';
}
