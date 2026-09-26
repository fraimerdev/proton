import type { ReactElement, ReactNode } from 'react';
import { DiscordMarkdown, InlineDiscordMarkdown, type MentionNames } from './markdown.tsx';

export interface MemberMessageEmbed {
  title: string | null;
  description: string | null;
  url: string | null;
}

function Avatar({ name, url }: { name: string; url: string | null }): ReactElement {
  if (url) return <img className="dc-avatar" src={url} alt="" />;

  return (
    <span className="dc-avatar dc-avatar-initial" aria-hidden>
      {[...name].slice(0, 1).join('').toUpperCase()}
    </span>
  );
}

export function MemberMessage({
  author,
  avatarUrl,
  bot = false,
  timestamp,
  content,
  edited = false,
  embeds = [],
  stickers = [],
  forwarded = false,
  forwardedContent = null,
  mentionNames,
  now,
  empty = 'This message has no text.',
  footer,
}: {
  author: string;
  avatarUrl: string | null;
  bot?: boolean | undefined;
  timestamp?: string | undefined;
  content: string;
  edited?: boolean | undefined;
  embeds?: readonly MemberMessageEmbed[] | undefined;
  stickers?: readonly string[] | undefined;
  forwarded?: boolean | undefined;
  forwardedContent?: string | null | undefined;
  mentionNames?: MentionNames | undefined;
  now?: number | undefined;
  empty?: ReactNode;
  footer?: ReactNode;
}): ReactElement {
  const context = { mentionNames, now };
  const shownEmbeds = embeds.filter((embed) => embed.title || embed.description);
  const hasText = content.trim() !== '';

  const nothing =
    !hasText && !forwarded && shownEmbeds.length === 0 && stickers.length === 0 && !footer;

  return (
    <div className="dc">
      <div className="dc-message">
        <Avatar name={author} url={avatarUrl} />

        <div className="dc-body">
          <div className="dc-head">
            <span className="dc-author">{author}</span>
            {bot ? <span className="dc-bot-tag dc-bot-tag-plain">App</span> : null}
            {timestamp ? <span className="dc-timestamp">{timestamp}</span> : null}
          </div>

          {forwarded ? (
            <div className="dc-forward">
              <span className="dc-forward-label">Forwarded</span>
              {forwardedContent ? (
                <div className="dc-content">
                  <DiscordMarkdown text={forwardedContent} {...context} />
                </div>
              ) : null}
            </div>
          ) : null}

          {hasText ? (
            <div className="dc-content">
              <DiscordMarkdown text={content} {...context} />
              {edited ? <span className="dc-edited">(edited)</span> : null}
            </div>
          ) : null}

          {shownEmbeds.map((embed, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: a captured embed has no id of its own
            <div className="dc-embed" key={index}>
              <div className="dc-embed-main">
                {embed.title ? (
                  <div className={embed.url ? 'dc-embed-title linked' : 'dc-embed-title'}>
                    <InlineDiscordMarkdown text={embed.title} />
                  </div>
                ) : null}
                {embed.description ? (
                  <div className="dc-embed-description">
                    <DiscordMarkdown text={embed.description} {...context} />
                  </div>
                ) : null}
              </div>
            </div>
          ))}

          {stickers.map((sticker) => (
            <div className="dc-small" key={sticker}>
              Sticker: {sticker}
            </div>
          ))}

          {nothing ? <div className="dc-small">{empty}</div> : null}

          {footer}
        </div>
      </div>
    </div>
  );
}
