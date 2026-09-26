import {
  type ActionResult,
  type EventListener,
  type EventType,
  type ModuleContext,
  type ProtonEvent,
  starboardMessagePostedSchema,
} from '@proton/core';
import type { StarboardConfig } from './config.ts';
import { countStars, decide, eligibility, type StarboardDecision } from './decide.ts';
import { type BoundStarboardDeps, bindDeps, describeUnbound, type StarboardDeps } from './deps.ts';
import { buildBoardMessage } from './embed.ts';
import {
  type EmojiRef,
  emojiRestForm,
  parseEmoji,
  readReaction,
  type SourceMessage,
  sameEmoji,
} from './source.ts';

export const MODULE_ID = 'starboard';

export const STARBOARD_EVENT_TYPES: EventType[] = ['reaction.added', 'reaction.removed'];

export const STARBOARD_EMITS: EventType[] = ['starboard.message_posted'];

export function createStarboardListener(deps: StarboardDeps): EventListener<StarboardConfig> {
  return {
    types: STARBOARD_EVENT_TYPES,

    async handler(event, ctx) {
      if (!ctx.config.enabled) return;

      if (event.guildId === null) return;

      const reaction = readReaction(event.payload);
      if (reaction === null) return;

      const configured = parseEmoji(ctx.config.emoji);
      if (!sameEmoji(reaction.emoji, configured)) return;

      const boardChannelId = ctx.config.boardChannelId;
      if (!boardChannelId) {
        ctx.logger.error(
          'The starboard is enabled in this server but has no board channel, so a starred ' +
            'message had nowhere to go. Set Board channel in the Proton dashboard.',
          { guildId: ctx.guildId, moduleId: MODULE_ID },
        );
        return;
      }

      if (reaction.channelId === boardChannelId) return;

      const sources = ctx.config.sourceChannelIds;
      if (sources.length > 0 && !sources.includes(reaction.channelId)) return;

      const bound = bindDeps(deps);
      if ('unbound' in bound) {
        ctx.logger.error(describeUnbound(bound.unbound), {
          guildId: ctx.guildId,
          moduleId: MODULE_ID,
        });
        return;
      }

      const message = await bound.deps.readMessage({
        channelId: reaction.channelId,
        messageId: reaction.messageId,
        emoji: emojiRestForm(configured),

        withReactors: !ctx.config.selfStarAllowed,
      });

      if (message === null) {
        ctx.logger.error(
          `The starboard could not read message ${reaction.messageId} in ` +
            `<#${reaction.channelId}>, so its stars were not counted. Either it was deleted, ` +
            'or Proton is missing ViewChannel or ReadMessageHistory in that channel.',
          { guildId: ctx.guildId, moduleId: MODULE_ID, channelId: reaction.channelId },
        );
        return;
      }

      const check = eligibility(message, ctx.config, boardChannelId);
      if (!check.eligible) return;

      const stars = countStars(message, ctx.config, configured);
      const post = await bound.deps.store.get(ctx.guildId, message.id);
      const decision = decide({
        count: stars.count,
        threshold: ctx.config.threshold,
        post:
          post === null ? null : { boardMessageId: post.boardMessageId, starCount: post.starCount },
      });

      const input: ApplyInput = {
        ctx,
        event,
        deps: bound.deps,
        message,
        configured,
        boardChannelId,
        selfStarUnresolved: stars.selfStarUnresolved,
      };

      await apply(decision, input);

      // The row is stamped with its creating event's occurredAt, so this is that event redelivered.
      if (post !== null && post.createdAt.getTime() === event.occurredAt) {
        await announcePosted(input, post.boardMessageId, post.starCount);
      }
    },
  };
}

interface ApplyInput {
  ctx: ModuleContext<StarboardConfig>;
  event: ProtonEvent;
  deps: BoundStarboardDeps;
  message: SourceMessage;
  configured: EmojiRef;
  boardChannelId: string;
  selfStarUnresolved: boolean;
}

async function apply(decision: StarboardDecision, input: ApplyInput): Promise<void> {
  switch (decision.action) {
    case 'create':
      await create(decision.count, input);
      return;
    case 'edit':
      await edit(decision.boardMessageId, decision.fromCount, decision.count, input);
      return;
    case 'delete':
      await remove(decision.boardMessageId, input);
      return;
    case 'none':
      return;
  }
}

async function create(count: number, input: ApplyInput): Promise<void> {
  const { ctx, deps, message, configured, boardChannelId } = input;

  if (input.selfStarUnresolved) {
    ctx.logger.error(
      'This server does not count self-stars, but the reactor list was not resolved, so the ' +
        "author's own star may have counted toward the threshold. The process running " +
        'modules must honour SourceMessageRequest.withReactors in its readMessage port.',
      { guildId: ctx.guildId, moduleId: MODULE_ID, messageId: message.id },
    );
  }

  const board = buildBoardMessage({ guildId: ctx.guildId, message, count, emoji: configured });

  const result = await ctx.executor.execute({
    guildId: ctx.guildId,
    moduleId: MODULE_ID,
    kind: 'send',
    actorId: MODULE_ID,
    reason: `Starred by ${count} members`,
    dryRun: false,
    idempotencyKey: createKey(ctx.guildId, message.id),
    payload: { channelId: boardChannelId, ...board },
  });

  if (failed(result)) {
    reportFailure(ctx, `post ${message.id} to <#${boardChannelId}>`, result);
    return;
  }

  if (result.status === 'skipped_duplicate') {
    ctx.logger.warn(
      `The starboard sent, or is still sending, a board post for ${message.id} to ` +
        `<#${boardChannelId}> in the last day and has no record of it, so it did not send ` +
        'another. If that post has since been taken down, by a moderator or because its stars ' +
        'fell below the threshold, the message cannot go back on the board until a day after ' +
        'the post was sent.',
      { guildId: ctx.guildId, moduleId: MODULE_ID, messageId: message.id },
    );
    return;
  }

  const boardMessageId = sentMessageId(result);

  if (boardMessageId === null) {
    ctx.logger.error(
      `The starboard posted ${message.id} to <#${boardChannelId}> but Discord's reply carried no ` +
        'message id, so the starboard cannot track that post: its star count will not update, ' +
        'and it will not be taken down if its stars fall below the threshold.',
      { guildId: ctx.guildId, moduleId: MODULE_ID, messageId: message.id },
    );
    return;
  }

  const recorded = await deps.store.record({
    guildId: ctx.guildId,
    sourceMessageId: message.id,
    boardMessageId,
    starCount: count,
    createdAt: new Date(input.event.occurredAt),
  });

  const post = recorded
    ? { boardMessageId, starCount: count }
    : await deps.store.get(ctx.guildId, message.id);

  if (post !== null) await announcePosted(input, post.boardMessageId, post.starCount);
}

async function announcePosted(
  input: ApplyInput,
  boardMessageId: string,
  starCount: number,
): Promise<void> {
  const { ctx, event, message } = input;
  if (!ctx.publish) return;

  try {
    const payload = starboardMessagePostedSchema.parse({
      guildId: ctx.guildId,
      sourceMessageId: message.id,
      sourceChannelId: message.channelId,
      authorId: message.authorId,
      authorBot: message.authorBot,
      boardMessageId,
      starCount,
      activityAt: event.occurredAt,
    });

    await ctx.publish('starboard.message_posted', postedKey(message.id, boardMessageId), payload);
  } catch (error) {
    ctx.logger.error(
      `The starboard put ${message.id} on the board but could not tell other modules, so ` +
        `Achievements will not count it: ${error instanceof Error ? error.message : String(error)}`,
      { guildId: ctx.guildId, moduleId: MODULE_ID, messageId: message.id, boardMessageId },
    );
  }
}

export function postedKey(sourceMessageId: string, boardMessageId: string): string {
  return `${sourceMessageId}:${boardMessageId}`;
}

async function edit(
  boardMessageId: string,
  fromCount: number,
  count: number,
  input: ApplyInput,
): Promise<void> {
  const { ctx, deps, message, configured, boardChannelId } = input;

  const board = buildBoardMessage({ guildId: ctx.guildId, message, count, emoji: configured });

  const result = await ctx.executor.execute({
    guildId: ctx.guildId,
    moduleId: MODULE_ID,
    kind: 'edit_message',
    actorId: MODULE_ID,
    dryRun: false,
    // The counts make a skip mean this event already moved the board to this count, so saving it is right.
    idempotencyKey: `${MODULE_ID}:${ctx.guildId}:${input.event.id}:edit:${fromCount}:${count}`,
    payload: { channelId: boardChannelId, messageId: boardMessageId, ...board },
  });

  if (failed(result)) {
    if (isGone(result)) {
      await forgetVanishedPost(boardMessageId, input);
      return;
    }
    reportFailure(ctx, `update the board post for ${message.id}`, result);
    return;
  }

  await deps.store.setCount(ctx.guildId, message.id, count);
}

async function remove(boardMessageId: string, input: ApplyInput): Promise<void> {
  const { ctx, deps, message, boardChannelId } = input;

  const result = await ctx.executor.execute({
    guildId: ctx.guildId,
    moduleId: MODULE_ID,
    kind: 'delete_message',
    actorId: MODULE_ID,
    reason: 'Fell below the star threshold',

    dryRun: false,

    idempotencyKey: `${MODULE_ID}:${ctx.guildId}:${message.id}:delete:${boardMessageId}`,
    payload: { channelId: boardChannelId, messageId: boardMessageId },
  });

  if (failed(result) && !isGone(result)) {
    reportFailure(ctx, `remove the board post for ${message.id}`, result);
    return;
  }

  await deps.store.remove(ctx.guildId, message.id);
}

async function forgetVanishedPost(boardMessageId: string, input: ApplyInput): Promise<void> {
  const { ctx, deps, message } = input;

  ctx.logger.warn(
    `The board post for ${message.id} is gone from <#${input.boardChannelId}>, so the ` +
      'starboard has forgotten it.',
    { guildId: ctx.guildId, moduleId: MODULE_ID, boardMessageId },
  );

  await deps.store.remove(ctx.guildId, message.id);
}

export function createKey(guildId: string, sourceMessageId: string): string {
  return `${MODULE_ID}:${guildId}:${sourceMessageId}:create`;
}

function sentMessageId(result: ActionResult): string | null {
  const body = result.body;
  if (typeof body !== 'object' || body === null) return null;
  const id = (body as { id?: unknown }).id;
  return typeof id === 'string' ? id : null;
}

function failed(result: ActionResult): boolean {
  return result.status === 'failed_precheck' || result.status === 'failed_api';
}

function isGone(result: ActionResult): boolean {
  return result.failure?.code === 'discord_404';
}

function reportFailure(
  ctx: ModuleContext<StarboardConfig>,
  attempt: string,
  result: ActionResult,
): void {
  ctx.logger.error(
    `The starboard could not ${attempt}: ${result.failure?.humanReason ?? 'no reason was reported'}`,
    { guildId: ctx.guildId, moduleId: MODULE_ID, code: result.failure?.code },
  );
}
