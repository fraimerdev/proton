import {
  type ActionExecutor,
  type ActionResult,
  type GuildMemberLister,
  type GuildMemberSummary,
  highestRolePosition,
  isScopedActionExecutor,
  type MemberPageFailure,
  type MemberPageResult,
  type ModuleContext,
  permissionLabel,
  type ScheduledHandler,
  upstreamRefusal,
} from '@proton/core';
import { RESTJSONErrorCodes } from 'discord-api-types/v10';
import { z } from 'zod';
import type { JoinrolesConfig } from '../config.ts';
import { JOINROLES_ACTOR, JOINROLES_MODULE_ID, type JoinRolesDeps } from '../listeners.ts';
import { planMember, type SyncPlanInput, syncPlanInput } from './plan.ts';
import { MISSING_MANAGE_ROLES, NOTHING_TO_SYNC, preflightSync } from './preflight.ts';
import type { JoinRolesRunStore } from './store.ts';
import {
  type LastSync,
  type SkipReason,
  type SyncEstimate,
  type SyncFailure,
  type SyncOutcome,
  type SyncRun,
  syncFingerprint,
} from './view.ts';

export const JOINROLES_SYNC_JOB = 'joinroles.sync';

export function syncBatchKey(runId: string): string {
  return `joinroles:sync:${runId}`;
}

export const syncBatchDataSchema = z.object({ runId: z.string().min(1).max(64) });

export type SyncBatchData = z.infer<typeof syncBatchDataSchema>;

export const SYNC_PAGE = 1000;
export const SYNC_GRANTS_PER_TICK = 25;
export const SYNC_TICK_BUDGET_MS = 10_000;
export const SYNC_COUNT_PAGES_PER_TICK = 5;
export const SYNC_ATTEMPTS = 5;
export const SYNC_RETRY_BASE_MS = 15_000;

export const SYNC_FAILURES = {
  memberListRefused: {
    code: 'member_list_refused',
    message:
      "Discord wouldn't let Proton read the member list. This is a problem on Proton's side, not " +
      'a setting in this server.',
  },
  memberListUnavailable: {
    code: 'member_list_unavailable',
    message: "Discord didn't return the member list, so the sync stopped. Try again later.",
  },
  guildStateUnavailable: {
    code: 'guild_state_unavailable',
    message: "Proton couldn't load this server's roles, so the sync stopped. Try again later.",
  },
  discordUnavailable: {
    code: 'discord_unavailable',
    message: 'Discord kept failing to give roles, so the sync stopped. Try again later.',
  },
  noScheduler: {
    code: 'no_scheduler',
    message:
      "Proton couldn't schedule the rest of the sync. This is a problem on Proton's side, not a " +
      'setting in this server.',
  },
  switchedOff: { code: 'switched_off', message: 'Join Roles was turned off.' },
} as const satisfies Record<string, SyncFailure>;

const COUNT_FAILURE_MESSAGES: Readonly<Partial<Record<string, string>>> = {
  [SYNC_FAILURES.memberListUnavailable.code]:
    "Discord didn't return the member list, so the count stopped. Try again later.",
  [SYNC_FAILURES.guildStateUnavailable.code]:
    "Proton couldn't load this server's roles, so the count stopped. Try again later.",
  [SYNC_FAILURES.noScheduler.code]:
    "Proton couldn't schedule the rest of the count. This is a problem on Proton's side, not a " +
    'setting in this server.',
  [MISSING_MANAGE_ROLES.code]:
    `Proton is missing the ${permissionLabel('ManageRoles')} permission in this server. ` +
    "Turn it on for Proton's role in Server Settings → Roles, then count again.",
  [NOTHING_TO_SYNC.code]:
    'No member or bot roles are set, so there is nothing to count. Choose them and save first.',
};

export function failureFor(kind: SyncRun['kind'], failure: SyncFailure): SyncFailure {
  const message = kind === 'count' ? COUNT_FAILURE_MESSAGES[failure.code] : undefined;
  return message === undefined ? failure : { ...failure, message };
}

export function roleRefused(roleId: string | undefined): SyncFailure {
  return {
    code: 'role_refused',
    ...(roleId ? { roleId } : {}),
    message:
      "Discord refused to give one of the join roles, so the sync stopped. Proton's role may " +
      'have been moved below it.',
  };
}

export function syncGrantKey(
  guildId: string,
  runId: string,
  userId: string,
  roleId: string,
): string {
  return `joinroles:${guildId}:sync:${runId}:${userId}:${roleId}`;
}

export function roleMissing(roleId: string): SyncFailure {
  return {
    code: 'role_missing',
    roleId,
    message:
      `The join role with ID ${roleId} no longer exists, so the sync stopped there. Remove it ` +
      'from Member roles or Bot roles.',
  };
}

export function roleAboveProton(roleId: string): SyncFailure {
  return {
    code: 'role_above_proton',
    roleId,
    message:
      `The join role with ID ${roleId} is now at or above Proton's highest role, so the sync ` +
      "stopped there. Drag Proton's role above it in Server Settings → Roles.",
  };
}

type GrantVerdict =
  | 'granted'
  | 'outranks'
  | 'owner'
  | 'left'
  | 'failed'
  | 'transient'
  | 'unloaded'
  | 'forbidden'
  | 'no_permission'
  | 'role_missing';

function statusOf(code: string): number | null {
  const match = /^discord_(\d{3})$/.exec(code);
  return match ? Number(match[1]) : null;
}

export function grantVerdict(result: ActionResult): GrantVerdict {
  if (result.status === 'executed' || result.status === 'skipped_duplicate') return 'granted';

  const code = result.failure?.code ?? '';

  if (result.status === 'failed_precheck') {
    if (code === 'missing_permission') return 'no_permission';
    if (code === 'role_hierarchy') return 'outranks';
    if (code === 'target_is_owner') return 'owner';
    if (code === 'target_not_member') return 'left';
    if (code === 'guild_state_unavailable') return 'unloaded';
    return 'failed';
  }

  if (result.status !== 'failed_api') return 'failed';
  if (code === 'transport_failure') return 'transient';

  const discordCode = result.failure?.discordCode;
  if (discordCode === RESTJSONErrorCodes.UnknownRole) return 'role_missing';
  if (
    discordCode === RESTJSONErrorCodes.UnknownMember ||
    discordCode === RESTJSONErrorCodes.UnknownUser
  ) {
    return 'left';
  }

  const status = statusOf(code);
  if (status === null) return 'failed';

  if (upstreamRefusal(status) === 'forbidden') return 'forbidden';

  return status === 429 || status >= 500 ? 'transient' : 'failed';
}

async function roleProblem(batch: Batch, roleId: string): Promise<SyncFailure | 'unloaded' | null> {
  const state = await batch.deps.guildState?.get(batch.ctx.guildId);
  if (!state) return 'unloaded';

  const role = state.roles.get(roleId);
  if (!role) return roleMissing(roleId);

  return role.position >= highestRolePosition(state.roles, state.botRoleIds)
    ? roleAboveProton(roleId)
    : null;
}

interface Batch {
  ctx: ModuleContext<JoinrolesConfig>;
  deps: JoinRolesDeps;
  runs: JoinRolesRunStore;
  lister: GuildMemberLister;
  clock(): number;
}

function meta(run: SyncRun): Record<string, unknown> {
  return { guildId: run.guildId, moduleId: JOINROLES_MODULE_ID, runId: run.runId, kind: run.kind };
}

function failureMeta(run: SyncRun, failure: SyncFailure | null): Record<string, unknown> {
  return failure?.roleId === undefined ? meta(run) : { ...meta(run), roleId: failure.roleId };
}

function copy(run: SyncRun): SyncRun {
  return { ...run, skipped: { ...run.skipped }, blockedRoles: [...run.blockedRoles] };
}

function stillMissing(run: SyncRun): number {
  const { pending, outranks, owner, failed } = run.skipped;
  return pending + outranks + owner + failed;
}

function estimateOf(
  run: SyncRun,
  config: JoinrolesConfig,
  now: number,
  failure: SyncFailure | null,
): SyncEstimate {
  return {
    missing: run.kind === 'sync' ? stillMissing(run) : run.missing,
    pending: run.skipped.pending,
    scanned: run.processed,
    countedAt: now,
    source: run.kind,
    fingerprint: syncFingerprint(config),
    failure,
  };
}

export async function finishRun(
  ctx: ModuleContext<JoinrolesConfig>,
  runs: JoinRolesRunStore,
  run: SyncRun,
  outcome: SyncOutcome,
  reason: SyncFailure | null,
  now: number,
): Promise<boolean> {
  const failure = reason === null ? null : failureFor(run.kind, reason);

  const last: LastSync | undefined =
    run.kind === 'sync'
      ? {
          runId: run.runId,
          trigger: run.trigger,
          outcome,
          failure,
          processed: run.processed,
          updated: run.updated,
          skipped: run.skipped,
          blockedRoles: run.blockedRoles,
          startedAt: run.startedAt ?? run.queuedAt,
          finishedAt: now,
        }
      : undefined;

  const estimate =
    outcome === 'done' || (run.kind === 'count' && outcome === 'failed')
      ? estimateOf(run, ctx.config, now, failure)
      : undefined;

  const finished = await runs.finish(run.guildId, run.runId, {
    ...(last ? { last } : {}),
    ...(estimate ? { estimate } : {}),
  });

  if (finished) {
    const line =
      `Join Roles ${run.kind} ${outcome}: ${run.processed} members checked, ${run.updated} ` +
      `updated${failure ? ` — ${failure.message}` : ''}`;

    if (outcome === 'failed') ctx.logger.warn(line, failureMeta(run, failure));
    else ctx.logger.info(line, failureMeta(run, failure));
  }

  return finished;
}

async function advance(batch: Batch, run: SyncRun): Promise<void> {
  const { ctx, runs } = batch;
  const now = batch.clock();

  if (!ctx.schedule) {
    await finishRun(ctx, runs, run, 'failed', SYNC_FAILURES.noScheduler, now);
    return;
  }

  if (!(await runs.putIfCurrent({ ...run, heartbeatAt: now }))) return;

  await bookNext(ctx, run, now);
}

async function bookNext(
  ctx: ModuleContext<JoinrolesConfig>,
  run: SyncRun,
  at: number,
): Promise<void> {
  const data: SyncBatchData = { runId: run.runId };

  await ctx.schedule?.(JOINROLES_SYNC_JOB, new Date(at), syncBatchKey(run.runId), data, {
    replace: true,
  });
}

async function retry(
  batch: Batch,
  run: SyncRun,
  failure: SyncFailure,
  progressed: boolean,
): Promise<void> {
  const { ctx, runs } = batch;
  const now = batch.clock();
  const failures = (progressed ? 0 : run.failures) + 1;

  if (!ctx.schedule) {
    await finishRun(ctx, runs, run, 'failed', SYNC_FAILURES.noScheduler, now);
    return;
  }

  if (failures >= SYNC_ATTEMPTS) {
    await finishRun(ctx, runs, run, 'failed', failure, now);
    return;
  }

  if (!(await runs.putIfCurrent({ ...run, failures, heartbeatAt: now }))) return;

  ctx.logger.warn(
    `a Join Roles ${run.kind} could not continue (attempt ${failures} of ${SYNC_ATTEMPTS}): ` +
      failure.message,
    failureMeta(run, failure),
  );

  await bookNext(ctx, run, now + SYNC_RETRY_BASE_MS * 2 ** failures);
}

async function listPage(batch: Batch, after: string): Promise<MemberPageResult> {
  try {
    return await batch.lister.list(batch.ctx.guildId, after, SYNC_PAGE);
  } catch (error) {
    return {
      retryable: true,
      failure: `the member list could not be read: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
}

async function listFailed(
  batch: Batch,
  run: SyncRun,
  page: MemberPageFailure,
  progressed: boolean,
): Promise<void> {
  batch.ctx.logger.warn(`a Join Roles ${run.kind} could not list members: ${page.failure}`, {
    ...meta(run),
    retryable: page.retryable,
  });

  if (!page.retryable) {
    await finishRun(
      batch.ctx,
      batch.runs,
      run,
      'failed',
      SYNC_FAILURES.memberListRefused,
      batch.clock(),
    );
    return;
  }

  await retry(batch, run, SYNC_FAILURES.memberListUnavailable, progressed);
}

function rankedBy(executor: ActionExecutor, roleIds: string[]): ActionExecutor {
  return isScopedActionExecutor(executor) ? executor.scoped({ targetRoleIds: roleIds }) : executor;
}

type MemberOutcome =
  | {
      verdict: Exclude<GrantVerdict, 'granted' | 'role_missing'> | 'updated';
      attempts: number;
      roleId?: string;
    }
  | { verdict: 'role_blocked'; attempts: number; failure: SyncFailure };

async function grantMember(
  batch: Batch,
  run: SyncRun,
  member: GuildMemberSummary,
  roleIds: readonly string[],
): Promise<MemberOutcome> {
  const { ctx } = batch;
  const executor = rankedBy(ctx.executor, member.roleIds);
  let attempts = 0;
  let partial = false;

  for (const roleId of roleIds) {
    attempts += 1;

    const result = await executor.execute({
      guildId: ctx.guildId,
      moduleId: JOINROLES_MODULE_ID,
      kind: 'add_role',
      actorId: JOINROLES_ACTOR,
      targetId: member.userId,
      reason: `Join Roles sync (${run.trigger === 'schedule' ? 'scheduled' : 'dashboard'})`,
      payload: { userId: member.userId, roleId },
      dryRun: false,
      record: false,
      idempotencyKey: syncGrantKey(ctx.guildId, run.runId, member.userId, roleId),
    });

    const verdict = grantVerdict(result);
    if (verdict === 'granted') continue;

    if (verdict === 'role_missing') {
      return { verdict: 'role_blocked', attempts, failure: roleMissing(roleId) };
    }

    if (verdict === 'outranks') {
      const problem = await roleProblem(batch, roleId);
      if (problem === 'unloaded') return { verdict: 'unloaded', attempts, roleId };
      if (problem) return { verdict: 'role_blocked', attempts, failure: problem };
    }

    if (verdict === 'failed') {
      partial = true;
      ctx.logger.warn(
        `a Join Roles sync could not give role ${roleId} to ${member.userId}: ${
          result.failure?.humanReason ?? 'unknown reason'
        }`,
        { ...meta(run), userId: member.userId, roleId, code: result.failure?.code },
      );
      continue;
    }

    return { verdict, attempts, roleId };
  }

  return { verdict: partial ? 'failed' : 'updated', attempts };
}

function byId(a: GuildMemberSummary, b: GuildMemberSummary): number {
  const left = BigInt(a.userId);
  const right = BigInt(b.userId);
  return left < right ? -1 : left > right ? 1 : 0;
}

async function syncPage(batch: Batch, run: SyncRun, input: SyncPlanInput): Promise<void> {
  const { ctx, deps } = batch;

  const page = await listPage(batch, run.after);
  if ('failure' in page) {
    await listFailed(batch, run, page, false);
    return;
  }

  // Timed from here, not the top: a slow member list would spend the budget before any member.
  const deadline = batch.clock() + SYNC_TICK_BUDGET_MS;
  const next = copy(run);
  let attempts = 0;
  let progressed = false;
  let halted = false;
  let fatal: SyncFailure | null = null;
  let retryable: SyncFailure | null = null;

  for (const member of [...page.members].sort(byId)) {
    if (progressed && (attempts >= SYNC_GRANTS_PER_TICK || batch.clock() >= deadline)) {
      halted = true;
      break;
    }

    const plan = planMember(member, input);

    if (plan.kind === 'grant') {
      const outcome = await grantMember(batch, run, member, plan.roleIds);
      attempts += outcome.attempts;

      if (outcome.verdict === 'role_blocked') {
        retryable = outcome.failure;
        break;
      }
      if (outcome.verdict === 'transient' || outcome.verdict === 'unloaded') {
        retryable =
          outcome.verdict === 'unloaded'
            ? SYNC_FAILURES.guildStateUnavailable
            : SYNC_FAILURES.discordUnavailable;
        break;
      }
      if (outcome.verdict === 'forbidden') {
        fatal = roleRefused(outcome.roleId);
        break;
      }
      if (outcome.verdict === 'no_permission') {
        fatal = MISSING_MANAGE_ROLES;
        break;
      }

      next.missing += 1;
      if (outcome.verdict === 'updated') next.updated += 1;
      else next.skipped[outcome.verdict satisfies SkipReason] += 1;
    } else if (plan.kind === 'pending') {
      await deps.pending?.mark(ctx.guildId, member.userId);
      next.missing += 1;
      next.skipped.pending += 1;
    } else if (plan.kind === 'excluded') {
      next.skipped.excluded += 1;
    }

    if (plan.kind !== 'self') next.processed += 1;
    next.after = member.userId;
    progressed = true;
  }

  if (fatal) {
    await finishRun(ctx, batch.runs, next, 'failed', fatal, batch.clock());
    return;
  }

  if (retryable) {
    await retry(batch, next, retryable, progressed);
    return;
  }

  if (!halted) {
    if (page.next === null) {
      await finishRun(ctx, batch.runs, next, 'done', null, batch.clock());
      return;
    }
    next.after = page.next;
  }

  await advance(batch, { ...next, failures: 0 });
}

async function countPages(batch: Batch, run: SyncRun, input: SyncPlanInput): Promise<void> {
  const deadline = batch.clock() + SYNC_TICK_BUDGET_MS;
  const next = copy(run);
  let progressed = false;

  for (let pages = 0; pages < SYNC_COUNT_PAGES_PER_TICK; pages += 1) {
    const page = await listPage(batch, next.after);
    if ('failure' in page) {
      await listFailed(batch, next, page, progressed);
      return;
    }

    for (const member of page.members) {
      const plan = planMember(member, input);
      if (plan.kind === 'self') continue;

      next.processed += 1;
      if (plan.kind === 'excluded') next.skipped.excluded += 1;
      if (plan.kind === 'pending') next.skipped.pending += 1;
      if (plan.kind === 'pending' || plan.kind === 'grant') next.missing += 1;
    }

    progressed = true;

    if (page.next === null) {
      await finishRun(batch.ctx, batch.runs, next, 'done', null, batch.clock());
      return;
    }

    next.after = page.next;
    if (batch.clock() >= deadline) break;
  }

  await advance(batch, { ...next, failures: 0 });
}

export function createSyncBatchHandler(deps: JoinRolesDeps): ScheduledHandler<JoinrolesConfig> {
  return async (data, ctx) => {
    const { runs, members: lister } = deps;

    if (!runs || !lister) {
      ctx.logger.error(
        'a Join Roles sync batch was scheduled but this deployment has no member lister or run ' +
          'store wired into the module, so it cannot continue and has been dropped.',
        { guildId: ctx.guildId, moduleId: JOINROLES_MODULE_ID },
      );
      return;
    }

    const batch: Batch = { ctx, deps, runs, lister, clock: () => deps.now?.() ?? Date.now() };

    const run = await runs.get(ctx.guildId);
    if (!run) return;

    const booked = syncBatchDataSchema.safeParse(data);
    if (booked.success && booked.data.runId !== run.runId) return;

    if (!ctx.schedule) {
      await finishRun(ctx, runs, run, 'failed', SYNC_FAILURES.noScheduler, batch.clock());
      return;
    }

    const state = (await deps.guildState?.get(ctx.guildId)) ?? null;
    if (!state) {
      await retry(batch, run, SYNC_FAILURES.guildStateUnavailable, false);
      return;
    }

    const preflight = preflightSync(state, ctx.config, deps.botUserId ?? '');
    const checked: SyncRun = { ...run, blockedRoles: preflight.blockedRoles };

    if (!preflight.ok) {
      await finishRun(ctx, runs, checked, 'failed', preflight.failure, batch.clock());
      return;
    }

    const started: SyncRun =
      checked.state === 'queued'
        ? {
            ...checked,
            state: 'running',
            startedAt: batch.clock(),
            ...(state.memberCount !== undefined ? { total: state.memberCount } : {}),
          }
        : checked;

    const input = syncPlanInput(ctx.config, preflight, {
      botUserId: deps.botUserId,
      canHold: deps.pending !== undefined,
    });

    if (started.kind === 'count') await countPages(batch, started, input);
    else await syncPage(batch, started, input);
  };
}
