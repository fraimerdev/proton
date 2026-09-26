import {
  type AuditEntry,
  auditChange,
  auditEntrySchema,
  auditLogEventPayloadSchema,
  type EventListener,
  type ModuleContext,
  type ProtonEvent,
  protonActionExecutedSchema,
  protonConfigChangedSchema,
  RULE_ENGINE_ACTOR,
  snowflakeSchema,
} from '@proton/core';
import { z } from 'zod';
import type { ModerationConfig } from '../config.ts';
import type { ModerationDeps } from '../deps.ts';
import { MODULE_ID } from '../perform.ts';
import type { PunishDirection } from './config.ts';
import { sendPunishDm } from './dm.ts';
import {
  applyTimeoutUntil,
  lookupTarget,
  MemberLookupUnavailableError,
  PROTON_ACTOR,
  type RejoinOutcome,
  reapplyOnRejoin,
  rearmTimeouts,
} from './jobs.ts';
import { snapshotCaseHistory } from './snapshot.ts';
import {
  applyTimeout,
  clampUntil,
  closeRemovedInDiscord,
  effectiveEnd,
  TIMEOUT_JOB,
} from './timeouts.ts';
import type { DmOutcome, PunishActor } from './types.ts';

type Ctx = ModuleContext<ModerationConfig>;

export const TIMEOUT_CHANGE_KEY = 'communication_disabled_until';
export const MEMBER_UPDATE_ACTION = 24;
export const AUTOMOD_MODULE_ID = 'automod';

export const POST_HOC_KINDS: ReadonlySet<string> = new Set(['timeout', 'warn']);

const REAPPLY_AUDIT_REASON = 'Keeping an earlier, longer timeout in place after an automatic one.';

const BY_OTHERS: Readonly<Record<string, 'ban' | 'kick' | 'unban'>> = {
  'member.banned': 'ban',
  'member.kicked': 'kick',
  'member.unbanned': 'unban',
};

const memberJoinSchema = z.object({
  user: z.object({ id: snowflakeSchema, bot: z.boolean().optional() }),
  joined_at: z.string().nullish(),
});

export function auditDmRoot(entryId: string): string {
  return `moderation:dm:audit:${entryId}`;
}

export function caseDmRoot(caseId: string): string {
  return `moderation:dm:case:${caseId}`;
}

function nowOf(deps: ModerationDeps): number {
  return deps.now?.() ?? Date.now();
}

function meta(ctx: Ctx, userId: string): Record<string, unknown> {
  return { guildId: ctx.guildId, moduleId: MODULE_ID, userId };
}

function memberActor(id: string): PunishActor {
  return { id, roleIds: null, permissions: null, kind: 'member' };
}

function automationLabel(moduleId: string): string {
  if (moduleId === AUTOMOD_MODULE_ID) return 'AutoMod';
  if (moduleId === MODULE_ID) return 'Warn escalation';
  return 'Proton';
}

async function tell(
  ctx: Ctx,
  deps: ModerationDeps,
  input: {
    direction: PunishDirection;
    userId: string;
    root: string;
    actor: PunishActor;
    reason: string | null;
    durationMs: number | null;
    expiresAt: number | null;
    expired?: boolean;
    caseId: string | null;
    about: string;
  },
): Promise<DmOutcome> {
  const { outcome } = await sendPunishDm(ctx, deps, {
    direction: input.direction,
    userId: input.userId,
    root: input.root,
    actor: input.actor,
    reason: input.reason ?? '',
    durationMs: input.durationMs,
    expiresAt: input.expiresAt,
    expired: input.expired ?? false,
    caseId: input.caseId,
  });

  ctx.logger.info(
    outcome === 'sent'
      ? `moderation told ${input.userId} about ${input.about} by direct message.`
      : `moderation could not tell ${input.userId} about ${input.about} (${outcome}).`,
    meta(ctx, input.userId),
  );

  return outcome;
}

export async function handleTimeoutRearm(
  event: ProtonEvent,
  ctx: Ctx,
  deps: ModerationDeps,
): Promise<number> {
  if (!ctx.config.enabled) return 0;

  if (event.type === 'proton.config_changed') {
    const changed = protonConfigChangedSchema.safeParse(event.payload);
    if (!changed.success || changed.data.moduleId !== MODULE_ID || !changed.data.enabledAfter) {
      return 0;
    }
  } else if (event.type !== 'guild.available') {
    return 0;
  }

  return rearmTimeouts(ctx, deps);
}

export async function handleMemberRejoin(
  event: ProtonEvent,
  ctx: Ctx,
  deps: ModerationDeps,
): Promise<RejoinOutcome> {
  if (!ctx.config.enabled || event.type !== 'member.joined') return 'none';

  const joined = memberJoinSchema.safeParse(event.payload);
  if (!joined.success || joined.data.user.bot) return 'none';

  const at = joined.data.joined_at ? Date.parse(joined.data.joined_at) : Number.NaN;

  return reapplyOnRejoin(ctx, deps, {
    userId: joined.data.user.id,
    joinedAt: Number.isFinite(at) ? at : event.occurredAt,
  });
}

type TimeoutChange = { cleared: true } | { cleared: false; until: number };

export function timeoutChangeOf(entry: AuditEntry, at: number): TimeoutChange | null {
  if (entry.actionType !== MEMBER_UPDATE_ACTION) return null;

  const change = auditChange(entry, TIMEOUT_CHANGE_KEY);
  if (!change) return null;

  const next = change.new_value;
  if (next === undefined || next === null || next === '') return { cleared: true };

  const until = typeof next === 'string' ? Date.parse(next) : Number.NaN;
  if (!Number.isFinite(until)) return null;

  return until <= at ? { cleared: true } : { cleared: false, until };
}

function byProton(ctx: Ctx, deps: ModerationDeps, actorId: string | null): boolean | null {
  if (!deps.botUserId) {
    ctx.logger.error(
      "moderation cannot tell Proton's own moderation from other people's here (no bot user " +
        'id is bound), so it skipped a moderation entry from the audit log.',
      { guildId: ctx.guildId, moduleId: MODULE_ID },
    );
    return null;
  }

  return actorId === deps.botUserId;
}

async function onTimeoutAudit(event: ProtonEvent, ctx: Ctx, deps: ModerationDeps): Promise<void> {
  const parsed = auditEntrySchema.safeParse(event.payload);
  if (!parsed.success) return;

  const entry = parsed.data;
  const targetId = snowflakeSchema.safeParse(entry.targetId);
  const change = timeoutChangeOf(entry, event.occurredAt);
  if (!change || !targetId.success) return;

  const proton = byProton(ctx, deps, entry.actorId);
  if (proton !== false) return;

  const userId = targetId.data;
  const notifications = ctx.config.punish.notifications;
  const root = auditDmRoot(entry.entryId);

  if (change.cleared) {
    const closed = await closeRemovedInDiscord(ctx, deps, userId, entry.actorId, nowOf(deps));
    if (closed.length > 0) await ctx.cancel?.(TIMEOUT_JOB, userId);

    if (entry.actorId !== null && notifications.onUnpunishByOthers) {
      await tell(ctx, deps, {
        direction: 'untimeout',
        userId,
        root,
        actor: memberActor(entry.actorId),
        reason: entry.reason,
        durationMs: null,
        expiresAt: null,
        caseId: null,
        about: `a timeout removal by ${entry.actorId}`,
      });
    }
    return;
  }

  if (entry.actorId === null || !notifications.onPunishByOthers) return;

  await tell(ctx, deps, {
    direction: 'timeout',
    userId,
    root,
    actor: memberActor(entry.actorId),
    reason: entry.reason,
    durationMs: Math.max(0, change.until - event.occurredAt),
    expiresAt: change.until,
    caseId: null,
    about: `a timeout by ${entry.actorId}`,
  });
}

async function onModerationAudit(
  event: ProtonEvent,
  ctx: Ctx,
  deps: ModerationDeps,
): Promise<void> {
  const direction = BY_OTHERS[event.type];
  if (!direction) return;

  const parsed = auditLogEventPayloadSchema.safeParse(event.payload);
  if (!parsed.success) return;

  const entry = parsed.data;
  const actorId = entry.actorId;
  const targetId = snowflakeSchema.safeParse(entry.targetId);
  if (actorId === null || !targetId.success) return;

  const proton = byProton(ctx, deps, actorId);
  if (proton !== false) return;

  const notifications = ctx.config.punish.notifications;
  const wanted =
    direction === 'unban' ? notifications.onUnpunishByOthers : notifications.onPunishByOthers;
  if (!wanted) return;

  await tell(ctx, deps, {
    direction,
    userId: targetId.data,
    root: auditDmRoot(entry.entryId),
    actor: memberActor(actorId),
    reason: entry.reason,
    durationMs: null,
    expiresAt: null,
    caseId: null,
    about: `a ${direction} by ${actorId}`,
  });
}

export async function handlePunishedByOthers(
  event: ProtonEvent,
  ctx: Ctx,
  deps: ModerationDeps,
): Promise<void> {
  if (!ctx.config.enabled) return;

  if (event.type === 'audit.entry') {
    await onTimeoutAudit(event, ctx, deps);
    return;
  }

  await onModerationAudit(event, ctx, deps);
}

async function timeoutStillOn(
  deps: ModerationDeps,
  guildId: string,
  userId: string,
  now: number,
): Promise<{ until: number | null } | { over: string }> {
  const found = await lookupTarget(deps, guildId, userId);
  if (found === null) return { until: null };

  switch (found.state) {
    case 'unavailable':
      throw new MemberLookupUnavailableError(userId, found.status, 'tell them about a timeout');
    case 'absent':
      return { over: 'they left the server before they could be told' };
    case 'member':
      return found.timeoutUntil !== null && found.timeoutUntil > now
        ? { until: found.timeoutUntil }
        : { over: 'the timeout was already over' };
  }
}

export function reapplyKey(guildId: string, userId: string, caseId: string): string {
  return `moderation:timeout:${guildId}:${userId}:reapply:${caseId}`;
}

async function trackAutomaticTimeout(
  ctx: Ctx,
  deps: ModerationDeps,
  input: { caseId: string; userId: string; actorId: string; until: number; now: number },
): Promise<void> {
  const store = deps.timeouts;
  if (!store) return;

  const { caseId, userId, now } = input;
  const allowMultiple = ctx.config.punish.types.timeout.allowMultiple;
  let appliedUntil = input.until;

  if (allowMultiple) {
    const others = (await store.open(ctx.guildId, userId)).filter((row) => row.caseId !== caseId);
    const longest = effectiveEnd(others);
    const until = longest === null ? null : clampUntil(longest, now);

    if (until !== null && until > input.until) {
      const reapplied = await applyTimeoutUntil(ctx, {
        userId,
        until,
        idempotencyKey: reapplyKey(ctx.guildId, userId, caseId),
        auditReason: REAPPLY_AUDIT_REASON,
      });
      if (reapplied) appliedUntil = until;
    }
  }

  await applyTimeout(ctx, deps, {
    caseId,
    userId,
    actorId: input.actorId,
    endsAt: input.until,
    appliedUntil,
    allowMultiple,
    now,
  });
}

export async function handleActionExecuted(
  event: ProtonEvent,
  ctx: Ctx,
  deps: ModerationDeps,
): Promise<void> {
  if (!ctx.config.enabled || event.type !== 'proton.action_executed') return;

  const parsed = protonActionExecutedSchema.safeParse(event.payload);
  if (!parsed.success) return;

  const action = parsed.data;
  if (action.dryRun || action.guildId !== ctx.guildId || action.targetId === null) return;

  const targetId = action.targetId;
  const notifications = ctx.config.punish.notifications;
  const root = caseDmRoot(action.caseId);

  if (action.reversal === true) {
    if (action.kind !== 'unban' || action.moduleId !== MODULE_ID || !notifications.onUnpunish) {
      return;
    }

    await tell(ctx, deps, {
      direction: 'unban',
      userId: targetId,
      root,
      actor: PROTON_ACTOR,
      reason: action.reason,
      durationMs: null,
      expiresAt: null,
      expired: true,
      caseId: action.caseId,
      about: 'their temporary ban ending',
    });
    return;
  }

  if (!POST_HOC_KINDS.has(action.kind)) return;
  if (action.moduleId !== AUTOMOD_MODULE_ID && action.actorId !== RULE_ENGINE_ACTOR) return;

  const kind = action.kind === 'timeout' ? 'timeout' : 'warn';
  const now = nowOf(deps);

  const current =
    kind === 'timeout' && (notifications.onPunish || deps.timeouts !== undefined)
      ? await timeoutStillOn(deps, ctx.guildId, targetId, now)
      : { until: null };

  if (kind === 'timeout' && 'until' in current && current.until !== null) {
    await trackAutomaticTimeout(ctx, deps, {
      caseId: action.caseId,
      userId: targetId,
      actorId: action.actorId,
      until: current.until,
      now,
    });
  }

  if ('over' in current) {
    if (notifications.onPunish) {
      ctx.logger.info(
        `moderation did not tell ${targetId} about an automatic timeout: ${current.over}.`,
        meta(ctx, targetId),
      );
    }
  } else if (notifications.onPunish) {
    const expiresAt = current.until;

    await tell(ctx, deps, {
      direction: kind,
      userId: targetId,
      root,
      actor: {
        id: action.actorId,
        roleIds: null,
        permissions: null,
        kind: 'automation',
        label: automationLabel(action.moduleId),
      },
      reason: action.reason,
      durationMs: expiresAt === null ? null : Math.max(0, expiresAt - event.occurredAt),
      expiresAt,
      caseId: action.caseId,
      about: `an automatic ${kind === 'timeout' ? 'timeout' : 'warning'}`,
    });
  }

  const snapshot = await snapshotCaseHistory(ctx, deps, { caseId: action.caseId, targetId, now });
  if (snapshot?.status === 'failed') {
    ctx.logger.warn(`case ${action.caseId}: ${snapshot.message}`, meta(ctx, targetId));
  }
}

export function createPunishListeners(deps: ModerationDeps): EventListener<ModerationConfig>[] {
  return [
    {
      types: ['guild.available', 'proton.config_changed'],
      async handler(event, ctx) {
        await handleTimeoutRearm(event, ctx, deps);
      },
    },
    {
      types: ['member.joined'],
      async handler(event, ctx) {
        await handleMemberRejoin(event, ctx, deps);
      },
    },
    {
      types: ['audit.entry', 'member.banned', 'member.kicked', 'member.unbanned'],
      async handler(event, ctx) {
        await handlePunishedByOthers(event, ctx, deps);
      },
    },
    {
      types: ['proton.action_executed'],
      async handler(event, ctx) {
        await handleActionExecuted(event, ctx, deps);
      },
    },
  ];
}
