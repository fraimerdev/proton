import type { Logger, ModuleRegistry, ScheduledJob } from '@proton/core';
import { type ConnectionOptions, Queue, Worker } from 'bullmq';

export const MODULE_JOBS_QUEUE = 'proton-module-jobs';

export const jobKey = (moduleId: string, jobId: string): string => `${moduleId}:${jobId}`;

export type ModuleJobHandler = (payload: Record<string, unknown>) => Promise<unknown>;

export interface ModuleJobsDeps {
  connection: ConnectionOptions;
  registry: ModuleRegistry;

  handlers: Record<string, ModuleJobHandler>;
  logger: Logger;
}

export interface ModuleJobs {
  queue: Queue;
  worker: Worker;

  scheduled: string[];
  close(): Promise<void>;
}

export class UnhandledModuleJobError extends Error {
  constructor(missing: readonly string[]) {
    super(
      `The following module jobs are declared but have no handler: ${missing.join(', ')}. ` +
        "Every entry in a manifest's `jobs` array must have a matching key in the `handlers` " +
        'map passed to startModuleJobs, or it would be scheduled and then silently do nothing.',
    );
    this.name = 'UnhandledModuleJobError';
  }
}

export function declaredJobs(registry: ModuleRegistry): Array<{ key: string; job: ScheduledJob }> {
  return registry
    .all()
    .flatMap((manifest) =>
      (manifest.jobs ?? []).map((job) => ({ key: jobKey(manifest.id, job.id), job })),
    );
}

export function assertHandlersCoverJobs(
  registry: ModuleRegistry,
  handlers: Record<string, ModuleJobHandler>,
  logger: Logger,
): void {
  const declared = declaredJobs(registry);

  const missing = declared.filter(({ key }) => !handlers[key]).map(({ key }) => key);
  if (missing.length > 0) throw new UnhandledModuleJobError(missing);

  const declaredKeys = new Set(declared.map(({ key }) => key));
  for (const key of Object.keys(handlers)) {
    if (!declaredKeys.has(key)) {
      logger.warn(
        `a handler is registered for '${key}' but no module declares that job, so it will ` +
          'never run. Check the job id in the module manifest.',
      );
    }
  }
}

export function startModuleJobs(deps: ModuleJobsDeps): ModuleJobs {
  assertHandlersCoverJobs(deps.registry, deps.handlers, deps.logger);
  const declared = declaredJobs(deps.registry);

  const queue = new Queue(MODULE_JOBS_QUEUE, {
    connection: deps.connection,

    defaultJobOptions: { removeOnComplete: 50, removeOnFail: 200 },
  });

  const worker = new Worker(
    MODULE_JOBS_QUEUE,
    async (job) => {
      const handler = deps.handlers[job.name];
      if (!handler) {
        throw new Error(
          `no handler for module job '${job.name}'. It is probably a schedule left behind by ` +
            'an older build; remove it with queue.removeJobScheduler.',
        );
      }
      return handler((job.data ?? {}) as Record<string, unknown>);
    },
    { connection: deps.connection },
  );

  worker.on('failed', (job, error) => {
    deps.logger.error(`module job '${job?.name ?? 'unknown'}' failed: ${error.message}`, {
      stack: error.stack,
    });
  });

  for (const { key, job } of declared) {
    void queue
      .upsertJobScheduler(
        key,

        { pattern: job.cron, ...(job.timezone ? { tz: job.timezone } : {}) },
        { name: key, data: job.payload ?? {} },
      )
      .catch((error: unknown) => {
        deps.logger.error(
          `could not register the schedule for module job '${key}' — it will NOT run: ` +
            `${error instanceof Error ? error.message : String(error)}`,
        );
      });
  }

  return {
    queue,
    worker,
    scheduled: declared.map(({ key }) => key),
    close: async () => {
      await worker.close();
      await queue.close();
    },
  };
}
