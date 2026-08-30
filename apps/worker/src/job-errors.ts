import { describeRedisError, type Logger } from '@proton/core';
import type { Queue, Worker } from 'bullmq';

export function logQueueConnectionErrors(
  label: string,
  logger: Logger,
  queue: Queue,
  worker: Worker,
): void {
  let reported: string | null = null;

  const report = (error: unknown) => {
    const detail = describeRedisError(error);
    if (detail === reported) return;

    reported = detail;
    logger.error(`${label} lost its redis connection, so its jobs are not running: ${detail}`);
  };

  queue.on('error', report);
  worker.on('error', report);

  // Queue and Worker never emit 'ready'; a completed job is the only reconnect signal BullMQ gives.
  worker.on('completed', () => {
    if (reported) logger.info(`${label} reconnected to redis.`);

    reported = null;
  });
}
