import type { StarboardConfig } from './config.ts';
import { type EmojiRef, rawStarCount, type SourceMessage } from './source.ts';

/**
 * Everything the starboard decides, with nothing to decide it against.
 *
 * The module's whole correctness argument lives in this file: reactions carry no
 * id of their own (see the MESSAGE_REACTION_ADD arm of the gateway normaliser),
 * so an event is a trigger and never a datum, and the count is recomputed from
 * the message every time. That makes the decision a pure function of
 * `(current count, threshold, what we already posted)` — testable exhaustively
 * without Redis, Postgres or Discord, which is the point.
 */

export const INELIGIBLE_REASONS = [
  /** The message is itself a board post. Starring it would loop forever. */
  'board_channel',
  /** The guild listed source channels and this is not one of them. */
  'not_a_source_channel',
  'bot_author',
  'nsfw_channel',
] as const;

export type IneligibleReason = (typeof INELIGIBLE_REASONS)[number];

export type Eligibility = { eligible: true } | { eligible: false; reason: IneligibleReason };

/**
 * Whether this message may ever reach the board.
 *
 * Ordered so the loop guard comes first: it is the one whose failure is
 * unbounded rather than merely wrong. Everything below it is a guild's taste.
 *
 * A message that becomes ineligible *after* it was posted — an admin turning on
 * `ignoreBots`, or moving the board — is deliberately left alone rather than
 * retracted. Nothing here knows whether the guild wants a purge, and quietly
 * deleting a channel's worth of board posts on a settings save is not a decision
 * a config toggle should be able to make.
 */
export function eligibility(
  message: SourceMessage,
  config: StarboardConfig,
  boardChannelId: string,
): Eligibility {
  if (message.channelId === boardChannelId) {
    return { eligible: false, reason: 'board_channel' };
  }

  if (config.sourceChannelIds.length > 0 && !config.sourceChannelIds.includes(message.channelId)) {
    return { eligible: false, reason: 'not_a_source_channel' };
  }

  if (config.ignoreBots && message.authorBot) {
    return { eligible: false, reason: 'bot_author' };
  }

  if (config.ignoreNsfw && message.channelNsfw) {
    return { eligible: false, reason: 'nsfw_channel' };
  }

  return { eligible: true };
}

export interface StarCount {
  /** What the threshold is compared against, and what the board post displays. */
  count: number;
  /** The reaction count as Discord reports it, before the self-star rule. */
  total: number;
  /**
   * The guild bars self-stars and the reactor list was not supplied, so the
   * author's own star — if they cast one — is being counted anyway.
   *
   * Surfaced rather than silently tolerated: an off-by-one threshold that
   * nothing mentions is precisely the "the bot did nothing I asked" failure §1
   * exists to eliminate.
   */
  selfStarUnresolved: boolean;
}

/**
 * How many stars count.
 *
 * The subtraction is capped at zero rather than trusted: `starredBy` and
 * `reactions[].count` are two reads of a live message and can disagree by one
 * when a reaction lands between them.
 */
export function countStars(
  message: SourceMessage,
  config: StarboardConfig,
  configured: EmojiRef,
): StarCount {
  const total = rawStarCount(message, configured);
  if (config.selfStarAllowed) return { count: total, total, selfStarUnresolved: false };

  if (message.starredBy === null) {
    return { count: total, total, selfStarUnresolved: total > 0 };
  }

  const selfStarred = message.starredBy.includes(message.authorId);
  return {
    count: selfStarred ? Math.max(0, total - 1) : total,
    total,
    selfStarUnresolved: false,
  };
}

/** What the board already holds for this message, if anything. */
export interface BoardPost {
  boardMessageId: string;
  /** The count the post currently displays, so an unchanged count costs no edit. */
  starCount: number;
}

export interface StarboardState {
  count: number;
  threshold: number;
  post: BoardPost | null;
}

export type StarboardDecision =
  | { action: 'create'; count: number }
  | { action: 'edit'; boardMessageId: string; count: number }
  | { action: 'delete'; boardMessageId: string }
  | { action: 'none'; reason: 'below_threshold' | 'unchanged' };

/**
 * The state machine, in full.
 *
 * Four transitions and nothing else, which is what makes the concurrency story
 * work: two reactions arriving together both recompute the same count from the
 * same message and reach the same decision, so the only thing that has to be
 * made effectively-once is the *create* — and that is done with an idempotency
 * key derived from the message rather than the event (I4). See `listener.ts`.
 */
export function decide(state: StarboardState): StarboardDecision {
  const { count, threshold, post } = state;

  if (count >= threshold) {
    if (post === null) return { action: 'create', count };
    if (post.starCount === count) return { action: 'none', reason: 'unchanged' };
    return { action: 'edit', boardMessageId: post.boardMessageId, count };
  }

  if (post !== null) return { action: 'delete', boardMessageId: post.boardMessageId };
  return { action: 'none', reason: 'below_threshold' };
}
