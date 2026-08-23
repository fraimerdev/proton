import type { Logger, ScheduledActionSweeper } from '@proton/core';
import { type ConnectionOptions, Queue, Worker } from 'bullmq';

export const SCHEDULED_QUEUE = 'proton-scheduled';
export const SCHEDULED_SWEEP_JOB = 'sweep';

export interface ScheduledActionJobsDeps {
  connection: ConnectionOptions;
  sweeper: ScheduledActionSweeper;
  intervalMs: number;
  logger: Logger;
}

export interface ScheduledActionJobs {
  queue: Queue;
  worker: Worker;
  close(): Promise<void>;
}

export function startScheduledActionJobs(deps: ScheduledActionJobsDeps): ScheduledActionJobs {
  const queue = new Queue(SCHEDULED_QUEUE, { connection: deps.connection });

  const worker = new Worker(
    SCHEDULED_QUEUE,
    async () => {
      const result = await deps.sweeper.sweep();

      if (result.claimed > 0) deps.logger.info('scheduled action sweep', { ...result });
      return result;
    },
    { connection: deps.connection },
  );

  worker.on('failed', (_job, error) => {
    deps.logger.error(`scheduled action sweep failed: ${error.message}`, { stack: error.stack });
  });

  void queue
    .upsertJobScheduler(SCHEDULED_SWEEP_JOB, { every: deps.intervalMs })
    .catch((error: unknown) => {
      deps.logger.error(
        'could not register the scheduled action sweep — temporary actions will NOT lift ' +
          'automatically and no module schedule (reminder, giveaway end, ticket auto-close) ' +
          `will fire: ${error instanceof Error ? error.message : String(error)}`,
      );
    });

  return {
    queue,
    worker,
    close: async () => {
      await worker.close();
      await queue.close();
    },
  };
}
