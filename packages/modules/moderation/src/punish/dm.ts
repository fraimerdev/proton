import {
  type ActionFailure,
  type DiscordMessageBody,
  type ModuleContext,
  toDiscordMessage,
} from '@proton/core';
import {
  type BotFacts,
  type ServerFacts,
  serverFactsFrom,
  type UserFacts,
} from '@proton/core/placeholders';
import type { ModerationConfig } from '../config.ts';
import type { ModerationDeps } from '../deps.ts';
import { MODULE_ID } from '../perform.ts';
import { noticeKeys, renderPunishmentNotice } from '../placeholders.ts';
import type { PunishDirection } from './config.ts';
import { DIRECTION_NOUN, type DmOutcome, type PunishActor } from './types.ts';

type Ctx = ModuleContext<ModerationConfig>;

export type DmBody = Omit<DiscordMessageBody, 'allowedMentions'>;

export type DmStep = 'send' | 'correction';

export interface DmResult {
  outcome: DmOutcome;
  channelId: string | null;
}

export type DuplicateSend = Extract<DmOutcome, 'sent' | 'not_sent'>;

export const DM_CLOSED_CODES: ReadonlySet<number> = new Set([50007]);

export const NO_MUTUAL_SERVER_CODE = 50278;

export function dmKey(root: string, step: 'open' | DmStep): string {
  return `${root}:dm:${step}`;
}

function outcomeOf(failure: ActionFailure | undefined): DmOutcome {
  const code = failure?.discordCode;
  if (code === NO_MUTUAL_SERVER_CODE) return 'no_mutual_server';
  return code !== undefined && DM_CLOSED_CODES.has(code) ? 'closed' : 'failed';
}

function detailOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function channelIdOf(body: unknown): string | null {
  const id = (body as { id?: unknown } | undefined)?.id;
  return typeof id === 'string' ? id : null;
}

async function recall(ctx: Ctx, deps: ModerationDeps, userId: string): Promise<string | null> {
  try {
    return (await deps.dmChannels?.recall(ctx.guildId, userId)) ?? null;
  } catch (error) {
    ctx.logger.warn(`moderation could not read the remembered DM channel: ${detailOf(error)}`, {
      guildId: ctx.guildId,
      moduleId: MODULE_ID,
      userId,
    });
    return null;
  }
}

async function openChannel(
  ctx: Ctx,
  deps: ModerationDeps,
  input: { userId: string; root: string; actorId: string },
): Promise<{ channelId: string } | { outcome: DmOutcome }> {
  const remembered = await recall(ctx, deps, input.userId);
  if (remembered !== null) return { channelId: remembered };

  const opened = await ctx.executor.execute({
    guildId: ctx.guildId,
    moduleId: MODULE_ID,
    kind: 'create_dm',
    actorId: input.actorId,
    targetId: input.userId,
    idempotencyKey: dmKey(input.root, 'open'),
    dryRun: false,
    record: false,
    payload: { userId: input.userId },
  });

  if (opened.status === 'executed') {
    const channelId = channelIdOf(opened.body);
    if (channelId === null) return { outcome: 'failed' };

    try {
      await deps.dmChannels?.remember(ctx.guildId, input.userId, channelId);
    } catch (error) {
      ctx.logger.warn(`moderation could not remember a DM channel: ${detailOf(error)}`, {
        guildId: ctx.guildId,
        moduleId: MODULE_ID,
        userId: input.userId,
      });
    }

    return { channelId };
  }

  if (opened.status === 'skipped_duplicate') {
    const again = await recall(ctx, deps, input.userId);
    return again === null ? { outcome: 'gave_up' } : { channelId: again };
  }

  ctx.logger.warn(
    `moderation could not open a direct message with ${input.userId}: ${
      opened.failure?.humanReason ?? 'Discord gave no reason.'
    }`,
    { guildId: ctx.guildId, moduleId: MODULE_ID, userId: input.userId },
  );

  return { outcome: outcomeOf(opened.failure) };
}

export async function sendDm(
  ctx: Ctx,
  deps: ModerationDeps,
  input: {
    userId: string;
    root: string;
    step: DmStep;
    body: DmBody;
    actorId: string;
    channelId?: string | null;
    duplicate?: DuplicateSend;
  },
): Promise<DmResult> {
  let channelId = input.channelId ?? null;

  if (channelId === null) {
    const opened = await openChannel(ctx, deps, input);
    if ('outcome' in opened) return { outcome: opened.outcome, channelId: null };
    channelId = opened.channelId;
  }

  const sent = await ctx.executor.execute({
    guildId: ctx.guildId,
    moduleId: MODULE_ID,
    kind: 'send',
    actorId: input.actorId,
    targetId: input.userId,
    idempotencyKey: dmKey(input.root, input.step),
    dryRun: false,
    record: false,
    payload: { channelId, ...input.body, allowedMentions: { parse: [] }, directMessage: true },
  });

  if (sent.status === 'executed') return { outcome: 'sent', channelId };
  if (sent.status === 'skipped_duplicate') {
    return { outcome: input.duplicate ?? 'sent', channelId };
  }

  ctx.logger.warn(
    `moderation could not send a direct message to ${input.userId}: ${
      sent.failure?.humanReason ?? 'Discord gave no reason.'
    }`,
    { guildId: ctx.guildId, moduleId: MODULE_ID, userId: input.userId },
  );

  return { outcome: outcomeOf(sent.failure), channelId };
}

export interface NoticeInput {
  direction: PunishDirection;
  userId: string;
  root: string;
  actor: PunishActor;
  reason: string;
  durationMs: number | null;
  expiresAt: number | null;
  expired?: boolean;
  caseId: string | null;
  duplicate?: DuplicateSend;
}

function uses(keys: ReadonlySet<string>, namespace: string, beyond: readonly string[] = []) {
  return [...keys].some((key) => key.startsWith(`${namespace}.`) && !beyond.includes(key));
}

const IDENTITY_ONLY = ['user.id', 'user.mention'];

async function profile(
  deps: ModerationDeps,
  userId: string,
  wanted: boolean,
): Promise<UserFacts | null> {
  const bare: UserFacts = { id: userId, username: null, globalName: null, avatarHash: null };
  if (!wanted || !deps.placeholders) return bare;

  try {
    return (await deps.placeholders.user(userId)) ?? bare;
  } catch {
    return bare;
  }
}

async function moderatorFacts(
  deps: ModerationDeps,
  actor: PunishActor,
  wanted: boolean,
): Promise<UserFacts | null> {
  if (actor.kind === 'automation') {
    return { id: actor.id, username: null, globalName: actor.label ?? 'Proton', avatarHash: null };
  }

  return profile(deps, actor.id, wanted);
}

async function serverFacts(
  ctx: Ctx,
  deps: ModerationDeps,
  wanted: boolean,
): Promise<ServerFacts | null> {
  if (!wanted) return { id: ctx.guildId };

  try {
    if (deps.placeholders) return await deps.placeholders.server(ctx.guildId);
    return serverFactsFrom((await deps.guildState?.get(ctx.guildId)) ?? null, ctx.guildId);
  } catch {
    return { id: ctx.guildId };
  }
}

async function botFacts(deps: ModerationDeps, wanted: boolean): Promise<BotFacts | null> {
  if (!wanted || !deps.placeholders) return null;

  try {
    return await deps.placeholders.bot();
  } catch {
    return null;
  }
}

export async function sendPunishDm(
  ctx: Ctx,
  deps: ModerationDeps,
  input: NoticeInput,
): Promise<DmResult> {
  const message = ctx.config.punish.notifications.messages[input.direction];
  const keys = noticeKeys(input.direction, message);
  const now = deps.now?.() ?? Date.now();

  const rendered = renderPunishmentNotice(
    message,
    {
      direction: input.direction,
      reason: input.reason === '' ? null : input.reason,
      durationMs: input.durationMs,
      expiresAt: input.expiresAt,
      expired: input.expired ?? false,
      caseId: input.caseId,
      user: await profile(deps, input.userId, uses(keys, 'user', IDENTITY_ONLY)),
      moderator: await moderatorFacts(deps, input.actor, uses(keys, 'moderator')),
      server: await serverFacts(ctx, deps, uses(keys, 'server')),
      bot: await botFacts(deps, uses(keys, 'bot')),
    },
    now,
  );

  if (!rendered.ok) {
    ctx.logger.error(
      `moderation could not write the ${input.direction} direct message for ${input.userId}: ` +
        rendered.humanReason,
      { guildId: ctx.guildId, moduleId: MODULE_ID, userId: input.userId },
    );
    return { outcome: 'not_sent', channelId: null };
  }

  const { allowedMentions: _ignored, ...body } = toDiscordMessage(rendered.message, {
    customIdFor: (key) => key,
    now: new Date(now),
  });

  return sendDm(ctx, deps, {
    userId: input.userId,
    root: input.root,
    step: 'send',
    body,
    actorId: input.actor.id,
    ...(input.duplicate ? { duplicate: input.duplicate } : {}),
  });
}

export async function sendCorrectionDm(
  ctx: Ctx,
  deps: ModerationDeps,
  input: {
    userId: string;
    root: string;
    actorId: string;
    direction: PunishDirection;
    channelId: string | null;
  },
): Promise<DmOutcome> {
  const state = await deps.guildState?.get(ctx.guildId).catch(() => null);
  const where = state?.name ? ` about ${state.name}` : '';
  const noun = DIRECTION_NOUN[input.direction];

  const { outcome } = await sendDm(ctx, deps, {
    userId: input.userId,
    root: input.root,
    step: 'correction',
    body: { content: `Ignore the previous message${where}. That ${noun} didn't go through.` },
    actorId: input.actorId,
    channelId: input.channelId,
  });

  return outcome;
}
