import type {
  EventBus,
  EventType,
  GuildRule,
  Logger,
  ModuleRegistry,
  ProtonEvent,
  RuleEngine,
  RuleEvaluationReport,
  RuleOutcome,
  Subscription,
} from '@proton/core';
import type { GuildRuleStore } from '@proton/db';
import { type ConnectionOptions, type Job, Queue, Worker } from 'bullmq';
import { z } from 'zod';
import { ConfigUnavailableError } from './config-provider.ts';
import { logQueueConnectionErrors } from './job-errors.ts';
import { factsFor } from './rule-facts.ts';
import type { ConfigProvider } from './runtime.ts';

export const RULE_DISPATCH_GROUP = 'rules';

export const RULE_PRESET_GROUP = 'rule-presets';

export const RULE_CRON_QUEUE = 'proton-rule-cron';

export function ruleTriggerEvents(registry: ModuleRegistry): EventType[] {
  return [
    ...new Set(
      registry
        .all()
        .flatMap((manifest) => manifest.rules ?? [])
        .flatMap((rule) => (rule.trigger.kind === 'event' ? [rule.trigger.event] : [])),
    ),
  ];
}

export interface RuleDispatchDeps {
  bus: EventBus;
  registry: ModuleRegistry;
  engine: RuleEngine;
  store: GuildRuleStore;

  config: ConfigProvider;
  logger: Logger;

  group?: string;
}

export class RuleDispatchRuntime {
  readonly #deps: RuleDispatchDeps;

  constructor(deps: RuleDispatchDeps) {
    this.#deps = deps;
  }

  triggers(): EventType[] {
    return ruleTriggerEvents(this.#deps.registry);
  }

  start(): Subscription[] {
    const types = this.triggers();
    if (types.length === 0) {
      this.#deps.logger.warn(
        'no registered module declares an event-triggered rule, so the rule engine is ' +
          'subscribed to nothing. Preset rules will still be seeded, but none can fire.',
      );
      return [];
    }

    this.#deps.logger.info('evaluating rules', { types: types.join(', ') });

    return [
      this.#deps.bus.subscribe(
        this.#deps.group ?? RULE_DISPATCH_GROUP,
        types,
        (event) => this.handle(event),
        { startId: '$' },
      ),
    ];
  }

  async handle(event: ProtonEvent): Promise<void> {
    if (event.guildId === null) return;
    const guildId = event.guildId;

    const stored = await this.#deps.store.listForEvent(guildId, event.type);

    if (stored.length === 0) return;

    const live = await this.#enabledRules(guildId, stored, event);
    if (live.length === 0) return;

    const facts = factsFor(event);

    const report = await this.#deps.engine.evaluate({ event, facts, rules: live, dryRun: false });
    this.#report(event, report);
  }

  async #enabledRules(
    guildId: string,
    rules: readonly GuildRule[],
    event: ProtonEvent,
  ): Promise<GuildRule[]> {
    const verdicts = new Map<string, boolean>();
    for (const moduleId of new Set(rules.map((rule) => rule.moduleId))) {
      verdicts.set(moduleId, await this.#moduleEnabled(guildId, moduleId, event));
    }

    return rules.filter((rule) => verdicts.get(rule.moduleId) === true);
  }

  async #moduleEnabled(guildId: string, moduleId: string, event: ProtonEvent): Promise<boolean> {
    if (!this.#deps.registry.get(moduleId)) {
      this.#deps.logger.warn(
        `guild ${guildId} has stored rules for '${moduleId}', but no module with that id is ` +
          'loaded in this worker, so they were not evaluated. Either the module was removed ' +
          "from the build or its id changed; delete the guild's rows for it, or restore it.",
        { guildId, moduleId, eventType: event.type },
      );
      return false;
    }

    try {
      return (await this.#deps.config.get(guildId, moduleId)).enabled;
    } catch (error) {
      if (error instanceof ConfigUnavailableError && error.permanent) {
        this.#deps.logger.error(
          `the rules belonging to ${moduleId} did not run in this server because the module's ` +
            `configuration could not be read, and retrying will not help: ${error.message}. Open ` +
            "the module's settings in the Proton dashboard and save them once to rewrite the " +
            'stored config.',
          { guildId, moduleId, status: error.status, eventType: event.type, eventId: event.id },
        );
        return false;
      }

      throw error;
    }
  }

  #report(event: ProtonEvent, report: RuleEvaluationReport): void {
    for (const outcome of report.outcomes) {
      logOutcome(this.#deps.logger, outcome, {
        guildId: event.guildId,
        eventId: event.id,
        eventType: event.type,
      });
    }
  }
}

interface OutcomeContext {
  guildId: string | null;
  eventId: string;
  eventType: string;
}

export function logOutcome(logger: Logger, outcome: RuleOutcome, context: OutcomeContext): void {
  const rule = `${outcome.moduleId}:${outcome.ruleId}`;
  const base = { ...context, rule };

  if (outcome.skipped) {
    const message = `rule ${rule} did not fire: ${outcome.skipped.humanReason}`;
    const detail = {
      ...base,
      code: outcome.skipped.code,
      ...(outcome.skipped.conditionKind ? { conditionKind: outcome.skipped.conditionKind } : {}),
    };

    if (outcome.skipped.code === 'invalid-rule') logger.error(message, detail);
    else logger.info(message, detail);
    return;
  }

  for (const action of outcome.actions) {
    const detail = { ...base, kind: action.kind, idempotencyKey: action.idempotencyKey };

    if (action.error !== undefined) {
      logger.error(
        `rule ${rule} could not perform its ${action.kind} action: ${action.error}`,
        detail,
      );
      continue;
    }

    const result = action.result;
    if (!result) continue;

    if (result.status === 'executed' || result.status === 'dry_run') {
      logger.info(`rule ${rule} performed ${action.kind}`, { ...detail, status: result.status });
      continue;
    }

    logger.error(
      `rule ${rule} did not perform ${action.kind}: ${
        result.failure?.humanReason ?? `the executor answered ${result.status}`
      }`,
      {
        ...detail,
        status: result.status,
        ...(result.failure ? { code: result.failure.code } : {}),
      },
    );
  }
}

export interface RuleCronRegistrar {
  register(guildId: string): Promise<number>;
}

export interface RulePresetSeederDeps {
  bus: EventBus;
  registry: ModuleRegistry;
  store: GuildRuleStore;
  logger: Logger;

  cron?: RuleCronRegistrar;
  group?: string;
}

export class RulePresetSeeder {
  readonly #deps: RulePresetSeederDeps;

  constructor(deps: RulePresetSeederDeps) {
    this.#deps = deps;
  }

  start(): Subscription {
    return this.#deps.bus.subscribe(
      this.#deps.group ?? RULE_PRESET_GROUP,
      ['guild.available'],
      (event) => this.handle(event),
    );
  }

  async handle(event: ProtonEvent): Promise<void> {
    if (event.guildId === null) return;
    const guildId = event.guildId;

    let seeded = 0;
    for (const manifest of this.#deps.registry.all()) {
      const presets = manifest.rules ?? [];
      if (presets.length === 0) continue;
      seeded += await this.#deps.store.seedPresets(guildId, manifest.id, presets);
    }

    if (seeded > 0) this.#deps.logger.info(`seeded ${seeded} preset rule(s)`, { guildId });

    await this.#registerCron(guildId);
  }

  async #registerCron(guildId: string): Promise<void> {
    if (!this.#deps.cron) return;

    try {
      const scheduled = await this.#deps.cron.register(guildId);
      if (scheduled > 0) {
        this.#deps.logger.info(`scheduled ${scheduled} cron rule(s)`, { guildId });
      }
    } catch (error) {
      this.#deps.logger.error(
        `could not schedule the cron rules for guild ${guildId} — they will NOT run until the ` +
          `next time the gateway reconnects to this server: ${
            error instanceof Error ? error.message : String(error)
          }`,
        { guildId },
      );
    }
  }
}

const cronJobDataSchema = z.object({
  guildId: z.string().min(1),
  moduleId: z.string().min(1),
  ruleId: z.string().min(1),
});

export type CronJobData = z.infer<typeof cronJobDataSchema>;

export const cronSchedulerId = (data: CronJobData): string =>
  `${data.guildId}:${data.moduleId}:${data.ruleId}`;

export interface CronSchedule {
  id: string;
  data: CronJobData;

  pattern: string;
  timezone?: string;
}

export function cronSchedulesFor(guildId: string, rules: readonly GuildRule[]): CronSchedule[] {
  const schedules: CronSchedule[] = [];

  for (const rule of rules) {
    if (rule.trigger.kind !== 'cron') continue;

    const data: CronJobData = { guildId, moduleId: rule.moduleId, ruleId: rule.id };
    schedules.push({
      id: cronSchedulerId(data),
      data,
      pattern: rule.trigger.cron,
      ...(rule.trigger.timezone ? { timezone: rule.trigger.timezone } : {}),
    });
  }

  return schedules;
}

export type CronTick = Pick<Job, 'id' | 'name' | 'data' | 'timestamp'>;

export interface CronTickDeps {
  engine: RuleEngine;
  store: GuildRuleStore;
  logger: Logger;
  now?: () => number;
}

export interface RuleCronSchedulerDeps extends CronTickDeps {
  connection: ConnectionOptions;
}

export async function fireCronRule(deps: CronTickDeps, job: CronTick): Promise<void> {
  const parsed = cronJobDataSchema.safeParse(job.data);
  if (!parsed.success) {
    deps.logger.error(
      `cron rule job '${job.name}' carries data this build cannot read, so it did not run. It is ` +
        'probably a schedule left behind by an older deployment; remove it with ' +
        `queue.removeJobScheduler('${job.name}'). Issues: ${parsed.error.issues
          .map((issue) => `${issue.path.map(String).join('.') || 'data'} ${issue.message}`)
          .join('; ')}`,
    );
    return;
  }

  const { guildId, moduleId, ruleId } = parsed.data;
  const rule = (await deps.store.listCron(guildId)).find(
    (candidate) => candidate.moduleId === moduleId && candidate.id === ruleId,
  );

  if (!rule) {
    deps.logger.warn(
      `cron rule ${moduleId}:${ruleId} no longer exists in guild ${guildId}, so this tick did ` +
        'nothing. Its schedule outlived the rule; remove it with ' +
        `queue.removeJobScheduler('${cronSchedulerId(parsed.data)}').`,
      { guildId, moduleId, ruleId },
    );
    return;
  }

  if (!rule.enabled) return;

  const outcome = await deps.engine.fire(rule, {
    event: cronEvent(parsed.data, job, deps.now?.() ?? Date.now()),
    facts: {},
    dryRun: false,
  });

  logOutcome(deps.logger, outcome, {
    guildId,
    eventId: cronEventId(parsed.data, job),
    eventType: RULE_CRON_EVENT_TYPE,
  });
}

export class RuleCronScheduler implements RuleCronRegistrar {
  readonly #deps: RuleCronSchedulerDeps;
  readonly #queue: Queue;
  readonly #worker: Worker;

  constructor(deps: RuleCronSchedulerDeps) {
    this.#deps = deps;

    this.#queue = new Queue(RULE_CRON_QUEUE, {
      connection: deps.connection,

      defaultJobOptions: { removeOnComplete: 50, removeOnFail: 200 },
    });

    this.#worker = new Worker(RULE_CRON_QUEUE, (job) => fireCronRule(this.#deps, job), {
      connection: deps.connection,
    });

    this.#worker.on('failed', (job, error) => {
      deps.logger.error(`cron rule '${job?.name ?? 'unknown'}' failed: ${error.message}`, {
        stack: error.stack,
      });
    });

    logQueueConnectionErrors('cron rules', deps.logger, this.#queue, this.#worker);
  }

  async register(guildId: string): Promise<number> {
    const schedules = cronSchedulesFor(guildId, await this.#deps.store.listCron(guildId));

    let scheduled = 0;
    for (const schedule of schedules) {
      try {
        await this.#queue.upsertJobScheduler(
          schedule.id,

          { pattern: schedule.pattern, ...(schedule.timezone ? { tz: schedule.timezone } : {}) },
          { name: schedule.id, data: schedule.data },
        );
        scheduled += 1;
      } catch (error) {
        this.#deps.logger.error(
          `could not schedule cron rule ${schedule.data.moduleId}:${schedule.data.ruleId} for ` +
            `guild ${guildId} — it will NOT run. Its schedule is '${schedule.pattern}': ${
              error instanceof Error ? error.message : String(error)
            }`,
          { ...schedule.data },
        );
      }
    }

    return scheduled;
  }

  async close(): Promise<void> {
    await this.#worker.close();
    await this.#queue.close();
  }
}

export const RULE_CRON_EVENT_TYPE = 'rule.cron';

function cronEventId(data: CronJobData, job: Pick<CronTick, 'id' | 'timestamp'>): string {
  return `rule-cron:${cronSchedulerId(data)}:${job.id ?? job.timestamp}`;
}

function cronEvent(data: CronJobData, job: CronTick, now: number): ProtonEvent {
  return {
    id: cronEventId(data, job),

    type: RULE_CRON_EVENT_TYPE as EventType,
    guildId: data.guildId,
    occurredAt: job.timestamp ?? now,
    payload: data,
  };
}
