import type { ModuleContext } from '@proton/core';
import type { ModerationConfig } from '../config.ts';
import type { ModerationDeps } from '../deps.ts';
import { MODULE_ID } from '../perform.ts';
import { TIMEOUT_CAP_MS } from './config.ts';
import type { TimeoutRow } from './store.ts';

type Ctx = ModuleContext<ModerationConfig>;

export const TIMEOUT_JOB = 'moderation.timeout';

export const TIMEOUT_SAFETY_MS = 5 * 60_000;

export const APPLY_CAP_MS = TIMEOUT_CAP_MS - TIMEOUT_SAFETY_MS;

export const RENEW_LEAD_MS = 60 * 60_000;

export const TIMEOUT_SLACK_MS = 5_000;

export function appliedUntilOf(rows: readonly Pick<TimeoutRow, 'appliedUntil'>[]): number | null {
  const applied = rows.flatMap((row) => (row.appliedUntil === null ? [] : [row.appliedUntil]));
  return applied.length === 0 ? null : Math.max(...applied);
}

export function removedInDiscord(
  timeoutUntil: number | null,
  appliedUntil: number | null,
  now: number,
): boolean {
  if (appliedUntil === null || now >= appliedUntil) return false;
  // Discord can store the until a moment off what Proton sent; that is still Proton's timeout.
  return timeoutUntil === null || timeoutUntil < appliedUntil - TIMEOUT_SLACK_MS;
}

export async function closeRemovedInDiscord(
  ctx: Ctx,
  deps: ModerationDeps,
  userId: string,
  by: string | null,
  now: number,
): Promise<TimeoutRow[]> {
  const closed =
    (await deps.timeouts?.closeOpen(ctx.guildId, userId, {
      at: new Date(now),
      by,
      reason: 'removed_in_discord',
    })) ?? [];

  if (closed.length > 0) {
    ctx.logger.info(
      `moderation stopped tracking the timeout of ${userId}: it was removed in Discord, and ` +
        'Proton never reapplies a timeout someone took off by hand.',
      { guildId: ctx.guildId, moduleId: MODULE_ID, userId },
    );
  }

  return closed;
}

export function effectiveEnd(
  rows: readonly Pick<TimeoutRow, 'endsAt'>[],
  extra?: number,
): number | null {
  const ends = rows.map((row) => row.endsAt);
  if (extra !== undefined) ends.push(extra);
  return ends.length === 0 ? null : Math.max(...ends);
}

export function clampUntil(end: number, now: number): number {
  return Math.min(end, now + APPLY_CAP_MS);
}

export function nextRunAt(
  rows: readonly Pick<TimeoutRow, 'endsAt'>[],
  appliedUntil: number | null,
  now: number,
): number | null {
  if (rows.length === 0) return null;

  const firstEnd = Math.min(...rows.map((row) => row.endsAt));
  const lastEnd = effectiveEnd(rows) ?? firstEnd;

  const renewAt =
    appliedUntil !== null && lastEnd > appliedUntil ? appliedUntil - RENEW_LEAD_MS : null;

  return Math.max(now, renewAt === null ? firstEnd : Math.min(firstEnd, renewAt));
}

export async function scheduleTimeoutJob(
  ctx: Ctx,
  userId: string,
  runAt: number,
): Promise<boolean> {
  if (!ctx.schedule) {
    ctx.logger.error(
      `moderation could not book the timeout check for ${userId}: this context cannot schedule jobs.`,
      { guildId: ctx.guildId, moduleId: MODULE_ID, userId },
    );
    return false;
  }

  const outcome = await ctx.schedule(
    TIMEOUT_JOB,
    new Date(runAt),
    userId,
    { userId },
    {
      replace: true,
    },
  );
  return outcome.scheduled;
}

export async function planTimeoutUntil(
  ctx: Ctx,
  deps: ModerationDeps,
  input: {
    userId: string;
    endsAt: number;
    allowMultiple: boolean;
    timeoutUntil: number | null;
    now: number;
  },
): Promise<number> {
  const { now } = input;
  let open = deps.timeouts ? await deps.timeouts.open(ctx.guildId, input.userId) : [];

  if (open.length > 0 && removedInDiscord(input.timeoutUntil, appliedUntilOf(open), now)) {
    await closeRemovedInDiscord(ctx, deps, input.userId, null, now);
    open = [];
  }

  if (!input.allowMultiple) return clampUntil(input.endsAt, now);

  const current = input.timeoutUntil !== null && input.timeoutUntil > now ? input.timeoutUntil : 0;
  return clampUntil(Math.max(effectiveEnd(open, input.endsAt) ?? input.endsAt, current), now);
}

export interface AppliedTimeout {
  recorded: boolean;
  superseded: string[];
  scheduledAt: number | null;
}

export async function applyTimeout(
  ctx: Ctx,
  deps: ModerationDeps,
  input: {
    caseId: string;
    userId: string;
    actorId: string;
    endsAt: number;
    appliedUntil: number;
    allowMultiple: boolean;
    now: number;
  },
): Promise<AppliedTimeout> {
  const store = deps.timeouts;
  if (!store) {
    ctx.logger.error(
      `moderation timed out ${input.userId} but cannot track it: no timeout store is bound, so ` +
        'it will not be extended or logged when it ends.',
      { guildId: ctx.guildId, moduleId: MODULE_ID, userId: input.userId },
    );
    return { recorded: false, superseded: [], scheduledAt: null };
  }

  const recorded = await store.record({
    caseId: input.caseId,
    guildId: ctx.guildId,
    userId: input.userId,
    startedAt: new Date(input.now),
    endsAt: new Date(input.endsAt),
    appliedUntil: new Date(input.appliedUntil),
  });

  const superseded = input.allowMultiple
    ? []
    : await store.closeOpen(
        ctx.guildId,
        input.userId,
        { at: new Date(input.now), by: input.actorId, reason: 'superseded' },
        { except: input.caseId },
      );

  await store.setAppliedUntil(ctx.guildId, input.userId, new Date(input.appliedUntil));

  const open = await store.open(ctx.guildId, input.userId);
  const runAt = nextRunAt(open, input.appliedUntil, input.now);
  const scheduled = runAt === null ? false : await scheduleTimeoutJob(ctx, input.userId, runAt);

  return {
    recorded,
    superseded: superseded.map((row) => row.caseId),
    scheduledAt: scheduled ? runAt : null,
  };
}
