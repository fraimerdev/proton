import { snowflakeCreatedAt } from '@proton/core';
import { type EmojiRef, emojiDisplay, firstImage, type SourceMessage } from './source.ts';

/**
 * What a board post looks like.
 *
 * Built as plain objects because `send` and `edit_message` take `embeds` as
 * opaque JSON on purpose (`packages/core/src/actions/payloads.ts` says why):
 * modelling Discord's embed grammar in Zod would be a second source of truth for
 * a shape Discord already validates and changes on its own schedule.
 */

/** Discord's own star colour, so the board reads as one thing at a glance. */
export const STAR_COLOUR = 0xff_ac_33;

/** Embed description limit. Content past it is cut rather than rejected by Discord. */
export const DESCRIPTION_MAX = 4096;

/** The link every board post carries, and the key a board post is found again by. */
export function jumpUrl(guildId: string, channelId: string, messageId: string): string {
  return `https://discord.com/channels/${guildId}/${channelId}/${messageId}`;
}

export interface BoardMessage {
  content: string;
  embeds: Record<string, unknown>[];
}

export interface BoardMessageInput {
  guildId: string;
  message: SourceMessage;
  /** Stars that counted — not necessarily Discord's raw reaction count. */
  count: number;
  emoji: EmojiRef;
}

/**
 * The star line and the embed.
 *
 * The count lives in `content` rather than in the embed because that is the part
 * a member reads while scrolling, and because an edit that only changes the
 * count then changes one short string instead of re-sending the whole embed.
 *
 * Only the first image attachment is shown. A board post is a pointer to the
 * original, not a copy of it: reproducing five attachments would make the board
 * unreadable and would repost files the author may since have deleted.
 */
export function buildBoardMessage(input: BoardMessageInput): BoardMessage {
  const { guildId, message, count, emoji } = input;
  const link = jumpUrl(guildId, message.channelId, message.id);

  const embed: Record<string, unknown> = {
    color: STAR_COLOUR,
    author: {
      name: message.authorName.slice(0, 256),
      ...(message.authorAvatarUrl ? { icon_url: message.authorAvatarUrl } : {}),
    },
    // `url` is only rendered as a link when a `title` is present, so the two go
    // together — and `url` is what `boardPostMatches` keys on.
    title: 'Jump to message',
    url: link,
  };

  if (message.content.length > 0) {
    embed.description = message.content.slice(0, DESCRIPTION_MAX);
  }

  const image = firstImage(message.attachments);
  if (image) embed.image = { url: image.url };

  // Derived from the snowflake rather than carried on `SourceMessage`: a message
  // id already contains its creation time, so asking the binder for it as well
  // would be a second field that can disagree with the first.
  const createdAt = snowflakeCreatedAt(message.id);
  if (createdAt !== null) embed.timestamp = new Date(createdAt).toISOString();

  return {
    content: `${emojiDisplay(emoji)} **${count}** <#${message.channelId}>`,
    embeds: [embed],
  };
}

/**
 * Whether a raw Discord message is the board post for `link`.
 *
 * Exported for whoever binds `resolveBoardPost`. The id Discord assigns to a
 * board post is not something this module can learn from `ActionResult` — see
 * the note on `StarboardDeps.resolveBoardPost` — so the post has to be found
 * again, and the rule for recognising one belongs next to the code that builds
 * one rather than in the worker.
 */
export function boardPostMatches(rawMessage: unknown, link: string): boolean {
  if (typeof rawMessage !== 'object' || rawMessage === null) return false;
  const embeds = (rawMessage as { embeds?: unknown }).embeds;
  if (!Array.isArray(embeds)) return false;

  return embeds.some(
    (embed) =>
      typeof embed === 'object' && embed !== null && (embed as { url?: unknown }).url === link,
  );
}
