import {
  type EventListener,
  type ModerationReportActionRequested,
  type ModuleContext,
  moderationReportActionRequestedSchema,
  type ProtonEvent,
  type ReportActionOutcome,
} from '@proton/core';
import { describeError } from '@proton/db';
import type { ModerationConfig } from '../config.ts';
import type { ModerationDeps } from '../deps.ts';
import { MODULE_ID } from '../perform.ts';
import type { ReviewActor } from './authorize.ts';
import { readState } from './delivery.ts';
import {
  acceptReport,
  assignReport,
  claimReport,
  dismissReport,
  REVIEW_MODERATION_OFF,
  type ReviewResult,
  repostCard,
  retryDelivery,
  unclaimReport,
} from './review.ts';

type Ctx = ModuleContext<ModerationConfig>;

export const REQUEST_FAILED =
  'Something went wrong on Proton’s side, so the action may not have finished. Refresh the ' +
  'report to check before trying again.';

export function mailboxId(guildId: string, requestId: string): string {
  return `${guildId}:${requestId}`;
}

function outcomeOf(result: ReviewResult): ReportActionOutcome {
  if (result.ok) {
    return {
      ok: true,
      code: 'ok',
      message: result.message,
      ...(result.caseId ? { caseId: result.caseId } : {}),
    };
  }

  return {
    ok: false,
    code: result.code,
    message: result.message,
    ...(result.needsConfirmation ? { needsConfirmation: result.needsConfirmation } : {}),
  };
}

function refused(code: string, message: string): ReportActionOutcome {
  return { ok: false, code, message };
}

async function rolesOf(
  deps: ModerationDeps,
  guildId: string,
  userId: string,
): Promise<string[] | null> {
  try {
    if (deps.lookupMember) {
      const found = await deps.lookupMember(guildId, userId);
      if (found.state === 'member') return found.roleIds;
      return found.state === 'absent' ? [] : null;
    }
    return (await deps.fetchMemberRoles?.(guildId, userId)) ?? null;
  } catch {
    return null;
  }
}

function permissionsOf(raw: string): bigint | null {
  try {
    return BigInt(raw);
  } catch {
    return null;
  }
}

function present(value: string | undefined): string | undefined {
  return value === undefined || value.trim() === '' ? undefined : value;
}

async function dispatch(
  ctx: Ctx,
  deps: ModerationDeps,
  request: ModerationReportActionRequested,
): Promise<ReportActionOutcome> {
  if (request.guildId !== ctx.guildId) {
    return refused(
      'invalid_request',
      'That request belongs to another server, so nothing was done.',
    );
  }
  if (!ctx.config.enabled) return refused('module_disabled', REVIEW_MODERATION_OFF);

  const permissions = permissionsOf(request.actorPermissions);
  if (permissions === null) {
    return refused(
      'invalid_request',
      'That request didn’t include your permissions, so nothing was done.',
    );
  }

  const state = await readState(deps, ctx.guildId);
  const actor: ReviewActor = {
    id: request.actorId,
    roleIds: await rolesOf(deps, ctx.guildId, request.actorId),
    permissions,
    source: 'dashboard',
    ...(state?.ownerId === request.actorId ? { owner: true } : {}),
  };

  const { params, reportId, requestId } = request;
  const duration = params.duration === null ? null : present(params.duration);

  switch (request.action) {
    case 'claim':
      return outcomeOf(await claimReport(ctx, deps, reportId, actor));
    case 'unclaim':
      return outcomeOf(await unclaimReport(ctx, deps, reportId, actor));
    case 'assign':
      return outcomeOf(await assignReport(ctx, deps, reportId, actor, params.assigneeId ?? null));
    case 'accept':
      return outcomeOf(
        await acceptReport(ctx, deps, {
          reportId,
          actor,
          punishment: params.punishment ?? 'none',
          ...(params.reason !== undefined ? { reason: params.reason } : {}),
          ...(duration !== undefined ? { duration } : {}),
          deleteMessage: params.deleteMessage ?? false,
          ...(params.note !== undefined ? { note: params.note } : {}),
          ...(params.reporterNote !== undefined ? { reporterNote: params.reporterNote } : {}),
          ...(params.confirmRecentCase ? { confirmRecentCase: true } : {}),
          token: requestId,
        }),
      );
    case 'dismiss':
      return outcomeOf(
        await dismissReport(ctx, deps, reportId, actor, {
          note: params.note ?? null,
          reporterNote: params.reporterNote ?? null,
          token: requestId,
        }),
      );
    case 'retry_delivery':
      return outcomeOf(await retryDelivery(ctx, deps, reportId, actor, requestId));
    case 'repost':
      return outcomeOf(await repostCard(ctx, deps, reportId, actor, requestId));
  }
}

async function answer(
  ctx: Ctx,
  deps: ModerationDeps,
  id: string,
  outcome: ReportActionOutcome,
): Promise<void> {
  if (!deps.mailbox) {
    ctx.logger.error(
      `a dashboard report action (${id}) finished but the mailbox is not connected, so the ` +
        'dashboard was never told the outcome.',
      { guildId: ctx.guildId, moduleId: MODULE_ID },
    );
    return;
  }

  try {
    await deps.mailbox.answer(id, outcome);
  } catch (error) {
    ctx.logger.error(
      `a dashboard report action (${id}) finished but its outcome could not be delivered: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { guildId: ctx.guildId, moduleId: MODULE_ID },
    );
  }
}

function rawIds(payload: unknown): { guildId: string; requestId: string } | null {
  const raw = (payload ?? {}) as { guildId?: unknown; requestId?: unknown };
  return typeof raw.guildId === 'string' && typeof raw.requestId === 'string'
    ? { guildId: raw.guildId, requestId: raw.requestId }
    : null;
}

export async function handleReportRequest(
  event: ProtonEvent,
  ctx: Ctx,
  deps: ModerationDeps,
): Promise<ReportActionOutcome | null> {
  const parsed = moderationReportActionRequestedSchema.safeParse(event.payload);

  if (!parsed.success) {
    const ids = rawIds(event.payload);
    ctx.logger.error('a dashboard report action arrived in a shape Proton could not read.', {
      guildId: ctx.guildId,
      moduleId: MODULE_ID,
    });
    if (!ids) return null;

    const outcome = refused(
      'invalid_request',
      'Proton couldn’t read that request, so nothing was done.',
    );
    await answer(ctx, deps, mailboxId(ids.guildId, ids.requestId), outcome);
    return outcome;
  }

  const request = parsed.data;
  let outcome: ReportActionOutcome;

  try {
    outcome = await dispatch(ctx, deps, request);
  } catch (error) {
    ctx.logger.error(
      `a dashboard report action (${request.action} on ${request.reportId}) failed: ${describeError(
        error,
      )}`,
      { guildId: ctx.guildId, moduleId: MODULE_ID, reportId: request.reportId },
    );
    outcome = refused('failed', REQUEST_FAILED);
  }

  await answer(ctx, deps, mailboxId(request.guildId, request.requestId), outcome);
  return outcome;
}

export function createReportRequestListener(deps: ModerationDeps): EventListener<ModerationConfig> {
  return {
    types: ['moderation.report_action_requested'],
    async handler(event, ctx) {
      await handleReportRequest(event, ctx, deps);
    },
  };
}
