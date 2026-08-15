import {
  type ActionResult,
  dryRunFor,
  type EventListener,
  type EventType,
  type ModuleContext,
  type ProtonEvent,
} from '@proton/core';
import type { StarboardConfig } from './config.ts';
import { countStars, decide, eligibility, type StarboardDecision } from './decide.ts';
import { type BoundStarboardDeps, bindDeps, describeUnbound, type StarboardDeps } from './deps.ts';
import { buildBoardMessage, jumpUrl } from './embed.ts';
import {
  type EmojiRef,
  emojiRestForm,
  parseEmoji,
  readReaction,
  type SourceMessage,
  sameEmoji,
} from './source.ts';

export const MODULE_ID = 'starboard';

/**
 * Adds and removes are handled by the same code path, because the handler does
 * not care which one happened: it re-reads the message and counts what is
 * actually on it. That is the whole design (see `decide.ts`), and it is why
 * there is no `if (event.type === 'reaction.added')` anywhere below.
 */
export const STARBOARD_EVENT_TYPES: EventType[] = ['reaction.added', 'reaction.removed'];

/**
 * The starboard listener.
 *
 * Unlike `phishing`, which swallows every failure so a blocklist outage cannot
 * become a message-processing outage, this handler lets an unexpected failure
 * propagate. `ModuleListenerRuntime` gives every module its own consumer group,
 * so a throw here redelivers this event to this module and nobody else — and a
 * redelivered reaction is precisely what this module is built to survive, since
 * it recomputes the count from the message instead of accumulating. A swallowed
 * store failure, by contrast, would leave a board post that exists on Discord
 * and in no table, which nothing later repairs.
 *
 * What does *not* throw is anything that will say the same thing on every
 * retry — an unconfigured board channel, an unbound port, a message that has
 * been deleted. Those are logged by name and dropped.
 */
export function createStarboardListener(deps: StarboardDeps): EventListener<StarboardConfig> {
  return {
    types: STARBOARD_EVENT_TYPES,

    async handler(event, ctx) {
      if (!ctx.config.enabled) return;
      // A reaction in a DM has no guild, no board channel and no config.
      if (event.guildId === null) return;

      const reaction = readReaction(event.payload);
      if (reaction === null) return;

      // Cheapest possible gate, and by far the most common outcome: a server
      // uses dozens of emoji and one of them is the star. Everything below this
      // line costs at least one REST read, so nothing below runs for a 👍.
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

      /**
       * Loop prevention, before anything is read.
       *
       * A board post is a message like any other, so members star it — and a
       * starboard that stars its own board posts republishes them, stars those,
       * and does not stop. Checked again from the message itself in
       * `eligibility`, because that is where it can be tested; this copy is here
       * only to spend no REST call on it.
       */
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
        // Asked for only when the guild bars self-stars: it is a second REST
        // call, and every other guild's answer would go unread. See
        // `SourceMessageRequest`.
        withReactors: !ctx.config.selfStarAllowed,
      });

      if (message === null) {
        // Deliberately not "zero stars". Treating an unreadable message as zero
        // would delete the board post of every message Proton momentarily could
        // not fetch — including every message in a channel where VIEW_CHANNEL or
        // READ_MESSAGE_HISTORY was just revoked.
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

      await apply(decision, {
        ctx,
        event,
        deps: bound.deps,
        message,
        configured,
        boardChannelId,
        selfStarUnresolved: stars.selfStarUnresolved,
      });
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
      await edit(decision.boardMessageId, decision.count, input);
      return;
    case 'delete':
      await remove(decision.boardMessageId, input);
      return;
    case 'none':
      return;
  }
}

/**
 * Post the message to the board, then find out what id it got.
 *
 * **The idempotency key is derived from the message, not the event.** Two
 * members starring at the same instant produce two reaction events with two
 * different ids — the normaliser derives a reaction's id from
 * `(channel, message, user, emoji)`, and those differ by user — so two handlers
 * recompute the same count, both find no board post, and both decide to create
 * one. Keyed on the event, that is two board posts for one message. Keyed on
 * `(guild, source message, 'create')`, the executor's dedupe makes the send
 * effectively-once without this module holding a lock (I4).
 *
 * The consequence is that `skipped_duplicate` here does **not** mean "nothing to
 * do". Reaching this branch at all means no row exists, so a duplicate claim
 * means the post was sent and never recorded — a crash between the two, or the
 * other half of the race above. Both are repaired the same way: look the post up
 * and record it.
 */
async function create(count: number, input: ApplyInput): Promise<void> {
  const { ctx, deps, message, configured, boardChannelId } = input;

  if (input.selfStarUnresolved) {
    // Bounded to once per board post rather than once per star: a starboard is
    // pointed at busy channels, and one line per reaction is not observability.
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
    dryRun: dryRunFor('send'),
    idempotencyKey: createKey(ctx.guildId, message.id),
    payload: { channelId: boardChannelId, ...board },
  });

  if (failed(result)) {
    reportFailure(ctx, `post ${message.id} to <#${boardChannelId}>`, result);
    return;
  }

  const link = jumpUrl(ctx.guildId, message.channelId, message.id);
  const boardMessageId = await deps.resolveBoardPost({
    boardChannelId,
    sourceMessageId: message.id,
    jumpUrl: link,
  });

  if (boardMessageId === null) {
    // No row is written, so the next star recomputes and lands here again. The
    // send is already claimed, so that retry costs a deduped no-op rather than a
    // second post — which is what makes leaving this unrecorded safe.
    ctx.logger.error(
      `The starboard posted ${message.id} to <#${boardChannelId}> but could not find that ` +
        'post again, so its star count will not update yet. It is retried on the next star.',
      { guildId: ctx.guildId, moduleId: MODULE_ID, messageId: message.id },
    );
    return;
  }

  await deps.store.record({
    guildId: ctx.guildId,
    sourceMessageId: message.id,
    boardMessageId,
    starCount: count,
    createdAt: new Date(input.event.occurredAt),
  });
}

/** Update the count on a post that is already there. */
async function edit(boardMessageId: string, count: number, input: ApplyInput): Promise<void> {
  const { ctx, deps, message, configured, boardChannelId } = input;

  const board = buildBoardMessage({ guildId: ctx.guildId, message, count, emoji: configured });

  const result = await ctx.executor.execute({
    guildId: ctx.guildId,
    moduleId: MODULE_ID,
    kind: 'edit_message',
    actorId: MODULE_ID,
    dryRun: dryRunFor('edit_message'),
    // Keyed on the event, unlike the create. An edit is not effectively-once —
    // the count changes with every star — so a key that collapsed two different
    // edits would freeze the board post at whichever count arrived first.
    idempotencyKey: `${MODULE_ID}:${ctx.guildId}:${input.event.id}:edit`,
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

/** Take the post down again once the message falls back below the threshold. */
async function remove(boardMessageId: string, input: ApplyInput): Promise<void> {
  const { ctx, deps, message, boardChannelId } = input;

  const result = await ctx.executor.execute({
    guildId: ctx.guildId,
    moduleId: MODULE_ID,
    kind: 'delete_message',
    actorId: MODULE_ID,
    reason: 'Fell below the star threshold',
    // `delete_message` is deliberately not in DESTRUCTIVE_KINDS, so this runs for
    // real outside production — otherwise every development guild would collect
    // board posts that nothing ever cleans up. The policy is read from core
    // rather than restated, so it stays one decision.
    dryRun: dryRunFor('delete_message'),
    // Keyed on the board post rather than the event: two events that both drop
    // the message below the threshold should issue one delete, and a post
    // created again later has a different id, so this key does not block it.
    idempotencyKey: `${MODULE_ID}:${ctx.guildId}:${message.id}:delete:${boardMessageId}`,
    payload: { channelId: boardChannelId, messageId: boardMessageId },
  });

  if (failed(result) && !isGone(result)) {
    // Almost always MANAGE_MESSAGES, which is deliberately not a hard gate on
    // this module — see the manifest. The executor's precheck already named it,
    // so it is repeated verbatim rather than paraphrased (I8).
    reportFailure(ctx, `remove the board post for ${message.id}`, result);
    return;
  }

  await deps.store.remove(ctx.guildId, message.id);
}

/**
 * The board post is not there any more — a moderator tidied the channel by hand.
 *
 * The row goes, so the message is treated as never posted. It will not reappear
 * until the executor's idempotency claim on the create key expires, because that
 * claim outlives the post it was made for; a board post deleted by a human
 * staying deleted for a day is the better of the two wrong answers.
 */
async function forgetVanishedPost(boardMessageId: string, input: ApplyInput): Promise<void> {
  const { ctx, deps, message } = input;

  ctx.logger.warn(
    `The board post for ${message.id} is gone from <#${input.boardChannelId}>, so the ` +
      'starboard has forgotten it.',
    { guildId: ctx.guildId, moduleId: MODULE_ID, boardMessageId },
  );

  await deps.store.remove(ctx.guildId, message.id);
}

/** The idempotency key that makes the create effectively-once. See `create`. */
export function createKey(guildId: string, sourceMessageId: string): string {
  return `${MODULE_ID}:${guildId}:${sourceMessageId}:create`;
}

function failed(result: ActionResult): boolean {
  return result.status === 'failed_precheck' || result.status === 'failed_api';
}

/** Discord answered 404: whatever this action was about no longer exists. */
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
