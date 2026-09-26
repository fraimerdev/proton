import {
  type EventBus,
  JOINROLES_RUN_KINDS,
  type JoinrolesRunKind,
  type JoinrolesSyncRequested,
  newId,
  snowflakeSchema,
} from '@proton/core';
import { joinrolesConfigSchema } from '@proton/module-joinroles/config';
import { claimRun, type JoinRolesRunStore } from '@proton/module-joinroles/sync-store';
import {
  COUNT_COOLDOWN_MS,
  type JoinRolesSyncStatus,
  queuedRun,
  type SyncEstimate,
  type SyncRun,
  type SyncStartResult,
  syncFingerprint,
  syncRunView,
} from '@proton/module-joinroles/sync-view';
import { z } from 'zod';
import type { AuditWrite } from '../leveling/xp-events.ts';
import type { ModuleConfigService } from '../modules/service.ts';

const MODULE_ID = 'joinroles';

export type JoinRolesSyncErrorCode =
  | 'module_disabled'
  | 'nothing_to_sync'
  | 'no_redis'
  | 'no_bus'
  | 'counted_recently'
  | 'already_running'
  | 'not_started';

export class JoinRolesSyncError extends Error {
  readonly code: JoinRolesSyncErrorCode;
  readonly nextCountAt: number | null;

  constructor(code: JoinRolesSyncErrorCode, message: string, nextCountAt: number | null = null) {
    super(message);
    this.code = code;
    this.nextCountAt = nextCountAt;
    this.name = 'JoinRolesSyncError';
  }
}

export function joinrolesSyncUnavailable(): JoinRolesSyncError {
  return new JoinRolesSyncError(
    'no_redis',
    'Proton can’t start syncs or show their progress right now because part of its service is ' +
      'down, so nothing was started. Try again later.',
  );
}

function serviceDown(kind: JoinrolesRunKind, what: string): string {
  const action = kind === 'sync' ? 'start a sync' : 'count members';
  return `Proton can’t ${action} right now because part of its service is down, so ${what}. Try again later.`;
}

export const joinrolesSyncStartBodySchema = z.object({
  kind: z.enum(JOINROLES_RUN_KINDS),
  actorId: snowflakeSchema,
  source: z.literal('dashboard').default('dashboard'),
  ipHash: z.string().min(1).max(128).optional(),
});

export type JoinRolesSyncStartBody = z.infer<typeof joinrolesSyncStartBodySchema>;

export type StartJoinRolesSyncInput = JoinRolesSyncStartBody & { guildId: string };

export interface JoinRolesSyncServiceOptions {
  modules: Pick<ModuleConfigService, 'get'>;
  runs?: JoinRolesRunStore;
  bus?: EventBus;
  audit: AuditWrite;
  logger?: Pick<Console, 'error' | 'warn'>;
  now?(): number;
}

function nextCountAtOf(estimate: SyncEstimate | null, now: number): number | null {
  if (!estimate) return null;

  const next = estimate.countedAt + COUNT_COOLDOWN_MS;
  return next > now ? next : null;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function minutes(ms: number): string {
  const count = Math.max(1, Math.ceil(ms / 60_000));
  return count === 1 ? '1 minute' : `${count} minutes`;
}

function busy(kind: JoinrolesRunKind, current: SyncRun | null): JoinRolesSyncError {
  const message =
    current === null
      ? 'A sync or count was still running a moment ago. Try again.'
      : current.kind === 'count'
        ? kind === 'count'
          ? 'Proton is already counting the members missing a join role. The new count shows ' +
            'here when it finishes.'
          : 'Proton is counting the members missing a join role. You can sync when the count ' +
            'finishes.'
        : kind === 'count'
          ? 'A sync is running in this server, and it updates the count when it finishes.'
          : 'A sync is already running in this server. It carries on in the background, so ' +
            'wait for it to finish before starting another.';

  return new JoinRolesSyncError('already_running', message);
}

export class JoinRolesSyncService {
  readonly #modules: Pick<ModuleConfigService, 'get'>;
  readonly #runs: JoinRolesRunStore | undefined;
  readonly #bus: EventBus | undefined;
  readonly #audit: AuditWrite;
  readonly #logger: Pick<Console, 'error' | 'warn'>;
  readonly #now: () => number;

  constructor(options: JoinRolesSyncServiceOptions) {
    this.#modules = options.modules;
    this.#runs = options.runs;
    this.#bus = options.bus;
    this.#audit = options.audit;
    this.#logger = options.logger ?? console;
    this.#now = options.now ?? Date.now;
  }

  async #config(guildId: string) {
    const view = await this.#modules.get(guildId, MODULE_ID);
    const config = joinrolesConfigSchema.parse(view.config);

    return { on: view.enabled && config.enabled, config };
  }

  async status(guildId: string): Promise<JoinRolesSyncStatus> {
    const runs = this.#runs;
    if (!runs) throw joinrolesSyncUnavailable();

    const [{ config }, run, last, estimate] = await Promise.all([
      this.#config(guildId),
      runs.get(guildId),
      runs.last(guildId),
      runs.estimate(guildId),
    ]);

    const now = this.#now();

    return {
      run: run ? syncRunView(run) : null,
      last,
      estimate: estimate
        ? { ...estimate, stale: estimate.fingerprint !== syncFingerprint(config) }
        : null,
      nextCountAt: nextCountAtOf(estimate, now),
      now,
    };
  }

  async start(input: StartJoinRolesSyncInput): Promise<SyncStartResult> {
    const { guildId, kind } = input;
    const what = kind === 'sync' ? 'no sync was started' : 'nothing was counted';

    const { on, config } = await this.#config(guildId);

    if (!on) {
      throw new JoinRolesSyncError(
        'module_disabled',
        `Join Roles is off in this server, so ${what}. Turn it on first.`,
      );
    }

    if (config.memberRoleIds.length === 0 && config.botRoleIds.length === 0) {
      throw new JoinRolesSyncError(
        'nothing_to_sync',
        `No member or bot roles are set, so there is nothing to ${kind}. Choose them and save ` +
          'first.',
      );
    }

    const runs = this.#runs;
    if (!runs) throw joinrolesSyncUnavailable();

    const bus = this.#bus;
    if (!bus) {
      throw new JoinRolesSyncError('no_bus', serviceDown(kind, what));
    }

    const now = this.#now();

    if (kind === 'count') {
      const nextCountAt = nextCountAtOf(await runs.estimate(guildId), now);
      if (nextCountAt !== null) {
        throw new JoinRolesSyncError(
          'counted_recently',
          'Proton counted the members missing a join role less than 10 minutes ago. You can ' +
            `count again in ${minutes(nextCountAt - now)}.`,
          nextCountAt,
        );
      }
    }

    const runId = newId();
    const claim = await claimRun(
      runs,
      queuedRun({ runId, guildId, kind, trigger: 'dashboard', actorId: input.actorId, now }),
      now,
    );
    if (!claim.claimed) throw busy(kind, claim.current);

    if (claim.replaced) {
      this.#logger.warn(
        `a Join Roles ${claim.replaced.kind} ${claim.replaced.runId} in guild ${guildId} had ` +
          `reported no progress since ${new Date(claim.replaced.heartbeatAt).toISOString()}, so ` +
          `the ${kind} ${runId} asked for from the dashboard replaced it.`,
      );
    }

    const auditId = newId();
    const payload: JoinrolesSyncRequested = {
      auditId,
      guildId,
      runId,
      kind,
      actorId: input.actorId,
    };

    try {
      await this.#audit({
        id: auditId,
        guildId,
        actorId: input.actorId,
        source: input.source,
        action: kind === 'sync' ? 'module.joinroles.sync.start' : 'module.joinroles.sync.count',
        before: null,
        after: { runId, kind },
        ipHash: input.ipHash ?? null,
      });

      await bus.publish({
        id: `joinroles.sync_requested:${guildId}:${runId}`,
        type: 'joinroles.sync_requested',
        guildId,
        occurredAt: now,
        payload,
      });
    } catch (error) {
      await this.#release(runs, { guildId, runId, kind }, error);

      throw new JoinRolesSyncError('not_started', serviceDown(kind, what));
    }

    return { runId, kind };
  }

  async #release(
    runs: JoinRolesRunStore,
    run: Pick<SyncRun, 'guildId' | 'runId' | 'kind'>,
    cause: unknown,
  ): Promise<void> {
    this.#logger.error(
      `a Join Roles ${run.kind} was claimed for guild ${run.guildId} but could not be recorded ` +
        `or published, so it was not started: ${messageOf(cause)}`,
    );

    try {
      await runs.clear(run.guildId, run.runId);
    } catch (error) {
      this.#logger.error(
        `the unstarted Join Roles ${run.kind} ${run.runId} in guild ${run.guildId} could not be ` +
          `released, so new ones are refused until it expires in 24 hours: ${messageOf(error)}`,
      );
    }
  }
}
