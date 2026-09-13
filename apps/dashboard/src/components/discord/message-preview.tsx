import type {
  ActionRow,
  ComponentEmoji,
  ContainerChild,
  Embed,
  MessageButton,
  MessageSelect,
  ProtonMessage,
  V2Component,
} from '@proton/core';
import type { ReactElement, ReactNode } from 'react';
import { Icon } from '../ui/icon.tsx';
import { DiscordMarkdown } from './markdown.tsx';

const BUTTON_CLASS: Record<string, string> = {
  primary: '',
  secondary: 'secondary',
  success: 'success',
  danger: 'danger',
  link: 'link',
};

function EmojiGlyph({ emoji }: { emoji: ComponentEmoji | undefined }): ReactElement | null {
  if (!emoji) return null;

  if (emoji.id) {
    return (
      <img
        className="dc-button-emoji"
        src={`https://cdn.discordapp.com/emojis/${emoji.id}.${emoji.animated ? 'gif' : 'webp'}?size=44`}
        alt=""
        style={{ width: 18, height: 18 }}
      />
    );
  }

  return <span className="dc-button-emoji">{emoji.name}</span>;
}

function colourOf(value: number | undefined): string {
  if (value === undefined) return 'var(--dc-grey)';
  return `#${value.toString(16).padStart(6, '0')}`;
}

function EmbedView({ embed }: { embed: Embed }): ReactElement | null {
  const empty =
    !embed.title &&
    !embed.description &&
    !embed.author &&
    !embed.footer &&
    !embed.imageUrl &&
    !embed.thumbnailUrl &&
    (embed.fields ?? []).length === 0;

  if (empty) return null;

  return (
    <div className="dc-embed" style={{ borderLeftColor: colourOf(embed.color) }}>
      <div className="dc-embed-main">
        {embed.author ? (
          <div className="dc-embed-author">
            {embed.author.iconUrl ? (
              <img className="dc-embed-author-icon" src={embed.author.iconUrl} alt="" />
            ) : null}
            <span>{embed.author.name}</span>
          </div>
        ) : null}

        {embed.title ? (
          <div className={embed.url ? 'dc-embed-title linked' : 'dc-embed-title'}>
            {embed.title}
          </div>
        ) : null}

        {embed.description ? (
          <div className="dc-embed-description">
            <DiscordMarkdown text={embed.description} />
          </div>
        ) : null}

        {(embed.fields ?? []).length > 0 ? (
          <div className="dc-embed-fields">
            {(embed.fields ?? []).map((field, index) => (
              <div
                // biome-ignore lint/suspicious/noArrayIndexKey: embed fields have no id of their own
                key={index}
                className={field.inline ? 'dc-embed-field inline' : 'dc-embed-field'}
              >
                <div className="dc-embed-field-name">{field.name}</div>
                <div className="dc-embed-field-value">
                  <DiscordMarkdown text={field.value} />
                </div>
              </div>
            ))}
          </div>
        ) : null}

        {embed.footer || embed.timestamp ? (
          <div className="dc-embed-footer">
            {embed.footer?.iconUrl ? (
              <img className="dc-embed-footer-icon" src={embed.footer.iconUrl} alt="" />
            ) : null}
            <span>
              {embed.footer?.text}
              {embed.footer?.text && embed.timestamp ? ' • ' : ''}
              {embed.timestamp
                ? embed.timestamp === 'now'
                  ? 'Today at 00:00'
                  : new Date(embed.timestamp).toLocaleString()
                : ''}
            </span>
          </div>
        ) : null}
      </div>

      {embed.thumbnailUrl ? (
        <img className="dc-embed-thumb" src={embed.thumbnailUrl} alt="" />
      ) : null}

      {embed.imageUrl ? <img className="dc-embed-image" src={embed.imageUrl} alt="" /> : null}
    </div>
  );
}

function ButtonView({ button }: { button: MessageButton }): ReactElement {
  const tone = BUTTON_CLASS[button.style] ?? '';

  return (
    <span className={`dc-button ${tone}${button.disabled ? ' disabled' : ''}`}>
      <EmojiGlyph emoji={button.emoji} />
      {button.label}
      {button.style === 'link' ? <Icon name="arrow-square-out" size={13} /> : null}
    </span>
  );
}

function SelectView({ select }: { select: MessageSelect }): ReactElement {
  return (
    <span className="dc-select">
      <span>{select.placeholder ?? 'Make a selection'}</span>
      <Icon name="caret-down" size={13} weight="fill" className="dc-select-chevron" />
    </span>
  );
}

function RowsView({ rows }: { rows: readonly ActionRow[] }): ReactElement | null {
  if (rows.length === 0) return null;

  return (
    <div className="dc-rows">
      {rows.map((row, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: a row's position is its identity
        <div className="dc-row" key={index}>
          {'buttons' in row
            ? row.buttons.map((button) => <ButtonView button={button} key={button.key} />)
            : null}
          {'select' in row ? <SelectView select={row.select} /> : null}
        </div>
      ))}
    </div>
  );
}

function V2View({
  components,
}: {
  components: readonly (V2Component | ContainerChild)[];
}): ReactElement {
  return (
    <>
      {components.map((component, index) => {
        const key = `v2-${index}`;

        if (component.kind === 'text') {
          return (
            <div className="dc-content" key={key}>
              <DiscordMarkdown text={component.content} />
            </div>
          );
        }

        if (component.kind === 'separator') {
          return (
            <div
              className={`dc-separator${component.divider === false ? ' invisible' : ''}${
                component.spacing === 'small' ? ' small' : ''
              }`}
              key={key}
            />
          );
        }

        if (component.kind === 'section') {
          return (
            <div className="dc-section" key={key}>
              <div className="dc-section-main">
                {component.text.map((line) => (
                  <div className="dc-content" key={line}>
                    <DiscordMarkdown text={line} />
                  </div>
                ))}
              </div>
              <div className="dc-section-accessory">
                {component.accessory.kind === 'thumbnail' ? (
                  <img
                    className="dc-thumbnail"
                    src={component.accessory.url}
                    alt={component.accessory.description ?? ''}
                  />
                ) : (
                  <ButtonView button={component.accessory.button} />
                )}
              </div>
            </div>
          );
        }

        if (component.kind === 'gallery') {
          return (
            <div className="dc-gallery" key={key}>
              {component.items.map((item) => (
                <img src={item.url} alt={item.description ?? ''} key={item.url} />
              ))}
            </div>
          );
        }

        if (component.kind === 'row') {
          return <RowsView rows={[component.row]} key={key} />;
        }

        if (component.kind === 'container') {
          return (
            <div
              className="dc-container"
              key={key}
              style={{ borderLeftColor: colourOf(component.accentColor) }}
            >
              <V2View components={component.children} />
            </div>
          );
        }

        return null;
      })}
    </>
  );
}

/**
 * What Discord will actually show. The colours, radii and the embed's 4px accent bar are Discord's
 * own, deliberately not Proton's chrome: this panel is a picture of the outcome.
 */
export function DiscordPreview({
  message,
  botName = 'Proton',
  avatarUrl,
  channelName,
  timestamp = 'Today at 00:00',
  empty = 'This message is empty.',
}: {
  message: Partial<ProtonMessage> | undefined;
  botName?: string | undefined;
  avatarUrl?: string | null | undefined;
  channelName?: string | undefined;
  timestamp?: string | undefined;
  empty?: ReactNode;
}): ReactElement {
  const content = message?.content ?? '';
  const embeds = message?.embeds ?? [];
  const rows = message?.components ?? [];
  const v2 = message?.v2 ?? [];

  const nothing =
    content.trim() === '' && embeds.length === 0 && rows.length === 0 && v2.length === 0;

  return (
    <div className="dc">
      {channelName !== undefined ? (
        <div className="dc-channel-hint">
          <Icon name="hash" size={14} />
          {channelName}
        </div>
      ) : null}

      {nothing ? (
        <p className="dc-empty">{empty}</p>
      ) : (
        <div className="dc-message">
          {avatarUrl ? (
            <img className="dc-avatar" src={avatarUrl} alt="" />
          ) : (
            <span className="dc-avatar" />
          )}

          <div className="dc-body">
            <div className="dc-head">
              <span className="dc-author">{botName}</span>
              <span className="dc-bot-tag">App</span>
              <span className="dc-timestamp">{timestamp}</span>
            </div>

            {content.trim() !== '' ? (
              <div className="dc-content">
                <DiscordMarkdown text={content} />
              </div>
            ) : null}

            {v2.length > 0 ? <V2View components={v2} /> : null}

            {embeds.map((embed, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: an embed's position is its identity
              <EmbedView embed={embed} key={index} />
            ))}

            <RowsView rows={rows} />
          </div>
        </div>
      )}
    </div>
  );
}
