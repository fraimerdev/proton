import {
  type ActionResult,
  type EventListener,
  errorEmbed,
  isHumanMessage,
  type ModuleContext,
  type ProtonEvent,
  type ScheduledHandler,
  snowflakeSchema,
  successEmbed,
} from '@proton/core';
import { z } from 'zod';
import type { ModerationConfig } from '../config.ts';
import type { ModerationDeps } from '../deps.ts';
import { newDraftId, REACTION_DRAFT_TTL_MS } from '../drafts.ts';
import { MODULE_ID } from '../perform.ts';
import { validateReporter, validateTarget } from './authorize.ts';
import type { ReportsConfig } from './config.ts';
import { type DirectOutcome, REPORTS_ACTOR, sendDirect } from './direct.ts';
import { capturedMessage, unavailableMessage } from './evidence.ts';
import {
  basePermissions,
  DRAFTS_UNBOUND,
  finishButton,
  type IntakeDraft,
  targetRolesAtSubmit,
} from './intake.ts';
import { REPORT_STORE_UNBOUND, submitReport } from './submit.ts';

export const PROMPT_CLEANUP_JOB = 'moderation.prompt-cleanup';
export const PROMPT_TTL_MS = 2 * 60 * 1000;

export interface EmojiRef {
  id: string | null;
  name: string | null;
}

export function parseReactionEmoji(value: string): EmojiRef {
  const trimmed = value.trim();

  const tagged = /^<a?:([^:]+):(\d{17,20})>$/.exec(trimmed);
  if (tagged) return { name: tagged[1] ?? null, id: tagged[2] ?? null };

  const pair = /^([^:]+):(\d{17,20})$/.exec(trimmed);
  if (pair) return { name: pair[1] ?? null, id: pair[2] ?? null };

  if (/^\d{17,20}$/.test(trimmed)) return { id: trimmed, name: null };

  return { id: null, name: trimmed };
}

export function sameEmoji(reacted: EmojiRef, configured: EmojiRef): boolean {
  if (reacted.id !== null && configured.id !== null) return reacted.id === configured.id;
  if (reacted.id !== null || configured.id !== null) return false;
  return reacted.name !== null && reacted.name === configured.name;
}

export function emojiRestForm(emoji: EmojiRef): string {
  return emoji.id !== null ? `${emoji.name ?? '_'}:${emoji.id}` : (emoji.name ?? '');
}

export interface ReportReaction {
  userId: string;
  channelId: string;
  messageId: string;
  messageAuthorId: string | null;
  emoji: EmojiRef;
  roleIds: string[] | null;
  bot: boolean;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export function readReportReaction(event: ProtonEvent): ReportReaction | null {
  const d = record(event.payload);
  const emoji = record(d?.emoji);
  const userId = str(d?.user_id);
  const channelId = str(d?.channel_id);
  const messageId = str(d?.message_id);
  if (!d || !emoji || !userId || !channelId || !messageId) return null;

  const member = record(d.member);
  const roles = member?.roles;

  return {
    userId,
    channelId,
    messageId,
    messageAuthorId: str(d.message_author_id),
    emoji: { id: str(emoji.id), name: str(emoji.name) },
    roleIds: Array.isArray(roles)
      ? roles.filter((role): role is string => typeof role === 'string')
      : null,
    bot: record(member?.user)?.bot === true,
  };
}

export function channelEligible(reports: ReportsConfig, channelId: string): boolean {
  if (channelId === reports.channelId) return false;

  const listed = reports.reaction.channelIds.includes(channelId);

  switch (reports.reaction.channelMode) {
    case 'all':
      return true;
    case 'only':
      return listed;
    case 'except':
      return !listed;
  }
}

export type ReactionReportOutcome =
  | { action: 'ignored'; reason: string }
  | { action: 'filed'; reportId: string; existing: boolean }
  | { action: 'refused'; message: string }
  | { action: 'prompted'; via: 'dm' | 'channel' }
  | { action: 'undelivered' };

function ignored(reason: string): ReactionReportOutcome {
  return { action: 'ignored', reason };
}

function joinAsks(asks: readonly string[]): string {
  if (asks.length <= 1) return asks[0] ?? 'more detail';
  return `${asks.slice(0, -1).join(', ')} and ${asks.at(-1)}`;
}

function missingParts(reports: ReportsConfig, reasonId: string | null): string[] {
  return [
    ...(reports.requireReason && reasonId === null ? ['a reason'] : []),
    ...(reports.requireComment ? ['some details'] : []),
    ...(reports.requireAttachment ? ['a screenshot or file'] : []),
  ];
}

function idOf(result: ActionResult): string | null {
  const id = (result.body as { id?: unknown } | undefined)?.id;
  return typeof id === 'string' ? id : null;
}

export function createReportReactionListener(
  deps: ModerationDeps,
): EventListener<ModerationConfig> {
  return {
    types: ['reaction.added'],
    async handler(event, ctx) {
      await handleReportReaction(event, ctx, deps);
    },
  };
}

export async function handleReportReaction(
  event: ProtonEvent,
  ctx: ModuleContext<ModerationConfig>,
  deps: ModerationDeps,
): Promise<ReactionReportOutcome> {
  if (event.type !== 'reaction.added') return ignored('not a reaction being added');
  if (!ctx.config.enabled) return ignored('moderation is off');

  const reports = ctx.config.reports;
  if (!reports.enabled || !reports.methods.reaction) return ignored('reaction reports are off');

  const reaction = readReportReaction(event);
  if (!reaction) return ignored('unreadable reaction payload');

  if (!sameEmoji(reaction.emoji, parseReactionEmoji(reports.reaction.emoji))) {
    return ignored('not the report emoji');
  }
  if (!channelEligible(reports, reaction.channelId)) return ignored('channel not covered');
  if (reaction.bot || reaction.userId === deps.botUserId) return ignored('reacted by a bot');

  const gate = deps.reactionGate;
  if (gate) {
    const claim = await gate.claim(
      ctx.guildId,
      reaction.channelId,
      reaction.messageId,
      reaction.userId,
      event.id,
    );

    if (claim === 'duplicate') {
      await removeFlag(ctx, event, reaction);
      return ignored('already handled for this member and message');
    }
  }

  const release = () =>
    gate?.release(ctx.guildId, reaction.channelId, reaction.messageId, reaction.userId);

  let outcome: ReactionReportOutcome;
  try {
    outcome = await fileFromReaction(event, ctx, deps, reaction);
  } catch (error) {
    await release();
    throw error;
  }

  if (outcome.action === 'refused' || outcome.action === 'undelivered') await release();
  return outcome;
}

async function removeFlag(
  ctx: ModuleContext<ModerationConfig>,
  event: ProtonEvent,
  reaction: ReportReaction,
): Promise<void> {
  if (!ctx.config.reports.reaction.removeReaction) return;

  const removed = await ctx.executor.execute({
    guildId: ctx.guildId,
    moduleId: MODULE_ID,
    kind: 'remove_reaction',
    actorId: REPORTS_ACTOR,
    idempotencyKey: `moderation:report:reaction:${event.id}:remove`,
    dryRun: false,
    record: false,
    payload: {
      channelId: reaction.channelId,
      messageId: reaction.messageId,
      emoji: emojiRestForm(reaction.emoji),
      userId: reaction.userId,
    },
  });

  if (removed.status === 'failed_precheck' || removed.status === 'failed_api') {
    ctx.logger.warn(
      `Proton couldn't remove a report reaction in <#${reaction.channelId}>, so it stays ` +
        `visible: ${removed.failure?.humanReason ?? 'Discord gave no reason.'}`,
      {
        guildId: ctx.guildId,
        moduleId: MODULE_ID,
        channelId: reaction.channelId,
        code: removed.failure?.code,
      },
    );
  }
}

async function fileFromReaction(
  event: ProtonEvent,
  ctx: ModuleContext<ModerationConfig>,
  deps: ModerationDeps,
  reaction: ReportReaction,
): Promise<ReactionReportOutcome> {
  const reports = ctx.config.reports;
  const root = `moderation:report:reaction:${event.id}`;
  const now = deps.now?.() ?? Date.now();
  const logContext = {
    guildId: ctx.guildId,
    moduleId: MODULE_ID,
    channelId: reaction.channelId,
    userId: reaction.userId,
  };

  await removeFlag(ctx, event, reaction);

  const state = (await deps.guildState?.get(ctx.guildId)) ?? null;
  const server = state?.name ? `**${state.name}**` : 'the server';

  const tell = (text: string, tone: 'success' | 'error'): Promise<DirectOutcome> =>
    sendDirect(ctx, deps, {
      userId: reaction.userId,
      root,
      message: {
        content: '',
        embeds: [tone === 'success' ? successEmbed(text) : errorEmbed(text)],
      },
    });

  const refuse = async (message: string, framed = true): Promise<ReactionReportOutcome> => {
    const told = await tell(
      framed ? `You flagged a message in ${server}. ${message}` : message,
      'error',
    );
    if (told !== 'sent') {
      ctx.logger.info(
        `a reaction report by ${reaction.userId} was refused and they could not be told why: ${message}`,
        logContext,
      );
    }
    return { action: 'refused', message };
  };

  const reporterRoleIds = reaction.roleIds ?? [];
  const reporterCheck = validateReporter(
    ctx.config,
    {
      id: reaction.userId,
      roleIds: reaction.roleIds,
      permissions: basePermissions(state, reaction.userId, reporterRoleIds),
    },
    ctx.guildId,
  );
  if (!reporterCheck.ok) return refuse(reporterCheck.message);

  const read = deps.readMessage
    ? await deps.readMessage(ctx.guildId, reaction.channelId, reaction.messageId)
    : null;
  const author = read?.ok ? read.message.author : null;
  const targetId = reaction.messageAuthorId ?? author?.id ?? null;

  if (!targetId) {
    return refuse(
      `I couldn’t read the message you flagged in ${server}, so no report was filed. Use ` +
        'Apps → Report message on it instead.',
      false,
    );
  }

  if (read?.ok) {
    if (read.message.webhookId !== null) {
      return refuse(
        'Messages sent through a webhook can’t be reported, because there’s no member behind them.',
      );
    }
    if (author?.bot) return refuse('Messages from bots can’t be reported.');
    if (!isHumanMessage(read.message.type)) return refuse('System messages can’t be reported.');
  }

  if (targetId === reaction.userId) return refuse('You can’t report your own message.');

  const targetRoles = await targetRolesAtSubmit(deps, ctx.guildId, {
    targetId,
    targetRoleIds: null,
    method: 'reaction',
  });
  if (!targetRoles.ok) return refuse(targetRoles.message);

  const targetCheck = validateTarget(ctx.config, {
    reporterId: reaction.userId,
    targetId,
    targetBot: author?.bot ?? false,
    targetRoleIds: targetRoles.roleIds,
  });
  if (!targetCheck.ok) return refuse(targetCheck.message);

  if (!deps.reports) return refuse(REPORT_STORE_UNBOUND);

  const message = read?.ok
    ? capturedMessage(read.message, ctx.guildId, 'rest')
    : unavailableMessage(read, { channelId: reaction.channelId, messageId: reaction.messageId });
  const source = {
    channelId: reaction.channelId,
    messageId: reaction.messageId,
    authorId: targetId,
  };

  const configured = reports.reaction.reasonId;
  const reasonId =
    configured !== null && reports.reasons.some((reason) => reason.id === configured)
      ? configured
      : null;
  const asks = missingParts(reports, reasonId);

  if (asks.length === 0) {
    const outcome = await submitReport(ctx, deps, {
      guildId: ctx.guildId,
      method: 'reaction',
      reporter: { id: reaction.userId, roleIds: reporterRoleIds },
      targetId,
      reasonId,
      customReason: null,
      comment: null,
      source,
      evidence: { message, links: [], attachments: [] },
      idempotencyKey: root,
      now,
    });

    if (outcome.status === 'refused') return refuse(outcome.message);

    if (!reports.notifications.submitted.enabled) {
      await tell(
        `You flagged a message by <@${targetId}> in ${server}. ${outcome.message}`,
        'success',
      );
    }

    return {
      action: 'filed',
      reportId: outcome.report.id,
      existing: outcome.status === 'existing',
    };
  }

  const drafts = deps.drafts;
  if (!drafts) return refuse(DRAFTS_UNBOUND);

  const draftId = newDraftId();
  const draft: IntakeDraft = {
    kind: 'report',
    guildId: ctx.guildId,
    actorId: reaction.userId,
    method: 'reaction',
    targetId,
    targetName: author?.username ?? (await deps.users?.resolve(targetId))?.username ?? null,
    targetBot: false,
    targetRoleIds: targetRoles.roleIds,
    source,
    message,
    messageLink: null,
    attachment: null,
    reasonId,
    answers: null,
    filedReportId: null,
    createdAt: now,
  };

  await drafts.put(ctx.guildId, draftId, draft, REACTION_DRAFT_TTL_MS);

  const button = finishButton(ctx.guildId, draftId);
  if (!button) return refuse('I couldn’t build the report form, so nothing was filed.');

  const needs = joinAsks(asks);
  const dm = await sendDirect(ctx, deps, {
    userId: reaction.userId,
    root,
    message: {
      content:
        `You flagged a message by <@${targetId}> in ${server}. This server asks for ${needs} ` +
        'with every report, so press **Finish report** to add it. The button works for an hour, ' +
        'and nothing is filed until you finish.',
      components: [button],
    },
  });

  if (dm === 'sent') return { action: 'prompted', via: 'dm' };

  if (!reports.reaction.channelFallback) {
    ctx.logger.info(
      `${reaction.userId} flagged a message for a report, but Proton could not DM them the ` +
        'Finish report button and the channel fallback is off, so nothing was filed.',
      logContext,
    );
    return { action: 'undelivered' };
  }

  return postPrompt(ctx, deps, { reaction, root, button, needs, now, logContext });
}

async function postPrompt(
  ctx: ModuleContext<ModerationConfig>,
  deps: ModerationDeps,
  input: {
    reaction: ReportReaction;
    root: string;
    button: Record<string, unknown>;
    needs: string;
    now: number;
    logContext: Record<string, unknown>;
  },
): Promise<ReactionReportOutcome> {
  const { reaction } = input;

  const posted = await ctx.executor.execute({
    guildId: ctx.guildId,
    moduleId: MODULE_ID,
    kind: 'send',
    actorId: REPORTS_ACTOR,
    targetId: reaction.userId,
    idempotencyKey: `${input.root}:prompt`,
    dryRun: false,
    record: false,
    payload: {
      channelId: reaction.channelId,
      content:
        `<@${reaction.userId}> you flagged a message here. This server asks for ${input.needs} ` +
        'with every report, so press **Finish report** to add it. Only you can use the button, ' +
        'and this message disappears in 2 minutes.',
      components: [input.button],
      allowedMentions: { parse: [], users: [reaction.userId] },
    },
  });

  if (posted.status === 'skipped_duplicate') return { action: 'prompted', via: 'channel' };

  const promptId = idOf(posted);
  if (!promptId) {
    ctx.logger.warn(
      `${reaction.userId} flagged a message for a report, but Proton could neither DM them nor ` +
        `post the Finish report prompt in <#${reaction.channelId}>, so nothing was filed: ` +
        `${posted.failure?.humanReason ?? 'Discord gave no reason.'}`,
      { ...input.logContext, code: posted.failure?.code },
    );
    return { action: 'undelivered' };
  }

  const dueAt = input.now + PROMPT_TTL_MS;
  await deps.prompts?.record(ctx.guildId, reaction.channelId, promptId, dueAt);

  if (ctx.schedule) {
    await ctx.schedule(PROMPT_CLEANUP_JOB, new Date(dueAt), promptId, {
      channelId: reaction.channelId,
      messageId: promptId,
    });
  } else {
    ctx.logger.warn(
      `the Finish report prompt in <#${reaction.channelId}> could not be booked for removal; ` +
        'the reports patrol will delete it.',
      input.logContext,
    );
  }

  return { action: 'prompted', via: 'channel' };
}

export const promptCleanupSchema = z.object({
  channelId: snowflakeSchema,
  messageId: snowflakeSchema,
});

export type PromptCleanup = z.infer<typeof promptCleanupSchema>;

const TRANSIENT = /^discord_(429|5\d\d)$/;

export async function deletePrompt(
  ctx: ModuleContext<ModerationConfig>,
  deps: ModerationDeps,
  prompt: PromptCleanup,
): Promise<'deleted' | 'failed'> {
  const result = await ctx.executor.execute({
    guildId: ctx.guildId,
    moduleId: MODULE_ID,
    kind: 'delete_message',
    actorId: REPORTS_ACTOR,
    idempotencyKey: `moderation:report:prompt:${prompt.messageId}:delete`,
    dryRun: false,
    record: false,
    payload: { channelId: prompt.channelId, messageId: prompt.messageId },
  });

  const code = result.failure?.code ?? '';

  if (result.status === 'failed_api' && TRANSIENT.test(code)) {
    throw new Error(
      `the Finish report prompt ${prompt.messageId} could not be deleted yet: ` +
        `${result.failure?.humanReason ?? code}`,
    );
  }

  await deps.prompts?.remove(ctx.guildId, prompt.channelId, prompt.messageId);

  if (
    result.status === 'executed' ||
    result.status === 'skipped_duplicate' ||
    code === 'discord_404'
  ) {
    return 'deleted';
  }

  ctx.logger.warn(
    `Proton couldn't delete the Finish report prompt in <#${prompt.channelId}>, so it stays in ` +
      `the channel: ${result.failure?.humanReason ?? 'Discord gave no reason.'}`,
    { guildId: ctx.guildId, moduleId: MODULE_ID, channelId: prompt.channelId, code },
  );
  return 'failed';
}

export function createPromptCleanupHandler(
  deps: ModerationDeps,
): ScheduledHandler<ModerationConfig> {
  return async (data, ctx) => {
    if (!ctx.config.enabled) return;

    const parsed = promptCleanupSchema.safeParse(data);
    if (!parsed.success) {
      ctx.logger.error('a Finish report prompt cleanup job carried no usable message id.', {
        guildId: ctx.guildId,
        moduleId: MODULE_ID,
      });
      return;
    }

    await deletePrompt(ctx, deps, parsed.data);
  };
}
