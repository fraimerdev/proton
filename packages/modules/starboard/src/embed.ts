import { snowflakeCreatedAt } from '@proton/core';
import { type EmojiRef, emojiDisplay, firstImage, type SourceMessage } from './source.ts';

export const STAR_COLOUR = 0xff_ac_33;

export const DESCRIPTION_MAX = 4096;

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

  count: number;
  emoji: EmojiRef;
}

export function buildBoardMessage(input: BoardMessageInput): BoardMessage {
  const { guildId, message, count, emoji } = input;
  const link = jumpUrl(guildId, message.channelId, message.id);

  const embed: Record<string, unknown> = {
    color: STAR_COLOUR,
    author: {
      name: message.authorName.slice(0, 256),
      ...(message.authorAvatarUrl ? { icon_url: message.authorAvatarUrl } : {}),
    },

    title: 'Jump to message',
    url: link,
  };

  if (message.content.length > 0) {
    embed.description = message.content.slice(0, DESCRIPTION_MAX);
  }

  const image = firstImage(message.attachments);
  if (image) embed.image = { url: image.url };

  const createdAt = snowflakeCreatedAt(message.id);
  if (createdAt !== null) embed.timestamp = new Date(createdAt).toISOString();

  return {
    content: `${emojiDisplay(emoji)} **${count}** <#${message.channelId}>`,
    embeds: [embed],
  };
}

export function boardPostMatches(rawMessage: unknown, link: string): boolean {
  if (typeof rawMessage !== 'object' || rawMessage === null) return false;
  const embeds = (rawMessage as { embeds?: unknown }).embeds;
  if (!Array.isArray(embeds)) return false;

  return embeds.some(
    (embed) =>
      typeof embed === 'object' && embed !== null && (embed as { url?: unknown }).url === link,
  );
}
