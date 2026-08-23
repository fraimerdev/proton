import {
  type Logger,
  MODULE_JOB_KIND,
  type ModuleRegistry,
  moduleScheduleKey,
  type ScheduledActionInput,
  type ScheduledActionStore,
  type ScheduledModuleJob,
  type ScheduleOutcome,
  UndeclaredScheduleError,
} from '@proton/core';

export interface ModuleSchedulerDeps {
  store: ScheduledActionStore;
  registry: ModuleRegistry;
  logger: Logger;
}

function scheduleLine(
  moduleId: string,
  jobId: string,
  runAt: Date,
  outcome: ScheduleOutcome,
): string {
  if (!outcome.scheduled) {
    return (
      `${moduleId} had already scheduled '${jobId}' under this key, so nothing moved — ` +
      'schedule it again with { replace: true } to move it'
    );
  }

  return outcome.replaced
    ? `${moduleId} moved '${jobId}' to ${runAt.toISOString()}`
    : `${moduleId} scheduled '${jobId}' for ${runAt.toISOString()}`;
}

export function createModuleScheduler(deps: ModuleSchedulerDeps) {
  return function schedulerFor(moduleId: string, guildId: string, inFlight?: ScheduledModuleJob) {
    const keyFor = (jobId: string, naturalKey: string): string => {
      if (!deps.registry.maySchedule(moduleId, jobId)) {
        throw new UndeclaredScheduleError(
          moduleId,
          jobId,
          'it tried to schedule it but does not declare it in `schedules`.',
        );
      }
      return moduleScheduleKey(moduleId, jobId, guildId, naturalKey);
    };

    return {
      schedule: async (
        jobId: string,
        runAt: Date,
        naturalKey: string,
        data?: unknown,
        options?: { replace?: boolean },
      ) => {
        const idempotencyKey = keyFor(jobId, naturalKey);

        const next: Omit<ScheduledActionInput, 'onConflict'> = {
          guildId,
          runAt,
          kind: MODULE_JOB_KIND,
          idempotencyKey,
          payload: { kind: 'module', moduleId, jobId, guildId, data },
        };

        const meta = { guildId, moduleId, jobId, idempotencyKey };

        // the running row outlives its handler, so a job rescheduling itself has to retire that
        // row and insert the next one in one transaction rather than collide with itself
        if (inFlight && idempotencyKey === inFlight.idempotencyKey) {
          if ((await inFlight.reschedule(next)) === 'lost') {
            deps.logger.error(
              `${moduleId} could not book the next '${jobId}': the row it is running was taken ` +
                'from it — cancelled, replaced, or claimed by another sweep after its lock ' +
                'lapsed — so nothing was written here. The sweep holding that row now will run ' +
                'this job again and reschedule it then.',
              meta,
            );
            return { scheduled: false, replaced: false };
          }

          const rescheduled: ScheduleOutcome = { scheduled: true, replaced: true };
          deps.logger.info(scheduleLine(moduleId, jobId, runAt, rescheduled), meta);
          return rescheduled;
        }

        const outcome = await deps.store.schedule({
          ...next,
          onConflict: options?.replace ? 'replace' : 'keep',
        });

        deps.logger.info(scheduleLine(moduleId, jobId, runAt, outcome), meta);

        return outcome;
      },

      cancel: async (jobId: string, naturalKey: string): Promise<void> => {
        const idempotencyKey = keyFor(jobId, naturalKey);
        const { cancelled } = await deps.store.cancel(idempotencyKey);

        deps.logger.info(
          cancelled
            ? `${moduleId} cancelled '${jobId}'`
            : `${moduleId} cancelled '${jobId}', which was not pending`,
          { guildId, moduleId, jobId, idempotencyKey },
        );
      },
    };
  };
}

export type ModuleSchedulerFactory = ReturnType<typeof createModuleScheduler>;
