import type { Logger, ModuleContext } from '@proton/core';
import {
  type FlushRequest,
  flushPending,
  SERVERLOG_MODULE_ID,
  type ServerlogConfig,
  type ServerlogDeps,
} from '@proton/module-serverlog';
import { type ConnectionOptions, Queue, Worker } from 'bullmq';
import { logQueueConnectionErrors } from './job-errors.ts';

export const LOG_FLUSH_QUEUE = 'proton-log-flush';
export const LOG_FLUSH_JOB = 'flush';

export interface ServerlogFlushDeps {
  connection: ConnectionOptions;
  serverlog: ServerlogDeps;

  contextFor(guildId: string): Promise<ModuleContext<ServerlogConfig> | null>;

  logger: Logger;
}

export interface ServerlogFlushJobs {
  queue: Queue;
  worker: Worker;
  schedule(request: FlushRequest): Promise<void>;
  close(): Promise<void>;
}

export function startServerlogFlush(deps: ServerlogFlushDeps): ServerlogFlushJobs {
  const queue = new Queue(LOG_FLUSH_QUEUE, { connection: deps.connection });

  const worker = new Worker(
    LOG_FLUSH_QUEUE,
    async (job) => {
      const request = job.data as FlushRequest;
      const ctx = await deps.contextFor(request.guildId);
      if (!ctx) return;

      await flushPending(deps.serverlog, ctx, request);
    },
    { connection: deps.connection },
  );

  worker.on('failed', (_job, error) => {
    deps.logger.error(`a server-log flush failed: ${error.message}`, {
      moduleId: SERVERLOG_MODULE_ID,
      stack: error.stack,
    });
  });

  logQueueConnectionErrors('the server-log flush', deps.logger, queue, worker);

  return {
    queue,
    worker,

    async schedule(request: FlushRequest): Promise<void> {
      // The job id is the correlation key, so a redelivered entity event reuses the same delayed
      // job instead of queueing a second flush for the same fact.
      await queue.add(LOG_FLUSH_JOB, request, {
        jobId: `${request.guildId}:${request.actionType}:${request.targetId}`,
        delay: request.delayMs,
        removeOnComplete: true,
        removeOnFail: 100,
      });
    },

    async close(): Promise<void> {
      await worker.close();
      await queue.close();
    },
  };
}
