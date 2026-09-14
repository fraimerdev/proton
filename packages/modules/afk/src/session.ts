import {
  type ActionExecutor,
  type ActionFailure,
  type ActionResult,
  isScopedActionExecutor,
  type ModuleContext,
  newId,
} from '@proton/core';
import { MessageFlags } from 'discord-api-types/v10';
import { AFK_EXPIRE_JOB, AFK_TOMBSTONE_MS, type AfkConfig, MODULE_ID } from './config.ts';
import { type RecapOutcome, renderRecap } from './render.ts';
import type { AfkStatus, AfkStore } from './store.ts';

export type NickOutcome =
  | { status: 'restored' | 'kept' | 'untouched' }
  | { status: 'failed'; failure: ActionFailure };

export type SessionFinish = 'tombstone' | 'delete';

export interface EndSessionOptions {
  endedBy: string;
  actorId: string;
  currentNick: string | null | undefined;
  recap: boolean;
  targetRoleIds?: string[] | null | undefined;
  finish: SessionFinish;
}

export interface EndedSession {
  status: AfkStatus;
  nick: NickOutcome;
  recap: RecapOutcome;
  pingCount: number;
}

type RestoreOptions = Pick<EndSessionOptions, 'actorId' | 'currentNick' | 'targetRoleIds'>;

const NO_REASON: ActionFailure = { code: 'unknown', humanReason: 'Discord gave no reason.' };

export function expiryKey(status: Pick<AfkStatus, 'userId' | 'sessionId'>): string {
  return `${status.userId}:${status.sessionId}`;
}

export function succeeded(result: ActionResult): boolean {
  return result.status === 'executed' || result.status === 'skipped_duplicate';
}

export function failureOf(result: ActionResult): ActionFailure {
  return result.failure ?? NO_REASON;
}

export function bodyId(result: ActionResult): string | null {
  const id = (result.body as { id?: unknown } | undefined)?.id;
  return typeof id === 'string' ? id : null;
}

export function memberExecutor(
  ctx: ModuleContext<AfkConfig>,
  roleIds: string[] | null | undefined,
): ActionExecutor {
  if (!roleIds || !isScopedActionExecutor(ctx.executor)) return ctx.executor;
  return ctx.executor.scoped({ targetRoleIds: roleIds });
}

export async function untag(
  ctx: ModuleContext<AfkConfig>,
  status: AfkStatus,
  actorId: string,
  targetRoleIds?: string[] | null,
): Promise<NickOutcome> {
  const result = await memberExecutor(ctx, targetRoleIds).execute({
    guildId: ctx.guildId,
    moduleId: MODULE_ID,
    kind: 'set_member_nickname',
    targetId: status.userId,
    actorId,
    reason: 'AFK ended',
    payload: { nickname: status.previousNick },
    dryRun: false,
    record: false,
    idempotencyKey: `afk:${ctx.guildId}:${status.sessionId}:untag`,
  });

  return succeeded(result)
    ? { status: 'restored' }
    : { status: 'failed', failure: failureOf(result) };
}

async function restoreNickname(
  ctx: ModuleContext<AfkConfig>,
  status: AfkStatus,
  options: RestoreOptions,
): Promise<NickOutcome> {
  if (status.appliedNick === null) return { status: 'untouched' };

  const { currentNick } = options;
  // A message sent before the tag landed still carries the old nickname, and must still restore.
  if (
    currentNick !== undefined &&
    currentNick !== status.appliedNick &&
    currentNick !== status.previousNick
  ) {
    return { status: 'kept' };
  }

  return untag(ctx, status, options.actorId, options.targetRoleIds);
}

async function sendRecap(
  ctx: ModuleContext<AfkConfig>,
  store: AfkStore,
  ended: AfkStatus,
  options: EndSessionOptions,
): Promise<{ recap: RecapOutcome; pingCount: number }> {
  if (!options.recap || !ctx.config.recap) return { recap: 'none', pingCount: 0 };

  const pings = await store.pings(ended.sessionId);
  if (pings.length === 0) return { recap: 'none', pingCount: 0 };

  const key = `afk:${ctx.guildId}:${ended.sessionId}`;
  const meta = { guildId: ctx.guildId, moduleId: MODULE_ID, userId: ended.userId };

  const opened = await ctx.executor.execute({
    guildId: ctx.guildId,
    moduleId: MODULE_ID,
    kind: 'create_dm',
    targetId: ended.userId,
    actorId: options.actorId,
    // A nonce per attempt: a deduped create_dm has no body, so a retry could never learn the channel.
    idempotencyKey: `${key}:dm:${newId()}`,
    dryRun: false,
    record: false,
    payload: { userId: ended.userId },
  });

  const channelId = bodyId(opened);
  if (channelId === null) {
    ctx.logger.warn(
      `AFK could not open a DM with ${ended.userId} to send the pings they missed: ${
        opened.failure?.humanReason ?? 'their direct messages are closed.'
      }`,
      meta,
    );
    return { recap: 'undeliverable', pingCount: pings.length };
  }

  for (const [index, content] of renderRecap(ctx.guildId, pings).entries()) {
    const sent = await ctx.executor.execute({
      guildId: ctx.guildId,
      moduleId: MODULE_ID,
      kind: 'send',
      actorId: options.actorId,
      idempotencyKey: index === 0 ? `${key}:recap` : `${key}:recap:${index}`,
      dryRun: false,
      record: false,
      payload: {
        channelId,
        content,
        allowedMentions: { parse: [] },
        flags: MessageFlags.SuppressEmbeds,
      },
    });

    if (!succeeded(sent)) {
      ctx.logger.warn(
        `AFK opened a DM with ${ended.userId} but could not send the pings they missed: ${
          failureOf(sent).humanReason
        }`,
        meta,
      );
      return { recap: 'undeliverable', pingCount: pings.length };
    }
  }

  return { recap: 'sent', pingCount: pings.length };
}

async function bookPurge(ctx: ModuleContext<AfkConfig>, ended: AfkStatus): Promise<void> {
  if (typeof ctx.schedule !== 'function') return;

  try {
    await ctx.schedule(
      AFK_EXPIRE_JOB,
      new Date(Date.now() + AFK_TOMBSTONE_MS),
      expiryKey(ended),
      { userId: ended.userId, sessionId: ended.sessionId },
      { replace: true },
    );
  } catch (error) {
    ctx.logger.warn(
      `AFK ended ${ended.userId}'s status but could not book the removal of its record: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { guildId: ctx.guildId, moduleId: MODULE_ID, userId: ended.userId },
    );
  }
}

export async function endSession(
  ctx: ModuleContext<AfkConfig>,
  store: AfkStore,
  status: AfkStatus,
  options: EndSessionOptions,
): Promise<EndedSession | null> {
  const ended = await store.markEnded(status.sessionId, options.endedBy);
  if (!ended) return null;

  const nick = await restoreNickname(ctx, ended, options);
  const { recap, pingCount } = await sendRecap(ctx, store, ended, options);

  if (options.finish === 'delete') {
    await store.remove(ended.sessionId);
  } else {
    // Kept, not deleted: a redelivered /afk set must find its session already ended.
    await store.finishSession(ended.sessionId);
    await bookPurge(ctx, ended);
  }

  return { status: ended, nick, recap, pingCount };
}

export async function discardEnded(
  ctx: ModuleContext<AfkConfig>,
  store: AfkStore,
  status: AfkStatus,
  actorId: string,
): Promise<NickOutcome> {
  const nick = await restoreNickname(ctx, status, { actorId, currentNick: undefined });
  await store.remove(status.sessionId);
  return nick;
}
