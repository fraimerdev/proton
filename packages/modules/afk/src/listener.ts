import {
  type AllowedMentions,
  type EventListener,
  type EventType,
  type ModuleContext,
  type ProtonEvent,
  protonConfigChangedSchema,
} from '@proton/core';
import { MessageFlags } from 'discord-api-types/v10';
import {
  AFK_EXPIRE_JOB,
  AFK_TIDY_JOB,
  type AfkConfig,
  MODULE_ID,
  NOTICE_COOLDOWN_MS,
  tidyDelayMs,
} from './config.ts';
import { type AfkDeps, bindStore, describeUnbound } from './deps.ts';
import { type AfkMessage, fromHuman, readMemberLeft, readMessage } from './message.ts';
import {
  displayName,
  type NoticeEntry,
  nicknameProblem,
  renderNotice,
  renderWelcome,
} from './render.ts';
import {
  bodyId,
  discardEnded,
  endSession,
  expiryKey,
  failureOf,
  type NickOutcome,
  succeeded,
} from './session.ts';
import type { AfkStatus, AfkStore } from './store.ts';

export const AFK_EVENT_TYPES: EventType[] = [
  'message.created',
  'member.left',
  'proton.config_changed',
];

type Ctx = ModuleContext<AfkConfig>;

type Quiet = () => Promise<boolean>;

const MENTIONS_OFF: AllowedMentions = { parse: [] };

function metaOf(ctx: Ctx, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { guildId: ctx.guildId, moduleId: MODULE_ID, ...extra };
}

function storeOf(ctx: Ctx, deps: AfkDeps, what: string): AfkStore | null {
  const bound = bindStore(deps);
  if ('store' in bound) return bound.store;

  ctx.logger.error(describeUnbound(what, bound.unbound), metaOf(ctx));
  return null;
}

function reportNickname(ctx: Ctx, userId: string, nick: NickOutcome | undefined): void {
  if (nick?.status !== 'failed') return;

  ctx.logger.warn(
    `AFK could not restore ${userId}'s nickname: ${nicknameProblem(nick.failure, 'their')}`,
    metaOf(ctx, { userId }),
  );
}

async function retireExpiry(ctx: Ctx, status: AfkStatus, done: string): Promise<void> {
  try {
    await ctx.cancel?.(AFK_EXPIRE_JOB, expiryKey(status));
  } catch (error) {
    ctx.logger.warn(
      `${done}, but could not retire their expiry: ${
        error instanceof Error ? error.message : String(error)
      }`,
      metaOf(ctx, { userId: status.userId }),
    );
  }
}

async function scheduleTidy(ctx: Ctx, channelId: string, messageId: string): Promise<void> {
  if (typeof ctx.schedule !== 'function') {
    ctx.logger.warn(
      `AFK could not tidy its reply in <#${channelId}>: this process has no scheduler, so the ` +
        'reply stays.',
      metaOf(ctx),
    );
    return;
  }

  try {
    await ctx.schedule(
      AFK_TIDY_JOB,
      new Date(Date.now() + tidyDelayMs(ctx.config)),
      `${channelId}:${messageId}`,
      { channelId, messageId },
    );
  } catch (error) {
    ctx.logger.warn(
      `AFK could not book the tidy-up of its reply in <#${channelId}>, so it stays: ${
        error instanceof Error ? error.message : String(error)
      }`,
      metaOf(ctx),
    );
  }
}

async function reply(
  ctx: Ctx,
  message: AfkMessage,
  content: string,
  idempotencyKey: string,
  what: string,
): Promise<void> {
  const result = await ctx.executor.execute({
    guildId: ctx.guildId,
    moduleId: MODULE_ID,
    kind: 'send',
    actorId: MODULE_ID,
    idempotencyKey,
    dryRun: false,
    record: false,
    payload: {
      channelId: message.channelId,
      content,
      allowedMentions: MENTIONS_OFF,
      replyToMessageId: message.messageId,
      flags: MessageFlags.SuppressEmbeds,
    },
  });

  if (!succeeded(result)) {
    ctx.logger.warn(
      `AFK could not ${what} in <#${message.channelId}>: ${failureOf(result).humanReason}`,
      metaOf(ctx, { code: result.failure?.code }),
    );
    return;
  }

  const sentId = result.status === 'executed' ? bodyId(result) : null;
  if (sentId === null || !ctx.config.tidyReplies) return;

  await scheduleTidy(ctx, message.channelId, sentId);
}

async function inIgnoredChannel(ctx: Ctx, deps: AfkDeps, channelId: string): Promise<boolean> {
  const ignored = ctx.config.ignoredChannelIds;
  if (ignored.includes(channelId)) return true;
  if (ignored.length === 0 || !deps.guildState) return false;

  try {
    const parentId = (await deps.guildState.get(ctx.guildId))?.channels.get(channelId)?.parentId;
    return typeof parentId === 'string' && ignored.includes(parentId);
  } catch (error) {
    ctx.logger.warn(
      `AFK could not read the channels of server ${ctx.guildId}, so it only checked whether ` +
        `<#${channelId}> itself is a channel without AFK replies: ${
          error instanceof Error ? error.message : String(error)
        }`,
      metaOf(ctx, { channelId }),
    );
    return false;
  }
}

async function welcomeBack(
  ctx: Ctx,
  store: AfkStore,
  message: AfkMessage,
  quiet: Quiet,
): Promise<void> {
  const own = await store.get(ctx.guildId, message.authorId);
  if (!own || message.at < own.since.getTime()) return;

  const endedBy = `message:${message.messageId}`;
  if (own.endedAt !== null && own.endedBy !== endedBy) return;

  const silent = await quiet();

  const ended = await endSession(ctx, store, own, {
    endedBy,
    actorId: message.authorId,
    currentNick: message.nick,
    recap: true,
    targetRoleIds: message.roleIds,
    finish: 'tombstone',
  });

  if (!ended) return;
  reportNickname(ctx, own.userId, ended.nick);

  if (silent) return;

  const nick =
    message.nick !== undefined && message.nick === own.appliedNick
      ? own.previousNick
      : message.nick;

  await reply(
    ctx,
    message,
    renderWelcome(
      displayName(nick, message.globalName, message.username),
      message.at - own.since.getTime(),
      ended.recap,
      ended.pingCount,
      ended.nick.status === 'failed' ? nicknameProblem(ended.nick.failure, 'your') : null,
    ),
    `afk:${ctx.guildId}:${own.sessionId}:welcome`,
    `welcome ${message.authorId} back`,
  );
}

async function noticeMentions(
  ctx: Ctx,
  store: AfkStore,
  message: AfkMessage,
  quiet: Quiet,
): Promise<void> {
  const mentioned = message.mentions.filter((user) => !user.bot && user.id !== message.authorId);
  if (mentioned.length === 0) return;

  const away = (
    await store.active(
      ctx.guildId,
      mentioned.map((user) => user.id),
    )
  ).filter((status) => status.since.getTime() <= message.at);
  if (away.length === 0) return;

  for (const status of away) {
    await store.recordPing(status.sessionId, {
      guildId: ctx.guildId,
      userId: status.userId,
      messageId: message.messageId,
      channelId: message.channelId,
      authorId: message.authorId,
      pingedAt: new Date(message.at),
    });
  }

  if (await quiet()) return;

  const byUser = new Map(away.map((status) => [status.userId, status]));
  const entries: NoticeEntry[] = mentioned.flatMap((user) => {
    const status = byUser.get(user.id);
    if (!status) return [];

    return [
      {
        name: displayName(user.nick, user.globalName, user.username),
        reason: status.reason,
        since: status.since,
      },
    ];
  });

  const bucket = Math.floor(message.at / NOTICE_COOLDOWN_MS);
  const who = [...byUser.keys()].sort().join(',');

  await reply(
    ctx,
    message,
    renderNotice(entries),
    // The executor's dedupe is the cooldown: the same people pinged here this minute reuse the key.
    `afk:${ctx.guildId}:${message.channelId}:notice:${bucket}:${who}`,
    'tell the channel who is away',
  );
}

export async function handleMessage(event: ProtonEvent, ctx: Ctx, deps: AfkDeps): Promise<void> {
  if (!ctx.config.enabled) return;

  const message = readMessage(event);
  if (!message || !fromHuman(message)) return;

  const store = storeOf(ctx, deps, 'AFK notices and welcome-backs');
  if (!store) return;

  let ignored: Promise<boolean> | undefined;
  const quiet: Quiet = () => {
    ignored ??= inIgnoredChannel(ctx, deps, message.channelId);
    return ignored;
  };

  await welcomeBack(ctx, store, message, quiet);
  await noticeMentions(ctx, store, message, quiet);
}

export async function handleMemberLeft(event: ProtonEvent, ctx: Ctx, deps: AfkDeps): Promise<void> {
  const userId = readMemberLeft(event);
  if (!userId) return;

  const store = storeOf(ctx, deps, 'clearing the AFK status of members who leave');
  if (!store) return;

  const status = await store.get(ctx.guildId, userId);
  await store.removeMember(ctx.guildId, userId);
  if (status) await retireExpiry(ctx, status, `AFK forgot ${userId}, who left`);
}

async function teardown(ctx: Ctx, store: AfkStore, auditId: string): Promise<void> {
  for (const status of await store.all(ctx.guildId)) {
    const nick =
      status.endedAt === null
        ? (
            await endSession(ctx, store, status, {
              endedBy: `teardown:${auditId}`,
              actorId: MODULE_ID,
              currentNick: undefined,
              recap: false,
              finish: 'delete',
            })
          )?.nick
        : await discardEnded(ctx, store, status, MODULE_ID);

    reportNickname(ctx, status.userId, nick);
    await retireExpiry(
      ctx,
      status,
      `AFK ended ${status.userId}'s status as the module was switched off`,
    );
  }
}

async function untagAll(ctx: Ctx, store: AfkStore, auditId: string): Promise<void> {
  for (const status of await store.all(ctx.guildId)) {
    if (status.endedAt !== null || status.appliedNick === null) continue;

    const result = await ctx.executor.execute({
      guildId: ctx.guildId,
      moduleId: MODULE_ID,
      kind: 'set_member_nickname',
      targetId: status.userId,
      actorId: MODULE_ID,
      reason: 'AFK tag switched off',
      payload: { nickname: status.previousNick },
      dryRun: false,
      record: false,
      idempotencyKey: `afk:${ctx.guildId}:${status.sessionId}:untag:${auditId}`,
    });

    if (succeeded(result)) {
      await store.setAppliedNick(status.sessionId, null);
      continue;
    }

    ctx.logger.warn(
      `AFK could not take [AFK] off ${status.userId}'s nickname: ${nicknameProblem(failureOf(result), 'their')}`,
      metaOf(ctx, { userId: status.userId }),
    );
  }
}

export async function handleConfigChanged(
  event: ProtonEvent,
  ctx: Ctx,
  deps: AfkDeps,
): Promise<void> {
  const parsed = protonConfigChangedSchema.safeParse(event.payload);
  if (!parsed.success || parsed.data.moduleId !== MODULE_ID) return;

  const { auditId, enabledBefore, enabledAfter, changedKeys } = parsed.data;

  if (!enabledAfter || !ctx.config.enabled) {
    if (!enabledBefore && !changedKeys.includes('enabled')) return;

    const store = storeOf(ctx, deps, 'ending AFK statuses when the module is switched off');
    if (store) await teardown(ctx, store, auditId);
    return;
  }

  if (ctx.config.nicknameTag || !changedKeys.includes('nicknameTag')) return;

  const store = storeOf(ctx, deps, 'removing [AFK] tags when the tag is switched off');
  if (store) await untagAll(ctx, store, auditId);
}

export function createAfkListener(deps: AfkDeps = {}): EventListener<AfkConfig> {
  return {
    types: AFK_EVENT_TYPES,

    async handler(event, ctx) {
      switch (event.type) {
        case 'message.created':
          return handleMessage(event, ctx, deps);
        case 'member.left':
          return handleMemberLeft(event, ctx, deps);
        case 'proton.config_changed':
          return handleConfigChanged(event, ctx, deps);
        default:
          return;
      }
    },
  };
}
