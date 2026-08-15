import type { Logger, ReversalSweeper } from '@proton/core';
import { type ConnectionOptions, Queue, Worker } from 'bullmq';

export const REVERSAL_QUEUE = 'proton-reversals';
export const REVERSAL_SWEEP_JOB = 'sweep';

export interface ReversalJobsDeps {
  connection: ConnectionOptions;
  sweeper: ReversalSweeper;
  intervalMs: number;
  logger: Logger;
}

export interface ReversalJobs {
  queue: Queue;
  worker: Worker;
  close(): Promise<void>;
}

export function startReversalJobs(deps: ReversalJobsDeps): ReversalJobs {
  const queue = new Queue(REVERSAL_QUEUE, { connection: deps.connection });

  const worker = new Worker(
    REVERSAL_QUEUE,
    async () => {
      const result = await deps.sweeper.sweep();

      if (result.claimed > 0) deps.logger.info('reversal sweep', { ...result });
      return result;
    },
    { connection: deps.connection },
  );

  worker.on('failed', (_job, error) => {
    deps.logger.error(`reversal sweep failed: ${error.message}`, { stack: error.stack });
  });

  void queue
    .upsertJobScheduler(REVERSAL_SWEEP_JOB, { every: deps.intervalMs })
    .catch((error: unknown) => {
      deps.logger.error(
        'could not register the reversal sweep schedule — temporary actions will NOT ' +
          `lift automatically: ${error instanceof Error ? error.message : String(error)}`,
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
