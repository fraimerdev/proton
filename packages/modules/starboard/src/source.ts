export interface EmojiRef {
  id: string | null;
  name: string | null;
}

export interface StarReaction {
  channelId: string;
  messageId: string;
  userId: string;
  emoji: EmojiRef;
}

export interface SourceAttachment {
  url: string;
  filename: string;

  contentType: string | null;
}

export interface SourceReaction {
  emoji: EmojiRef;
  count: number;
}

export interface SourceMessage {
  id: string;
  channelId: string;
  authorId: string;
  authorBot: boolean;

  authorName: string;

  authorAvatarUrl: string | null;
  content: string;
  attachments: readonly SourceAttachment[];
  reactions: readonly SourceReaction[];

  channelNsfw: boolean;

  starredBy: readonly string[] | null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function readEmoji(value: unknown): EmojiRef | null {
  const raw = record(value);
  if (!raw) return null;

  const ref: EmojiRef = { id: str(raw.id), name: str(raw.name) };
  return ref.id === null && ref.name === null ? null : ref;
}

export function readReaction(payload: unknown): StarReaction | null {
  const raw = record(payload);
  if (!raw) return null;

  const channelId = str(raw.channel_id);
  const messageId = str(raw.message_id);
  const userId = str(raw.user_id);
  const emoji = readEmoji(raw.emoji);

  if (!channelId || !messageId || !userId || !emoji) return null;
  return { channelId, messageId, userId, emoji };
}

export function parseEmoji(value: string): EmojiRef {
  const trimmed = value.trim();

  const tagged = /^<a?:([^:]+):(\d{17,20})>$/.exec(trimmed);
  if (tagged) return { name: tagged[1] ?? null, id: tagged[2] ?? null };

  const pair = /^([^:]+):(\d{17,20})$/.exec(trimmed);
  if (pair) return { name: pair[1] ?? null, id: pair[2] ?? null };

  if (/^\d{17,20}$/.test(trimmed)) return { id: trimmed, name: null };

  return { id: null, name: trimmed };
}

export function sameEmoji(reaction: EmojiRef, configured: EmojiRef): boolean {
  if (reaction.id !== null && configured.id !== null) return reaction.id === configured.id;
  if (reaction.name !== null && configured.name !== null) return reaction.name === configured.name;
  return false;
}

export function emojiDisplay(emoji: EmojiRef): string {
  if (emoji.id !== null) return `<:${emoji.name ?? '_'}:${emoji.id}>`;
  return emoji.name ?? '';
}

export function emojiRestForm(emoji: EmojiRef): string {
  if (emoji.id !== null) return `${emoji.name ?? '_'}:${emoji.id}`;
  return emoji.name ?? '';
}

export function rawStarCount(message: SourceMessage, configured: EmojiRef): number {
  for (const reaction of message.reactions) {
    if (sameEmoji(reaction.emoji, configured)) return reaction.count;
  }
  return 0;
}

const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.webp'];

export function firstImage(attachments: readonly SourceAttachment[]): SourceAttachment | undefined {
  return attachments.find((attachment) => {
    if (attachment.contentType?.startsWith('image/')) return true;
    const name = attachment.filename.toLowerCase();
    return IMAGE_EXTENSIONS.some((extension) => name.endsWith(extension));
  });
}

function avatarUrl(userId: string, hash: string | null): string | null {
  if (hash === null) return null;
  const extension = hash.startsWith('a_') ? 'gif' : 'png';
  return `https://cdn.discordapp.com/avatars/${userId}/${hash}.${extension}?size=128`;
}

export interface SourceMessageExtras {
  channelNsfw: boolean;

  starredBy?: readonly string[] | null;
}

export function readSourceMessage(raw: unknown, extras: SourceMessageExtras): SourceMessage | null {
  const message = record(raw);
  if (!message) return null;

  const id = str(message.id);
  const channelId = str(message.channel_id);
  const author = record(message.author);
  const authorId = author ? str(author.id) : null;

  if (!id || !channelId || !author || !authorId) return null;

  const attachments = Array.isArray(message.attachments)
    ? message.attachments.flatMap((entry): SourceAttachment[] => {
        const attachment = record(entry);
        const url = attachment ? str(attachment.url) : null;
        if (!attachment || !url) return [];
        return [
          {
            url,
            filename: str(attachment.filename) ?? '',
            contentType: str(attachment.content_type),
          },
        ];
      })
    : [];

  const reactions = Array.isArray(message.reactions)
    ? message.reactions.flatMap((entry): SourceReaction[] => {
        const reaction = record(entry);
        const emoji = reaction ? readEmoji(reaction.emoji) : null;
        if (!reaction || !emoji || typeof reaction.count !== 'number') return [];
        return [{ emoji, count: reaction.count }];
      })
    : [];

  return {
    id,
    channelId,
    authorId,

    authorBot: author.bot === true || str(message.webhook_id) !== null,
    authorName: str(author.global_name) ?? str(author.username) ?? authorId,
    authorAvatarUrl: avatarUrl(authorId, str(author.avatar)),
    content: typeof message.content === 'string' ? message.content : '',
    attachments,
    reactions,
    channelNsfw: extras.channelNsfw,
    starredBy: extras.starredBy ?? null,
  };
}
