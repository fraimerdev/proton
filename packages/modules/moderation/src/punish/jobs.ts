import {
  isScopedActionExecutor,
  type ModerationPunishmentExpired,
  type ModuleContext,
  type ScheduledHandler,
  snowflakeSchema,
} from '@proton/core';
import { z } from 'zod';
import type { ModerationConfig } from '../config.ts';
import type { MemberLookup, ModerationDeps } from '../deps.ts';
import { MODULE_ID } from '../perform.ts';
import { sendPunishDm } from './dm.ts';
import type { TimeoutRow } from './store.ts';
import {
  appliedUntilOf,
  clampUntil,
  closeRemovedInDiscord,
  effectiveEnd,
  nextRunAt,
  RENEW_LEAD_MS,
  removedInDiscord,
  scheduleTimeoutJob,
  TIMEOUT_JOB,
  TIMEOUT_SLACK_MS,
} from './timeouts.ts';
import type { PunishActor } from './types.ts';

type Ctx = ModuleContext<ModerationConfig>;

export const PUNISH_ACTOR = 'proton:moderation';

export const PROTON_ACTOR: PunishActor = {
  id: PUNISH_ACTOR,
  roleIds: null,
  permissions: null,
  kind: 'automation',
  label: 'Proton',
};

export const ABSENT_RETRY_MS = 60 * 60_000;

export const EXPIRED_REASON = 'Timeout expired.';

const RENEW_AUDIT_REASON = "Renewing a timeout past Discord's 28-day limit.";
const REJOIN_AUDIT_REASON = 'Reapplying a timeout after the member left and rejoined.';

const TRANSIENT_CODES: ReadonlySet<string> = new Set([
  'transport_failure',
  'discord_429',
  'guild_state_unavailable',
  'target_state_unavailable',
]);

export const timeoutJobSchema = z.object({ userId: snowflakeSchema });

export function renewKey(guildId: string, userId: string, now: number): string {
  return `moderation:timeout:${guildId}:${userId}:renew:${Math.floor(now / 60_000)}`;
}

export function rejoinKey(guildId: string, userId: string, joinedAt: number): string {
  return `moderation:timeout:${guildId}:${userId}:rejoin:${joinedAt}`;
}

export function expiryRoot(guildId: string, caseId: string): string {
  return `moderation:timeout:${guildId}:${caseId}:expired`;
}

function transient(code: string): boolean {
  return TRANSIENT_CODES.has(code) || /^discord_5\d\d$/.test(code);
}

function nowOf(deps: ModerationDeps): number {
  return deps.now?.() ?? Date.now();
}

function meta(ctx: Ctx, userId: string): Record<string, unknown> {
  return { guildId: ctx.guildId, moduleId: MODULE_ID, userId };
}

export async function lookupTarget(
  deps: ModerationDeps,
  guildId: string,
  userId: string,
): Promise<MemberLookup | null> {
  if (!deps.lookupMember) return null;

  try {
    return await deps.lookupMember(guildId, userId);
  } catch {
    return { state: 'unavailable', status: 0 };
  }
}

export class MemberLookupUnavailableError extends Error {
  constructor(userId: string, status: number, doing: string) {
    super(
      `moderation could not look up ${userId} to ${doing} (${
        status > 0 ? `Discord answered ${status}` : 'Discord did not answer'
      }), so it will try again.`,
    );
    this.name = 'MemberLookupUnavailableError';
  }
}

export async function applyTimeoutUntil(
  ctx: Ctx,
  input: {
    userId: string;
    until: number;
    idempotencyKey: string;
    auditReason: string;
    roleIds?: string[];
  },
): Promise<boolean> {
  const executor =
    input.roleIds && isScopedActionExecutor(ctx.executor)
      ? ctx.executor.scoped({ targetRoleIds: input.roleIds })
      : ctx.executor;

  const result = await executor.execute({
    guildId: ctx.guildId,
    moduleId: MODULE_ID,
    kind: 'timeout',
    targetId: input.userId,
    actorId: PUNISH_ACTOR,
    auditReason: input.auditReason,
    payload: { userId: input.userId, until: new Date(input.until) },
    dryRun: false,
    idempotencyKey: input.idempotencyKey,
    record: false,
  });

  if (result.status === 'executed' || result.status === 'skipped_duplicate') return true;

  const code = result.failure?.code ?? result.status;
  const why = result.failure?.humanReason ?? 'Discord gave no reason.';
  if (transient(code)) {
    throw new Error(
      `moderation could not keep ${input.userId} timed out (${code}): ${why} It will try again.`,
    );
  }

  ctx.logger.warn(
    `moderation could not keep ${input.userId} timed out: ${why}`,
    meta(ctx, input.userId),
  );
  return false;
}

async function publishExpired(ctx: Ctx, row: TimeoutRow, memberPresent: boolean): Promise<void> {
  if (!ctx.publish) {
    ctx.logger.error(
      `moderation could not log that timeout ${row.caseId} ended: this context cannot publish events.`,
      meta(ctx, row.userId),
    );
    return;
  }

  const payload: ModerationPunishmentExpired = {
    guildId: ctx.guildId,
    caseId: row.caseId,
    kind: 'timeout',
    userId: row.userId,
    endedAt: row.endsAt,
    memberPresent,
  };

  await ctx.publish('moderation.punishment_expired', row.caseId, payload);
}

async function expire(
  ctx: Ctx,
  deps: ModerationDeps,
  input: {
    userId: string;
    ended: readonly TimeoutRow[];
    freed: boolean;
    now: number;
    presence: () => Promise<MemberLookup | null>;
  },
): Promise<void> {
  const store = deps.timeouts;
  if (!store) return;

  const punish = ctx.config.punish;
  const { userId, ended, now } = input;
  const unlogged = ended.filter((row) => row.expiryLoggedAt === null);
  const tells = input.freed && punish.notifications.onUnpunish;

  let found: MemberLookup | null = null;
  if (unlogged.length > 0 || tells) {
    found = await input.presence();
    if (found?.state === 'unavailable') {
      throw new MemberLookupUnavailableError(userId, found.status, 'log the end of their timeout');
    }
  }
  const present = found?.state !== 'absent';

  for (const row of unlogged) {
    if (present || punish.logExpiredWhenAbsent) await publishExpired(ctx, row, present);
    await store.markExpiryLogged(ctx.guildId, row.caseId, new Date(now));
  }

  const applied = appliedUntilOf(ended);
  const removedEarly =
    found?.state === 'member' &&
    applied !== null &&
    (found.timeoutUntil === null || found.timeoutUntil < applied - TIMEOUT_SLACK_MS);

  if (tells && present && removedEarly) {
    ctx.logger.info(
      `moderation did not tell ${userId} their timeout ended: it was removed early in Discord.`,
      meta(ctx, userId),
    );
  } else if (tells && present) {
    const last = ended.reduce((latest, row) => (row.endsAt > latest.endsAt ? row : latest));
    const told = await sendPunishDm(ctx, deps, {
      direction: 'untimeout',
      userId,
      root: expiryRoot(ctx.guildId, last.caseId),
      actor: PROTON_ACTOR,
      reason: EXPIRED_REASON,
      durationMs: last.endsAt - last.startedAt,
      expiresAt: last.endsAt,
      expired: true,
      caseId: last.caseId,
    });

    if (told.outcome !== 'sent') {
      ctx.logger.info(
        `moderation could not tell ${userId} their timeout ended (${told.outcome}).`,
        meta(ctx, userId),
      );
    }
  }

  await store.close(
    ctx.guildId,
    ended.map((row) => row.caseId),
    { at: new Date(now), by: null, reason: 'expired' },
  );
}

export type TimeoutCheck =
  | 'untracked'
  | 'nothing_open'
  | 'ended'
  | 'waiting'
  | 'renewed'
  | 'already'
  | 'renew_failed'
  | 'absent'
  | 'removed_in_discord'
  | 'lookup_unbound';

async function retryLater(
  ctx: Ctx,
  userId: string,
  remaining: readonly TimeoutRow[],
  now: number,
): Promise<void> {
  const firstEnd = Math.min(...remaining.map((row) => row.endsAt));
  await scheduleTimeoutJob(ctx, userId, Math.min(now + ABSENT_RETRY_MS, firstEnd));
}

export async function runTimeoutCheck(
  ctx: Ctx,
  deps: ModerationDeps,
  userId: string,
): Promise<TimeoutCheck> {
  const store = deps.timeouts;
  if (!store) {
    ctx.logger.error(
      `moderation could not check the timeout of ${userId}: no timeout store is bound here.`,
      meta(ctx, userId),
    );
    return 'untracked';
  }

  const now = nowOf(deps);
  const rows = await store.open(ctx.guildId, userId);
  if (rows.length === 0) return 'nothing_open';

  let looked: MemberLookup | null | undefined;
  const presence = async (): Promise<MemberLookup | null> => {
    if (looked === undefined) looked = await lookupTarget(deps, ctx.guildId, userId);
    return looked;
  };

  const ended = rows.filter((row) => row.endsAt <= now);
  const remaining = rows.filter((row) => row.endsAt > now);

  if (ended.length > 0) {
    await expire(ctx, deps, { userId, ended, freed: remaining.length === 0, now, presence });
  }
  if (remaining.length === 0) return 'ended';

  const applied = appliedUntilOf(remaining);
  const end = effectiveEnd(remaining) ?? now;
  const renewalDue = applied === null || (end > applied && now >= applied - RENEW_LEAD_MS);

  if (!renewalDue) {
    const runAt = nextRunAt(remaining, applied, now);
    if (runAt !== null) await scheduleTimeoutJob(ctx, userId, runAt);
    return 'waiting';
  }

  const member = await presence();
  if (member === null) {
    ctx.logger.error(
      `moderation could not renew the timeout of ${userId}: it cannot look up members here, ` +
        'so it cannot tell whether someone removed the timeout by hand.',
      meta(ctx, userId),
    );
    await retryLater(ctx, userId, remaining, now);
    return 'lookup_unbound';
  }

  if (member.state === 'unavailable') {
    throw new MemberLookupUnavailableError(userId, member.status, 'renew their timeout');
  }

  if (member.state === 'absent') {
    await retryLater(ctx, userId, remaining, now);
    return 'absent';
  }

  if (removedInDiscord(member.timeoutUntil, applied, now)) {
    await closeRemovedInDiscord(ctx, deps, userId, null, now);
    return 'removed_in_discord';
  }

  const until = clampUntil(end, now);

  if (member.timeoutUntil !== null && member.timeoutUntil >= until - TIMEOUT_SLACK_MS) {
    const effective = Math.max(until, member.timeoutUntil);
    await store.setAppliedUntil(ctx.guildId, userId, new Date(effective));
    const runAt = nextRunAt(remaining, effective, now);
    if (runAt !== null) await scheduleTimeoutJob(ctx, userId, runAt);
    return 'already';
  }

  const renewed = await applyTimeoutUntil(ctx, {
    userId,
    until,
    idempotencyKey: renewKey(ctx.guildId, userId, now),
    auditReason: RENEW_AUDIT_REASON,
    roleIds: member.roleIds,
  });

  if (!renewed) {
    await retryLater(ctx, userId, remaining, now);
    return 'renew_failed';
  }

  await store.setAppliedUntil(ctx.guildId, userId, new Date(until));
  const runAt = nextRunAt(remaining, until, now);
  if (runAt !== null) await scheduleTimeoutJob(ctx, userId, runAt);
  return 'renewed';
}

export async function rearmTimeouts(ctx: Ctx, deps: ModerationDeps): Promise<number> {
  const store = deps.timeouts;
  if (!store) return 0;

  const now = nowOf(deps);
  let armed = 0;

  for (const userId of await store.openUsers(ctx.guildId)) {
    const rows = await store.open(ctx.guildId, userId);
    const runAt = nextRunAt(rows, appliedUntilOf(rows), now);
    if (runAt !== null && (await scheduleTimeoutJob(ctx, userId, runAt))) armed += 1;
  }

  return armed;
}

export type RejoinOutcome =
  | 'none'
  | 'applied'
  | 'already'
  | 'removed_in_discord'
  | 'absent'
  | 'failed'
  | 'lookup_unbound';

export async function reapplyOnRejoin(
  ctx: Ctx,
  deps: ModerationDeps,
  input: { userId: string; joinedAt: number },
): Promise<RejoinOutcome> {
  const store = deps.timeouts;
  if (!store) return 'none';

  const { userId } = input;
  const now = nowOf(deps);
  const rows = await store.open(ctx.guildId, userId);
  const future = rows.filter((row) => row.endsAt > now);

  if (future.length === 0) {
    const runAt = nextRunAt(rows, appliedUntilOf(rows), now);
    if (runAt !== null) await scheduleTimeoutJob(ctx, userId, runAt);
    return 'none';
  }

  const member = await lookupTarget(deps, ctx.guildId, userId);
  if (member === null) {
    ctx.logger.error(
      `moderation could not reapply the timeout of ${userId} after they rejoined: it cannot look ` +
        'up members here.',
      meta(ctx, userId),
    );
    return 'lookup_unbound';
  }
  if (member.state === 'unavailable') {
    throw new MemberLookupUnavailableError(userId, member.status, 'reapply their timeout');
  }
  if (member.state === 'absent') return 'absent';

  const applied = appliedUntilOf(rows);
  if (removedInDiscord(member.timeoutUntil, applied, now)) {
    await closeRemovedInDiscord(ctx, deps, userId, null, now);
    await ctx.cancel?.(TIMEOUT_JOB, userId);
    return 'removed_in_discord';
  }

  const until = clampUntil(effectiveEnd(future) ?? now, now);
  let outcome: 'applied' | 'already' | 'failed' = 'already';

  if (member.timeoutUntil === null || member.timeoutUntil < until - TIMEOUT_SLACK_MS) {
    const done = await applyTimeoutUntil(ctx, {
      userId,
      until,
      idempotencyKey: rejoinKey(ctx.guildId, userId, input.joinedAt),
      auditReason: REJOIN_AUDIT_REASON,
      roleIds: member.roleIds,
    });
    outcome = done ? 'applied' : 'failed';
  }

  let effective = applied;
  if (outcome !== 'failed') {
    effective = Math.max(until, member.timeoutUntil ?? 0);
    await store.setAppliedUntil(ctx.guildId, userId, new Date(effective));
  }

  const runAt = nextRunAt(rows, effective, now);
  if (runAt !== null) await scheduleTimeoutJob(ctx, userId, runAt);
  return outcome;
}

export function createTimeoutJobHandler(deps: ModerationDeps): ScheduledHandler<ModerationConfig> {
  return async (data, ctx) => {
    if (!ctx.config.enabled) return;

    const parsed = timeoutJobSchema.safeParse(data);
    if (!parsed.success) {
      ctx.logger.error('a timeout check job carried no usable member id, so it was dropped.', {
        guildId: ctx.guildId,
        moduleId: MODULE_ID,
      });
      return;
    }

    await runTimeoutCheck(ctx, deps, parsed.data.userId);
  };
}
