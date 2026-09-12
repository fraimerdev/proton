import { parseComponentEmoji } from '@proton/core';
import type { ReactElement } from 'react';

/**
 * Verified against docs.discord.com/developers/reference: `emojis/{id}.{ext}` on the CDN, sized to
 * a power of two. WebP because Discord's own guidance is to prefer it, and `animated=true` because
 * without it an animated emoji is served as a still first frame.
 */
export function emojiImageUrl(id: string, animated: boolean, size: 32 | 64 | 128 = 64): string {
  const animation = animated ? '&animated=true' : '';

  return `https://cdn.discordapp.com/emojis/${id}.webp?size=${size}${animation}`;
}

/**
 * One stored emoji string drawn as itself. Custom emoji were previously printed as `:name:` all the
 * way into the message preview, because nothing in the dashboard knew the CDN URL.
 */
export function EmojiGlyph({
  value,
  size = 20,
}: {
  value: string;
  size?: number;
}): ReactElement | null {
  const parsed = parseComponentEmoji(value);
  if (!parsed) return null;

  if (parsed.id) {
    return (
      <img
        className="emoji-image"
        src={emojiImageUrl(parsed.id, parsed.animated === true, size > 32 ? 128 : 64)}
        alt={parsed.name ? `:${parsed.name}:` : 'Custom emoji'}
        width={size}
        height={size}
        loading="lazy"
        decoding="async"
      />
    );
  }

  // A unicode emoji is text, and sizing it with font-size rather than width keeps it on the
  // baseline of whatever it sits beside.
  return (
    <span className="emoji-char" style={{ fontSize: `${size}px` }}>
      {parsed.name}
    </span>
  );
}
