import type {
  ActionExecutor,
  Logger,
  ModuleContext,
  ModuleRegistry,
  ScheduledJob,
  ScheduledModuleJob,
} from '@proton/core';
import { type ConnectionOptions, Queue, Worker } from 'bullmq';
import { ConfigUnavailableError } from './config-provider.ts';
import { moduleExecutor } from './module-actions.ts';
import type { ModulePublisherFactory } from './module-publish.ts';
import type { ModuleSchedulerFactory } from './module-schedule.ts';
import { type ConfigProvider, disabledReason, type ModuleConfigSnapshot } from './runtime.ts';

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

export interface ScheduledJobRunnerDeps {
  registry: ModuleRegistry;
  config: ConfigProvider;
  executor: ActionExecutor;
  logger: Logger;

  publisherFor?: ModulePublisherFactory;
  schedulerFor?: ModuleSchedulerFactory;
}

export function createScheduledJobRunner(deps: ScheduledJobRunnerDeps) {
  return async function runModuleJob(job: ScheduledModuleJob): Promise<void> {
    const label = `${job.moduleId}:${job.jobId}`;
    const manifest = deps.registry.get(job.moduleId);

    if (!manifest) {
      throw new Error(
        `no module '${job.moduleId}' is loaded in this worker, so the scheduled '${label}' job ` +
          'cannot run. It is probably a schedule left behind by an older build.',
      );
    }

    const handlers = manifest.scheduledHandlers ?? {};
    // Object.hasOwn first: handlers['constructor'] is Object, which a plain lookup would call.
    const handler = Object.hasOwn(handlers, job.jobId) ? handlers[job.jobId] : undefined;

    if (typeof handler !== 'function') {
      throw new Error(
        `${manifest.name} declares no scheduled handler for '${job.jobId}', so the row scheduled ` +
          'under it cannot run. Add it to `scheduledHandlers` in the manifest, or cancel the row.',
      );
    }

    let snapshot: ModuleConfigSnapshot;
    try {
      snapshot = await deps.config.get(job.guildId, manifest.id);
    } catch (error) {
      if (error instanceof ConfigUnavailableError && error.permanent) {
        deps.logger.error(
          `the scheduled '${label}' job was dropped because this server's configuration could ` +
            `not be read, and retrying will not help: ${error.message}. Open the module's ` +
            'settings in the Proton dashboard and save them once to rewrite the stored config.',
          { guildId: job.guildId, moduleId: manifest.id, jobId: job.jobId, status: error.status },
        );
        return;
      }
      throw error;
    }

    const disabled = disabledReason(snapshot, manifest.configSchema);
    if (disabled) {
      deps.logger.warn(
        `${manifest.name} is switched off in this server, so its scheduled '${job.jobId}' job ` +
          'did not run and has been dropped. Re-enable the module and schedule it again.',
        { guildId: job.guildId, moduleId: manifest.id, jobId: job.jobId, disabled },
      );
      return;
    }

    const parsed = manifest.configSchema.safeParse(snapshot.config);
    if (!parsed.success) {
      throw new Error(
        `this server's ${manifest.name} settings are not valid, so the scheduled '${job.jobId}' ` +
          `job did not run: ${parsed.error.issues
            .map((i) => `${i.path.map(String).join('.')} ${i.message}`)
            .join('; ')}`,
      );
    }

    const ctx: ModuleContext<typeof parsed.data> = {
      guildId: job.guildId,
      config: parsed.data,
      tier: snapshot.tier ?? 'free',
      executor: moduleExecutor(deps.registry, manifest.id, deps.executor),
      logger: deps.logger,

      ...(deps.publisherFor ? { publish: deps.publisherFor(manifest.id, job.guildId) } : {}),
      ...(deps.schedulerFor ? deps.schedulerFor(manifest.id, job.guildId, job) : {}),
    };

    await handler(job.data, ctx);
  };
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
