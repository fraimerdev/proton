import type { StarboardConfig } from './config.ts';
import { type EmojiRef, rawStarCount, type SourceMessage } from './source.ts';

export const INELIGIBLE_REASONS = [
  'board_channel',

  'not_a_source_channel',
  'bot_author',
  'nsfw_channel',
] as const;

export type IneligibleReason = (typeof INELIGIBLE_REASONS)[number];

export type Eligibility = { eligible: true } | { eligible: false; reason: IneligibleReason };

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
  count: number;

  total: number;

  selfStarUnresolved: boolean;
}

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

export interface BoardPost {
  boardMessageId: string;

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
