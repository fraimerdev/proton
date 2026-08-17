export const STEM_FALLBACK = '├';
export const REPLY_FALLBACK = '└';

export const STEM_NAME = 'stem';
export const REPLY_NAME = 'reply';

export interface EmojiSet {
  stem: string;
  reply: string;
}

export const DEFAULT_EMOJIS: EmojiSet = { stem: STEM_FALLBACK, reply: REPLY_FALLBACK };

export interface EmojiIds {
  stemId?: string | undefined;
  replyId?: string | undefined;
}

export function emojiSet(ids: EmojiIds = {}): EmojiSet {
  return {
    stem: ids.stemId ? `<:${STEM_NAME}:${ids.stemId}>` : STEM_FALLBACK,
    reply: ids.replyId ? `<:${REPLY_NAME}:${ids.replyId}>` : REPLY_FALLBACK,
  };
}
