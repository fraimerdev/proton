import type { Logger, ModuleRegistry, ScheduledJob } from '@proton/core';
import { type ConnectionOptions, Queue, Worker } from 'bullmq';

/**
 * No colon — BullMQ builds its own keys as `bull:<queue>:<id>`, so a colon here
 * would nest a second namespace inside theirs. Same constraint `REVERSAL_QUEUE`
 * documents.
 */
export const MODULE_JOBS_QUEUE = 'proton-module-jobs';

/** `<moduleId>:<jobId>` — the key a declared job is matched to a handler by. */
export const jobKey = (moduleId: string, jobId: string): string => `${moduleId}:${jobId}`;

export type ModuleJobHandler = (payload: Record<string, unknown>) => Promise<unknown>;

export interface ModuleJobsDeps {
  connection: ConnectionOptions;
  registry: ModuleRegistry;
  /** Keyed by `<moduleId>:<jobId>`. Must cover every job the registry declares. */
  handlers: Record<string, ModuleJobHandler>;
  logger: Logger;
}

export interface ModuleJobs {
  queue: Queue;
  worker: Worker;
  /** The `<moduleId>:<jobId>` keys actually scheduled, in registry order. */
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

/**
 * Run `manifest.jobs` — the last declared-but-unread part of the module
 * contract.
 *
 * `ScheduledJob` is deliberately data and nothing else: an id, a cron expression
 * and an opaque payload, with no callback (§7 keeps manifests inspectable, and a
 * function in a manifest is a function `apps/api` and the dashboard would import
 * without ever calling). The consequence is that the *work* has to be supplied
 * separately, which opens a gap the boot-time totality check below exists to
 * close: a module can otherwise declare a job that nothing implements, BullMQ
 * schedules it, the tick fires, no handler matches, and the job silently does
 * nothing forever. Phishing's blocklist would never populate and the module would
 * correctly report "no blocklist loaded" for the rest of the deployment's life.
 *
 * So a missing handler is fatal at startup, before the process claims to be
 * working. Naming the modules and the expected keys makes it a thirty-second fix
 * rather than an investigation.
 *
 * `upsertJobScheduler` also gives free leader election: several worker replicas
 * can run this and Redis still produces one tick per schedule. That matters most
 * for phishing, whose job fetches community-maintained feeds — one polite request
 * per interval per fleet, not one per replica.
 */
/** Every `(module, job)` the registry declares, keyed for the handler map. */
export function declaredJobs(registry: ModuleRegistry): Array<{ key: string; job: ScheduledJob }> {
  return registry
    .all()
    .flatMap((manifest) =>
      (manifest.jobs ?? []).map((job) => ({ key: jobKey(manifest.id, job.id), job })),
    );
}

/**
 * Check that every declared job has a handler, before any queue exists.
 *
 * Separate from `startModuleJobs` so it can be asserted without a Redis
 * connection — the check is the interesting part and it is pure.
 */
export function assertHandlersCoverJobs(
  registry: ModuleRegistry,
  handlers: Record<string, ModuleJobHandler>,
  logger: Logger,
): void {
  const declared = declaredJobs(registry);

  const missing = declared.filter(({ key }) => !handlers[key]).map(({ key }) => key);
  if (missing.length > 0) throw new UnhandledModuleJobError(missing);

  // The other direction is a mistake too, but a harmless one: a handler for a job
  // nobody declares is dead code, most likely a renamed job id. Worth saying,
  // not worth refusing to start over.
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
  // Before the queue: a process that cannot honour what it declares should not
  // announce itself as running.
  assertHandlersCoverJobs(deps.registry, deps.handlers, deps.logger);
  const declared = declaredJobs(deps.registry);

  const queue = new Queue(MODULE_JOBS_QUEUE, {
    connection: deps.connection,
    /**
     * Bounded history. BullMQ's documented default is to keep completed jobs
     * forever, so an hourly blocklist refresh and a nightly partition sweep
     * would accumulate a hash and a set member per tick in Redis for the life of
     * the deployment — a slow leak in the one datastore whose loss costs the
     * most. Enough is kept to answer "did it run, and did it fail" from
     * `/workflows`-style tooling; failures are kept longer because they are the
     * ones anyone reads.
     */
    defaultJobOptions: { removeOnComplete: 50, removeOnFail: 200 },
  });

  const worker = new Worker(
    MODULE_JOBS_QUEUE,
    async (job) => {
      const handler = deps.handlers[job.name];
      if (!handler) {
        // Reachable despite the check above: a schedule persisted in Redis by a
        // previous deployment outlives the manifest that declared it.
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
    // Fire-and-forget, as the reversal sweep is: registering a schedule must not
    // block startup, and a failure has to be loud rather than fatal — the rest of
    // the worker is still useful without one recurring job.
    void queue
      .upsertJobScheduler(
        key,
        // `pattern`, not `every`: ScheduledJob carries a cron expression, and
        // `timezone` is honoured when the module set one (most deliberately do
        // not — see the comments on each job).
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
