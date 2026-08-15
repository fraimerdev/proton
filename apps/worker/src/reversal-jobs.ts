import type { Logger, ReversalSweeper } from '@proton/core';
import { type ConnectionOptions, Queue, Worker } from 'bullmq';

/**
 * BullMQ rejects a colon in a queue name — it builds its own Redis keys as
 * `bull:<queue>:<id>`, so a colon here would nest a second namespace inside
 * theirs and make keys ambiguous. Proton's own Redis keys use colons freely
 * (`proton:events:*`, `proton:dedupe:*`); this one cannot.
 */
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

/**
 * Run the reversal sweep on an interval.
 *
 * BullMQ's *only* job here is the tick. Due-detection deliberately stays in the
 * `scheduled_actions` query: a BullMQ delayed job holds the expiry in Redis, so
 * flushing Redis, or losing it, would silently convert every outstanding temp
 * ban into a permanent one with nothing left to show it happened. A missed tick
 * costs latency; a missed delayed job costs the guarantee.
 *
 * The repeatable job also gives free leader election — several worker replicas
 * can run this and Redis still produces one tick per interval — while the
 * sweeper's atomic claim makes overlapping sweeps harmless anyway.
 */
export function startReversalJobs(deps: ReversalJobsDeps): ReversalJobs {
  const queue = new Queue(REVERSAL_QUEUE, { connection: deps.connection });

  const worker = new Worker(
    REVERSAL_QUEUE,
    async () => {
      const result = await deps.sweeper.sweep();
      // Silent when there is nothing to do; a sweep that touched rows is worth a
      // line, because "the temp ban never lifted" is otherwise unobservable.
      if (result.claimed > 0) deps.logger.info('reversal sweep', { ...result });
      return result;
    },
    { connection: deps.connection },
  );

  worker.on('failed', (_job, error) => {
    deps.logger.error(`reversal sweep failed: ${error.message}`, { stack: error.stack });
  });

  // Fire-and-forget: registering the schedule must not block worker startup, and
  // a failure here has to be loud rather than fatal — the rest of the worker is
  // still useful without it.
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
