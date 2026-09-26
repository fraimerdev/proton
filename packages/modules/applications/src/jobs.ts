import type { ModuleContext, ScheduledHandler } from '@proton/core';
import { type ApplicationsConfig, formFor, reviewChannelFor } from './config.ts';
import { APPLICATIONS_ACTOR, MODULE_ID, PATROL_IDLE_MS } from './constants.ts';
import {
  type ApplicationsDeps,
  type BoundApplicationsDeps,
  bindApplicationsDeps,
  describeUnbound,
} from './deps.ts';
import { planEffects, planReminder } from './effects.ts';
import { armSweep, pausedWorkDueAt, runApplicationWork, runEffects } from './runner.ts';
import { type ApplicationRecord, type ApplicationStore, SWEEP_JOB } from './store.ts';
import { DAY_MS } from './web.ts';

type Ctx = ModuleContext<ApplicationsConfig>;

export const APPLICATION_SCHEDULES = [SWEEP_JOB] as const;
export type ApplicationSchedule = (typeof APPLICATION_SCHEDULES)[number];

export const PURGE_JOB = 'purge';
export const PURGE_CRON = '15 * * * *';
export const PURGE_BATCH = 500;
export const PURGE_ROUNDS = 40;

export const SWEEP_BATCH = 50;
export const PAUSED_SWEEP_BATCH = 500;
export const PAUSED_LOOKAHEAD_MS = 60 * 60_000;
export const SWEEP_RETRY_MS = 60_000;

const REVIEW_DUE: readonly ApplicationRecord['status'][] = ['submitted', 'in_review'];

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function remind(
  ctx: Ctx,
  deps: BoundApplicationsDeps,
  application: ApplicationRecord,
): Promise<boolean> {
  const form = formFor(ctx.config, application.formId) ?? null;
  const now = deps.now();
  const posting =
    ctx.config.reviewReminderHours > 0 &&
    form !== null &&
    reviewChannelFor(ctx.config, form) !== undefined;

  const result = await deps.store.transition({
    guildId: ctx.guildId,
    applicationId: application.id,
    action: 'reminded',
    actor: { id: APPLICATIONS_ACTOR, source: 'system' },
    expect: { statuses: REVIEW_DUE, revision: application.revision },
    patch: { remindedAt: now },
    event: {
      kind: posting ? 'reminded' : 'review_overdue',
      id: `${application.id}:reminded:${application.revision}`,
      data: { sent: posting },
    },
    plan:
      posting && form !== null
        ? (next, revision) =>
            planReminder({ config: ctx.config, form, application: next, revision, now })
        : undefined,
    bumpRevision: false,
    now,
  });

  return result.status === 'done' && result.effects.length > 0;
}

async function expire(
  ctx: Ctx,
  deps: BoundApplicationsDeps,
  application: ApplicationRecord,
): Promise<boolean> {
  const form = formFor(ctx.config, application.formId) ?? null;
  const now = deps.now();

  const result = await deps.store.transition({
    guildId: ctx.guildId,
    applicationId: application.id,
    action: 'expire_info',
    actor: { id: APPLICATIONS_ACTOR, source: 'system' },
    expect: { statuses: ['needs_info'], revision: application.revision },
    patch: { status: 'expired', contentPurgeAt: now + ctx.config.retentionDays * DAY_MS },
    event: {
      kind: 'expired',
      lifecycle: 'applications.expired',
      data: { reason: 'info_deadline' },
    },
    plan:
      form === null
        ? undefined
        : (next, revision) =>
            planEffects('applications.expired', {
              config: ctx.config,
              form,
              application: next,
              revision,
              now,
              actorId: APPLICATIONS_ACTOR,
            }),
    now,
  });

  return result.status === 'done' && result.effects.length > 0;
}

async function sweepOn(ctx: Ctx, deps: BoundApplicationsDeps): Promise<number | null> {
  const { store, now } = deps;
  const work = await store.dueWork(ctx.guildId, now(), SWEEP_BATCH);
  await runEffects(ctx, deps, work.effects);

  let planned = false;
  for (const application of work.reminders) {
    planned = (await remind(ctx, deps, application)) || planned;
  }
  for (const application of work.infoExpiries) {
    planned = (await expire(ctx, deps, application)) || planned;
  }
  if (planned) await runApplicationWork(ctx, deps);

  const after = now();
  const later = await store.dueWork(ctx.guildId, after, 0);
  const full = [work.effects, work.reminders, work.infoExpiries].some(
    (list) => list.length >= SWEEP_BATCH,
  );

  if (full) return after;
  return later.nextDueAt === null
    ? null
    : Math.min(Math.max(later.nextDueAt, after), after + PATROL_IDLE_MS);
}

// Paused work keeps a nextDueAt in the past, so only what may run while off books the next patrol.
async function sweepOff(ctx: Ctx, deps: BoundApplicationsDeps): Promise<number | null> {
  const { store, now } = deps;
  const work = await store.dueWork(ctx.guildId, now(), PAUSED_SWEEP_BATCH);
  const ran = await runEffects(ctx, deps, work.effects);

  const after = now();
  if (ran > 0 && work.effects.length >= PAUSED_SWEEP_BATCH) return after;

  const ahead = await store.dueWork(ctx.guildId, after + PAUSED_LOOKAHEAD_MS, PAUSED_SWEEP_BATCH);
  const due = await pausedWorkDueAt(ctx, deps, ahead.effects);
  return due === null ? null : Math.max(due, after);
}

export async function runSweep(deps: ApplicationsDeps, ctx: Ctx): Promise<void> {
  const bound = bindApplicationsDeps(deps);
  if ('unbound' in bound) {
    ctx.logger.error(describeUnbound('the applications sweep did not run', bound.unbound), {
      guildId: ctx.guildId,
      moduleId: MODULE_ID,
    });
    return;
  }
  const { now } = bound.deps;

  let next: number | null;
  try {
    next = ctx.config.enabled ? await sweepOn(ctx, bound.deps) : await sweepOff(ctx, bound.deps);
  } catch (error) {
    ctx.logger.error(
      `applications’ sweep hit a problem and runs again in a minute: ${reasonOf(error)}`,
      { guildId: ctx.guildId, moduleId: MODULE_ID },
    );
    next = now() + SWEEP_RETRY_MS;
  }

  if (next !== null) await armSweep(ctx, next);
}

export function createScheduledHandlers(
  deps: ApplicationsDeps,
): Record<ApplicationSchedule, ScheduledHandler<ApplicationsConfig>> {
  return {
    [SWEEP_JOB]: (_data, ctx) => runSweep(deps, ctx),
  };
}

async function rounds(step: () => Promise<number>): Promise<number> {
  let total = 0;
  for (let round = 0; round < PURGE_ROUNDS; round += 1) {
    const done = await step();
    total += done;
    if (done < PURGE_BATCH) break;
  }
  return total;
}

export async function purgeApplications(
  store: Pick<ApplicationStore, 'expireIdleDrafts' | 'purgeContent'>,
  now: Date,
): Promise<{ drafts: number; purged: number }> {
  const at = now.getTime();

  const drafts = await rounds(() => store.expireIdleDrafts(at, PURGE_BATCH));
  const purged = await rounds(() => store.purgeContent(at, PURGE_BATCH));

  return { drafts, purged };
}
