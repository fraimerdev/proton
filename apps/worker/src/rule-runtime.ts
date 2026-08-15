import {
  dryRunFor,
  type EventBus,
  type EventType,
  type GuildRule,
  type Logger,
  type ModuleRegistry,
  type ProtonEvent,
  type RuleEngine,
  type RuleEvaluationReport,
  type RuleOutcome,
  type Subscription,
} from '@proton/core';
import type { GuildRuleStore } from '@proton/db';
import { type ConnectionOptions, type Job, Queue, Worker } from 'bullmq';
import { z } from 'zod';
import { ConfigUnavailableError } from './config-provider.ts';
import { factsFor } from './rule-facts.ts';
import type { ConfigProvider } from './runtime.ts';

/**
 * The rule engine, connected (PLAN.md §4-P2, PHASE-3 G4).
 *
 * `RuleEngine`, `ruleConditionSchema`, `RedisRateWindow` and the `rules` table
 * were all built and tested and then instantiated by nobody, which made P2 — one
 * of the four primitives the plan says everything else is configuration on top of
 * — dead code. Three pieces close that, and they are separate classes on purpose:
 *
 *  - `RuleDispatchRuntime` evaluates event-triggered rules off the bus;
 *  - `RulePresetSeeder` writes a module's presets into a guild on first sight;
 *  - `RuleCronScheduler` ticks the rules that no event will ever trigger.
 *
 * Each owns its own acknowledgement. A seeding failure must not hold up rule
 * dispatch and a failing cron rule must not redeliver a message event, which is
 * the same argument `GuildLayoutConsumer` makes for not living inside
 * `GuildStateConsumer`.
 */

/** One group for every rule trigger — see `RuleDispatchRuntime`. */
export const RULE_DISPATCH_GROUP = 'rules';

/** Its own group: seeding and dispatch fail for unrelated reasons. */
export const RULE_PRESET_GROUP = 'rule-presets';

/** No colon — BullMQ builds its keys as `bull:<queue>:<id>` (see `REVERSAL_QUEUE`). */
export const RULE_CRON_QUEUE = 'proton-rule-cron';

/**
 * Every event type some registered manifest's rules trigger on.
 *
 * **Known limit, and it will bite when the rule builder ships.** This reads
 * manifests, not the `rules` table, so a rule a guild admin writes against an
 * event type no module's presets mention would be stored, indexed, and never
 * delivered to anything — the subscription simply is not listening for it. That
 * is correct today (every rule in the table got there from a manifest) and wrong
 * the moment §9's builder lets an admin pick a trigger. Closing it means either
 * subscribing to the union of `NORMALISED_EVENT_TYPES` and the registry's
 * `emittedTypes()`, or re-subscribing when a guild saves a rule; do not close it
 * by widening this function to query the database on every boot, which answers
 * for the guilds that existed at boot and no others.
 */
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

/**
 * Whether this rule runs for real.
 *
 * **I12, applied per rule rather than per action, and the trade is deliberate.**
 * `RuleFireInput.dryRun` is one boolean for every action in a rule, so there is
 * no way to run a ladder's `send` for real while withholding its `ban`. Given
 * that, the choice is which way a mixed rule should fall, and it falls closed: if
 * *any* action in the rule is destructive outside production, the whole rule is
 * dry-run. The alternative — passing `dryRun: false` and letting the destructive
 * action through — would ban people from development guilds, which is the exact
 * outcome I12 exists to prevent.
 *
 * What that costs, stated plainly: a rung that bans and then posts "banned @user
 * for spam" posts nothing in development. That is the better failure. A mod-log
 * line announcing a ban that never happened is a log that lies, and someone
 * would eventually trust it.
 *
 * The real fix is a per-action `dryRun` on `RuleAction`, which is a
 * `packages/core` change and so out of this slice's reach.
 * TODO(phase-4): move `dryRun` onto the action, and delete this function.
 */
export function ruleIsDryRun(rule: GuildRule, nodeEnv?: string): boolean {
  return rule.actions.some((action) => dryRunFor(action.kind, nodeEnv));
}

export interface RuleDispatchDeps {
  bus: EventBus;
  registry: ModuleRegistry;
  engine: RuleEngine;
  store: GuildRuleStore;
  /** Read only for its `enabled` flag — see `#moduleEnabled`. */
  config: ConfigProvider;
  logger: Logger;
  /** Overridable so a test can isolate its group from a shared Redis. */
  group?: string;
  /** Pinned so a test can assert the dry-run policy without inheriting the runner's env. */
  nodeEnv?: string;
}

/**
 * Evaluates every guild's event-triggered rules.
 *
 * A sibling of `ModuleListenerRuntime`, and the differences from it are all
 * deliberate:
 *
 *  1. **One consumer group, not one per module.** `ModuleListenerRuntime` splits
 *     per module so that a module whose handler throws retries alone. There is no
 *     equivalent blast radius here: the engine catches per rule and per action —
 *     one broken rule lands in the report and evaluation continues — so the only
 *     things that can throw out of `handle` are the store read and a config read,
 *     both of which fail for the guild rather than for a module. Splitting would
 *     buy nothing and cost one Redis connection per module.
 *
 *  2. **`{ startId: '$' }`,** for exactly the reason the listener runtime
 *     documents: streams are never trimmed, so a group created at `'0'` would
 *     replay the full retained history the first time this is deployed, and any
 *     entry older than the executor's dedupe TTL is not deduped but re-executed.
 *     A freshly wired engine would work through a backlog of long-settled events
 *     and start banning people for them.
 *
 *  3. **The module's `enabled` flag is honoured, but its config is not read.** A
 *     preset belongs to the module that shipped it, so a guild that switched
 *     `cases` off must not still be escalating warns. But no module code runs
 *     here — the engine builds the `ActionRequest` itself — so there is nothing
 *     to hand a parsed config to, and validating one on every message to consult
 *     a boolean would be I5 ritual with no reader.
 *
 *  4. **A permanent config failure acks**, same triage as the listener runtime:
 *     `apps/api` answers 400 for a stored config that no longer parses and 404
 *     for a module it does not know, and both say the same thing on every retry.
 */
export class RuleDispatchRuntime {
  readonly #deps: RuleDispatchDeps;

  constructor(deps: RuleDispatchDeps) {
    this.#deps = deps;
  }

  /** The types this runtime will subscribe to. Empty when no manifest ships rules. */
  triggers(): EventType[] {
    return ruleTriggerEvents(this.#deps.registry);
  }

  /**
   * Subscribe, or do not.
   *
   * Returns an array of at most one subscription rather than a nullable one so
   * that the caller can spread it into its shutdown list without a null check,
   * and so that "no manifest ships any rules" is a subscription-free state rather
   * than a group registered against an empty type list, which would consume
   * nothing and still hold a connection.
   */
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

  /**
   * Load, evaluate and report one event's rules.
   *
   * A throw asks for redelivery, which is safe here for the same reason it is
   * safe on the listener path: every action the engine dispatches carries an
   * idempotency key derived from `event.id` (I4), and the rate window records the
   * occurrence that crossed it so a redelivered event trips again rather than
   * re-counting. Swallowing a store failure instead would turn a Postgres blip
   * into rules that silently did not run.
   */
  async handle(event: ProtonEvent): Promise<void> {
    // `event.guildId`, never `payload.guild_id` — the normaliser already decided
    // what the guild is for each dispatch shape. A DM has no guild rules and is
    // ordinary, not a fault.
    if (event.guildId === null) return;
    const guildId = event.guildId;

    const stored = await this.#deps.store.listForEvent(guildId, event.type);
    // No log line for the empty case. Most guilds have no rule for most event
    // types, and `message.created` fires per message.
    if (stored.length === 0) return;

    const live = await this.#enabledRules(guildId, stored, event);
    if (live.length === 0) return;

    const facts = factsFor(event);

    for (const [dryRun, group] of splitByDryRun(live, this.#deps.nodeEnv)) {
      const report = await this.#deps.engine.evaluate({ event, facts, rules: group, dryRun });
      this.#report(event, report, dryRun);
    }
  }

  /** Drop rules whose module is switched off in this guild, or is not loaded here. */
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
      // Rows outlive builds: a module removed from the worker leaves its seeded
      // rules behind, and `ON CONFLICT DO NOTHING` means nothing ever cleans them
      // up. Named rather than dropped silently, because the symptom otherwise is
      // "the ladder stopped working" with nothing anywhere to explain it.
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
      // Transient — a 5xx, a dropped connection, the API restarting. Redelivery
      // is what that is for.
      throw error;
    }
  }

  #report(event: ProtonEvent, report: RuleEvaluationReport, dryRun: boolean): void {
    for (const outcome of report.outcomes) {
      logOutcome(this.#deps.logger, outcome, {
        guildId: event.guildId,
        eventId: event.id,
        eventType: event.type,
        dryRun,
      });
    }
  }
}

/**
 * Partition rules by their dry-run verdict, so each half can be evaluated with
 * the boolean `RuleFireInput` gives us.
 *
 * Two calls to `evaluate` rather than one, and one consequence worth knowing: a
 * rule's priority orders it only within its own half, so in development a
 * dry-run rule and a live rule at adjacent priorities may run in the other order.
 * In production `dryRunFor` is false for every kind, every rule lands in the same
 * half, and ordering is exactly as declared — which is the environment where the
 * ordering is load-bearing.
 *
 * The alternative, doing the trigger match and the priority sort here so that
 * `fire` could be called per rule with its own flag, would mean reimplementing
 * the half of `evaluate` that decides which rules are candidates at all — and
 * that half is where the wrong-guild and invalid-rule reporting lives.
 */
export function splitByDryRun(
  rules: readonly GuildRule[],
  nodeEnv?: string,
): Array<[boolean, GuildRule[]]> {
  const live: GuildRule[] = [];
  const dry: GuildRule[] = [];
  for (const rule of rules) {
    (ruleIsDryRun(rule, nodeEnv) ? dry : live).push(rule);
  }

  const groups: Array<[boolean, GuildRule[]]> = [];
  if (live.length > 0) groups.push([false, live]);
  if (dry.length > 0) groups.push([true, dry]);
  return groups;
}

interface OutcomeContext {
  guildId: string | null;
  eventId: string;
  eventType: string;
  dryRun: boolean;
}

/**
 * Turn one `RuleOutcome` into log lines.
 *
 * "Why didn't my rule fire" is the question `RuleOutcome.skipped` exists to
 * answer, so every skip is written out with its `humanReason` verbatim rather
 * than counted. The volume that implies is real and known — a `content-pattern`
 * rule on `message.created` produces a line per message that did not match — and
 * the right home for it is a debug level, which `Logger` does not have. Until it
 * does, the reason is printed: an unanswerable "the bot did nothing" is the
 * failure this codebase is organised against, and a quiet rule engine is the
 * purest form of it.
 *
 * `invalid-rule` is the one skip logged as an error. The others are a rule
 * correctly declining; that one is a row nobody can parse, which is broken for
 * every event and every guild that holds it.
 */
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
      // Never swallowed and never rethrown: the engine already ran the rule's
      // other actions, and failing the whole event here would redeliver the ones
      // that succeeded.
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

    // `failed_precheck` names the permission or the hierarchy problem and where
    // it is (I8); `failed_api` carries Discord's own answer. Both are the reason
    // an admin is looking for, so neither is reduced to a status code.
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

/** What `RulePresetSeeder` needs from the cron scheduler; `RuleCronScheduler` supplies it. */
export interface RuleCronRegistrar {
  register(guildId: string): Promise<number>;
}

export interface RulePresetSeederDeps {
  bus: EventBus;
  registry: ModuleRegistry;
  store: GuildRuleStore;
  logger: Logger;
  /** Omitted when nothing should schedule cron rules — a test, or a replica opted out. */
  cron?: RuleCronRegistrar;
  group?: string;
}

/**
 * Writes each module's preset rules into a guild the first time it is seen.
 *
 * On `guild.available`, which the gateway raises on every (re)connect as well as
 * on a genuine join. That repetition is the reason `seedPresets` inserts with
 * `ON CONFLICT DO NOTHING` and never upserts: a guild that switched a preset off
 * would otherwise have it switched back on every few hours, silently, with the
 * dashboard showing the value they did not choose.
 *
 * Its own consumer group, and a failure rethrows. There is an ordering hazard
 * worth naming: `rules.guild_id` has a foreign key to `guilds`, and the row is
 * written by `GuildStateConsumer` from the same `guild.available` event in a
 * *different* group — so on a guild's very first appearance this can run first
 * and the insert fails on the foreign key. Rethrowing is the correct answer
 * rather than a retry loop here: the bus redelivers, the registration lands in
 * the meantime, and the second delivery seeds. What must not happen is swallowing
 * it, which would leave that guild permanently without its presets and nothing
 * anywhere saying so.
 */
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

    // Only when something was actually written. `guild.available` fires on every
    // reconnect and, after the first one, the honest count is always zero.
    if (seeded > 0) this.#deps.logger.info(`seeded ${seeded} preset rule(s)`, { guildId });

    await this.#registerCron(guildId);
  }

  /**
   * Loud, not fatal — the same posture `startModuleJobs` takes for a schedule it
   * could not register. Seeding has already succeeded by this point, and failing
   * the event would redeliver it only to re-seed nothing; the cost of the failure
   * is that this guild's cron rules wait for the next gateway reconnect, which is
   * hours at worst rather than never.
   */
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

/**
 * Which rule a cron tick is for.
 *
 * Parsed rather than cast because the job's data was written into Redis by a
 * possibly older build of this worker, and a scheduler outlives the deployment
 * that registered it — the same reason `startModuleJobs` handles a job name it
 * has no handler for.
 */
const cronJobDataSchema = z.object({
  guildId: z.string().min(1),
  moduleId: z.string().min(1),
  ruleId: z.string().min(1),
});

export type CronJobData = z.infer<typeof cronJobDataSchema>;

/** `<guildId>:<moduleId>:<ruleId>` — one scheduler per rule per guild. */
export const cronSchedulerId = (data: CronJobData): string =>
  `${data.guildId}:${data.moduleId}:${data.ruleId}`;

/** One `upsertJobScheduler` call, as data. */
export interface CronSchedule {
  id: string;
  data: CronJobData;
  /** A cron expression — `pattern`, never `every`. */
  pattern: string;
  timezone?: string;
}

/**
 * Which schedules a guild's cron rules need.
 *
 * Pure, and separate from `register`, so that "which rules produce which
 * schedules" is assertable without a Redis connection. The `trigger.kind` check
 * is not redundant with `listCron`'s filter — the compiler cannot see through it,
 * and a rule reaching here with an event trigger would otherwise be scheduled to
 * fire on a clock as well as on its event.
 */
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

/** The four fields a tick needs. Narrower than `Job` so a test can build one. */
export type CronTick = Pick<Job, 'id' | 'name' | 'data' | 'timestamp'>;

export interface CronTickDeps {
  engine: RuleEngine;
  store: GuildRuleStore;
  logger: Logger;
  nodeEnv?: string;
  now?: () => number;
}

export interface RuleCronSchedulerDeps extends CronTickDeps {
  connection: ConnectionOptions;
}

/**
 * Run one cron tick.
 *
 * A free function rather than a method so it can be exercised without a BullMQ
 * `Queue` and `Worker`, both of which open a Redis connection the moment they are
 * constructed. The scheduler below is then only the part that genuinely needs
 * Redis: registering the schedule and receiving the tick.
 *
 * `engine.fire` rather than `evaluate`: there is no event to match a trigger
 * against, and `evaluate` would discard the rule for exactly that reason.
 *
 * Facts are empty, and that is not a gap to fill later. A cron rule is not about
 * anybody — there is no actor, no channel and no message — so a condition that
 * needs one refuses by name, and an action that needs a target must carry it in
 * the rule's own `payload`, which is the contract `add_role` already has for
 * naming its role.
 *
 * **The rule is re-read from the store rather than carried in the job.** A
 * schedule persisted in Redis outlives the row that justified it: a guild can
 * disable or delete a rule at any time and nothing removes the scheduler, so the
 * database stays the source of truth and a tick for a rule that is gone is a
 * no-op that says so.
 */
export async function fireCronRule(deps: CronTickDeps, job: CronTick): Promise<void> {
  const parsed = cronJobDataSchema.safeParse(job.data);
  if (!parsed.success) {
    // Reachable: a scheduler registered by an older build, whose data shape has
    // since changed. Throwing would retry it forever against the same bad data.
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

  // Switched off in the dashboard. Silent, because a disabled rule ticking is not
  // a fault and saying so on every tick would train people to ignore it.
  if (!rule.enabled) return;

  const dryRun = ruleIsDryRun(rule, deps.nodeEnv);
  const outcome = await deps.engine.fire(rule, {
    event: cronEvent(parsed.data, job, deps.now?.() ?? Date.now()),
    facts: {},
    dryRun,
  });

  logOutcome(deps.logger, outcome, {
    guildId,
    eventId: cronEventId(parsed.data, job),
    eventType: RULE_CRON_EVENT_TYPE,
    dryRun,
  });
}

/**
 * Runs the rules no event will ever trigger (`trigger.kind === 'cron'`).
 *
 * `upsertJobScheduler`, for the reason `startModuleJobs` gives: it is free leader
 * election. Several worker replicas can each register the same schedule and Redis
 * still produces one tick, which for a rule that bans or purges is not a nicety —
 * three replicas would otherwise each fire the ladder and the executor's dedupe
 * would only save us if all three derived the same idempotency key, which they
 * would not, because the tick is the only thing they share.
 *
 * Registration is per guild rather than per manifest, because a cron rule only
 * exists once a guild has a row for it, and the guild set is not known at boot.
 * `RulePresetSeeder` calls `register` after seeding, so a guild's schedules are
 * (re)established on every gateway reconnect.
 *
 * Nothing ever *removes* a scheduler. A rule a guild deletes leaves its schedule
 * behind, and the tick then no-ops with a line naming the leftover — a known,
 * bounded leak of one Redis key per deleted cron rule. Cleaning it up needs the
 * store to report what used to exist, which is a write-path concern; the tick
 * failing safe is what makes deferring it survivable.
 */
export class RuleCronScheduler implements RuleCronRegistrar {
  readonly #deps: RuleCronSchedulerDeps;
  readonly #queue: Queue;
  readonly #worker: Worker;

  constructor(deps: RuleCronSchedulerDeps) {
    this.#deps = deps;

    this.#queue = new Queue(RULE_CRON_QUEUE, {
      connection: deps.connection,
      // Bounded history, as `startModuleJobs` documents: BullMQ keeps completed
      // jobs forever by default, and a nightly rule in a thousand guilds would
      // accumulate a key per tick for the life of the deployment.
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
  }

  /** Register a scheduler for each of the guild's cron rules. Returns how many. */
  async register(guildId: string): Promise<number> {
    const schedules = cronSchedulesFor(guildId, await this.#deps.store.listCron(guildId));

    let scheduled = 0;
    for (const schedule of schedules) {
      try {
        await this.#queue.upsertJobScheduler(
          schedule.id,
          // `pattern`, not `every`: a rule trigger carries a cron expression, and
          // `timezone` is honoured when the rule sets one (UTC otherwise, per
          // `ruleTriggerSchema`).
          { pattern: schedule.pattern, ...(schedule.timezone ? { tz: schedule.timezone } : {}) },
          { name: schedule.id, data: schedule.data },
        );
        scheduled += 1;
      } catch (error) {
        // Per rule, so one unreadable cron expression does not cost the guild its
        // other schedules. The expression is in the message because it is what
        // has to be fixed and it is only visible in the dashboard.
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

/**
 * What a cron tick calls itself.
 *
 * Not a member of `EVENT_TYPES`, because a cron rule is not triggered by an event
 * — that is the definition of it. Chosen to be recognisably not a dispatch name
 * so a log line carrying it cannot be mistaken for one.
 */
export const RULE_CRON_EVENT_TYPE = 'rule.cron';

/**
 * Identity for one tick.
 *
 * Every idempotency key the engine builds is derived from `event.id`, so this
 * decides what "the same firing" means. BullMQ gives a scheduled job a
 * deterministic id that is stable across a retry of that job and different for
 * the next tick, which is exactly the property wanted: a tick that failed
 * downstream of the executor retries onto the same key and is deduped (I4), while
 * tomorrow's tick is a new action. `timestamp` is the fallback for a job with no
 * id, which is only a hand-enqueued one in a test.
 */
function cronEventId(data: CronJobData, job: Pick<CronTick, 'id' | 'timestamp'>): string {
  return `rule-cron:${cronSchedulerId(data)}:${job.id ?? job.timestamp}`;
}

function cronEvent(data: CronJobData, job: CronTick, now: number): ProtonEvent {
  return {
    id: cronEventId(data, job),
    /**
     * `ProtonEvent.type` is an `EventType` and there is no member for "a
     * schedule fired". The field is inert on this path — only `evaluate` reads
     * it, to match a trigger, and a cron rule reaches `fire` directly — so the
     * assertion widens a string into a slot nothing will read rather than
     * claiming this tick was a dispatch it was not. Adding the member would be a
     * `packages/core` change, and it would then have to be excluded from
     * `NORMALISED_EVENT_TYPES`, from the registry's emission assertion and from
     * every listener union, for a value no consumer can ever receive.
     */
    type: RULE_CRON_EVENT_TYPE as EventType,
    guildId: data.guildId,
    occurredAt: job.timestamp ?? now,
    payload: data,
  };
}
