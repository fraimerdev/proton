import type {
  ActionRow,
  ComponentEmoji,
  ContainerChild,
  Embed,
  EmbedField,
  MediaItem,
  ProtonMessage,
  V2Component,
} from '@proton/core';
import type { ReactElement, ReactNode } from 'react';
import type { DiscordChannel, DiscordRole } from '../form/fields.tsx';
import { Markdown, type MentionUser, Plain } from './markdown.tsx';

const DEFAULT_ACCENT = '#4f545c';

export interface MessagePreviewProps {
  message: ProtonMessage;
  channels: readonly DiscordChannel[];
  roles: readonly DiscordRole[];

  botName?: string;
  now?: Date;

  users?: readonly MentionUser[];

  // Discord's own "@somebody used /command" line, which it prints above a reply to a slash
  // command. The builder has no invoker to name; the marketing scenes do.
  command?: { user: string; name: string; avatar?: string };

  // What the bot attached under the message. `/rank` answers with a PNG, and an image Discord
  // renders as an attachment is not an embed.
  attachment?: ReactNode;

  // The builder's caption, which the marketing pages replace with a channel header and the
  // dashboard leaves alone. `null` drops the header entirely.
  head?: ReactNode;
}

function hex(color: number | undefined): string {
  return color === undefined ? DEFAULT_ACCENT : `#${color.toString(16).padStart(6, '0')}`;
}

function sameDay(a: Date, b: Date): boolean {
  return a.toDateString() === b.toDateString();
}

function stamp(now: Date): string {
  const time = new Intl.DateTimeFormat(undefined, { timeStyle: 'short' }).format(now);
  return `Today at ${time}`;
}

function footerStamp(value: string | undefined, now: Date): string | null {
  if (value === undefined) return null;

  const at = value === 'now' ? now : new Date(value);
  if (Number.isNaN(at.getTime())) return null;

  if (sameDay(at, now)) return stamp(at);

  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(at);
}

function PreviewImage({ url, className }: { url: string; className: string }): ReactElement {
  return (
    <img
      className={className}
      src={url}
      alt=""
      loading="lazy"
      decoding="async"
      referrerPolicy="no-referrer"
    />
  );
}

function EmojiGlyph({ emoji }: { emoji: ComponentEmoji | undefined }): ReactElement | null {
  if (!emoji) return null;
  if (!emoji.id) return <span className="dc-emoji">{emoji.name}</span>;

  return <span className="dc-emoji-name">:{emoji.name ?? 'emoji'}:</span>;
}

// Discord packs consecutive inline fields three to a row; a non-inline field takes the full width
// and ends the run, so grouping has to happen before layout rather than in CSS.
function groupFields(fields: readonly EmbedField[]): EmbedField[][] {
  const rows: EmbedField[][] = [];

  for (const field of fields) {
    const last = rows.at(-1);

    if (!field.inline || !last || last.length === 3 || !last[0]?.inline) {
      rows.push([field]);
      continue;
    }

    last.push(field);
  }

  return rows;
}

interface MentionProps {
  channels: readonly DiscordChannel[];
  roles: readonly DiscordRole[];
  users?: readonly MentionUser[] | undefined;
  now: number;
}

function EmbedFields({
  fields,
  mentions,
}: {
  fields: readonly EmbedField[];
  mentions: MentionProps;
}): ReactElement | null {
  if (fields.length === 0) return null;

  return (
    <div className="dc-fields">
      {groupFields(fields).map((row, rowIndex) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: a field row is a layout grouping with no identity of its own
        <div className="dc-field-row" key={rowIndex}>
          {row.map((field, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: the edited value cannot key its own cell
            <div className="dc-field" key={index}>
              <div className="dc-field-name">
                <Markdown text={field.name} inline {...mentions} />
              </div>
              <div className="dc-field-value">
                <Markdown text={field.value} {...mentions} />
              </div>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

function EmbedCard({
  embed,
  mentions,
  now,
}: {
  embed: Embed;
  mentions: MentionProps;
  now: Date;
}): ReactElement {
  const footerAt = footerStamp(embed.timestamp, now);
  const hasFooter = Boolean(embed.footer?.text) || footerAt !== null;

  return (
    <div className="dc-embed" style={{ borderInlineStartColor: hex(embed.color) }}>
      <div className="dc-embed-grid">
        <div className="dc-embed-main">
          {embed.author ? (
            <div className="dc-embed-author">
              {embed.author.iconUrl ? (
                <PreviewImage url={embed.author.iconUrl} className="dc-embed-author-icon" />
              ) : null}
              <span
                className={
                  embed.author.url ? 'dc-embed-author-name dc-link' : 'dc-embed-author-name'
                }
              >
                <Plain text={embed.author.name} />
              </span>
            </div>
          ) : null}

          {embed.title ? (
            <div className={embed.url ? 'dc-embed-title dc-link' : 'dc-embed-title'}>
              <Plain text={embed.title} />
            </div>
          ) : null}

          {embed.description ? (
            <div className="dc-embed-description">
              <Markdown text={embed.description} {...mentions} />
            </div>
          ) : null}

          <EmbedFields fields={embed.fields ?? []} mentions={mentions} />

          {embed.imageUrl ? <PreviewImage url={embed.imageUrl} className="dc-embed-image" /> : null}
        </div>

        {embed.thumbnailUrl ? (
          <PreviewImage url={embed.thumbnailUrl} className="dc-embed-thumb" />
        ) : null}
      </div>

      {hasFooter ? (
        <div className="dc-embed-footer">
          {embed.footer?.iconUrl ? (
            <PreviewImage url={embed.footer.iconUrl} className="dc-embed-footer-icon" />
          ) : null}
          {embed.footer?.text ? (
            <span>
              <Plain text={embed.footer.text} />
            </span>
          ) : null}
          {embed.footer?.text && footerAt ? <span className="dc-dot">•</span> : null}
          {footerAt ? <span suppressHydrationWarning>{footerAt}</span> : null}
        </div>
      ) : null}
    </div>
  );
}

function ComponentRow({
  row,
  roles,
}: {
  row: ActionRow;
  roles: readonly DiscordRole[];
}): ReactElement {
  if (row.kind === 'select') {
    const { select } = row;
    const chosen = select.options.find((option) => option.default);

    return (
      <div className="dc-select" data-disabled={select.disabled ? 'true' : undefined}>
        <span className="dc-select-text">
          {chosen?.label ?? select.placeholder ?? 'Make a selection'}
        </span>
        <span className="dc-select-caret" aria-hidden="true" />
      </div>
    );
  }

  return (
    <div className="dc-buttons">
      {row.buttons.map((button, index) => (
        <span
          // biome-ignore lint/suspicious/noArrayIndexKey: two link buttons may legally share a key, so the key is not unique enough to identify a button
          key={index}
          className={`dc-button dc-button-${button.style}`}
          data-disabled={button.disabled ? 'true' : undefined}
          title={button.style === 'link' ? button.url : describeAction(button.action, roles)}
        >
          <EmojiGlyph emoji={button.emoji} />
          {button.label ? <span>{button.label}</span> : null}
          {button.style === 'link' ? (
            <span className="dc-button-external" aria-hidden="true" />
          ) : null}
        </span>
      ))}
    </div>
  );
}

function describeAction(
  action: { kind: string; mode?: string; roleId?: string; content?: string } | undefined,
  roles: readonly DiscordRole[],
): string | undefined {
  if (!action) return undefined;

  if (action.kind === 'role') {
    const name = roles.find((role) => role.id === action.roleId)?.name ?? action.roleId;
    return `${action.mode} the ${name} role`;
  }

  return 'replies with a message';
}

function galleryShape(count: number): string {
  if (count === 1) return 'one';
  if (count === 2) return 'two';
  if (count === 3) return 'three';
  return 'many';
}

function MediaGallery({ items }: { items: readonly MediaItem[] }): ReactElement {
  return (
    <div className="dc-gallery" data-shape={galleryShape(items.length)}>
      {items.map((item, index) => (
        <div
          className="dc-gallery-cell"
          data-spoiler={item.spoiler ? 'true' : undefined}
          // biome-ignore lint/suspicious/noArrayIndexKey: the edited url cannot key its own cell
          key={index}
          title={item.description}
        >
          <PreviewImage className="dc-gallery-image" url={item.url} />
          {item.spoiler ? <span className="dc-cover">Spoiler</span> : null}
        </div>
      ))}
    </div>
  );
}

function Section({
  node,
  mentions,
  roles,
}: {
  node: Extract<ContainerChild, { kind: 'section' }>;
  mentions: MentionProps;
  roles: readonly DiscordRole[];
}): ReactElement {
  const { accessory } = node;

  return (
    <div className="dc-section">
      <div className="dc-section-text">
        {node.text.map((line, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: the edited value cannot key its own line
          <div className="dc-text" key={index}>
            <Markdown text={line} {...mentions} />
          </div>
        ))}
      </div>

      {accessory.kind === 'thumbnail' ? (
        <div
          className="dc-section-thumb"
          data-spoiler={accessory.spoiler ? 'true' : undefined}
          title={accessory.description}
        >
          <PreviewImage className="dc-gallery-image" url={accessory.url} />
          {accessory.spoiler ? <span className="dc-cover">Spoiler</span> : null}
        </div>
      ) : (
        <div className="dc-section-accessory">
          <ComponentRow roles={roles} row={{ kind: 'buttons', buttons: [accessory.button] }} />
        </div>
      )}
    </div>
  );
}

function V2Node({
  node,
  mentions,
  roles,
}: {
  node: V2Component;
  mentions: MentionProps;
  roles: readonly DiscordRole[];
}): ReactElement {
  switch (node.kind) {
    case 'text':
      return (
        <div className="dc-text">
          <Markdown text={node.content} {...mentions} />
        </div>
      );

    case 'separator':
      return (
        <div
          className="dc-separator"
          data-divider={node.divider ? 'true' : 'false'}
          data-spacing={node.spacing}
        />
      );

    case 'gallery':
      return <MediaGallery items={node.items} />;

    case 'section':
      return <Section mentions={mentions} node={node} roles={roles} />;

    case 'row':
      return <ComponentRow roles={roles} row={node.row} />;

    case 'container':
      return (
        <div
          className="dc-container"
          data-spoiler={node.spoiler ? 'true' : undefined}
          style={{ borderInlineStartColor: hex(node.accentColor) }}
        >
          <div className="dc-v2">
            {node.children.map((child, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: a child is identified by its position in the container
              <V2Node key={index} mentions={mentions} node={child} roles={roles} />
            ))}
          </div>
          {node.spoiler ? <span className="dc-cover">Spoiler</span> : null}
        </div>
      );
  }
}

export function MessagePreview({
  message,
  channels,
  roles,
  botName,
  now,
  users,
  command,
  attachment,
  head,
}: MessagePreviewProps): ReactElement {
  const at = now ?? new Date();
  const mentions: MentionProps = { channels, roles, users, now: at.getTime() };

  const empty =
    (message.content?.trim().length ?? 0) === 0 &&
    message.embeds.length === 0 &&
    message.components.length === 0 &&
    message.v2.length === 0 &&
    attachment === undefined;

  return (
    <figure className="dc-fence">
      {head === undefined ? (
        <figcaption className="dc-fence-head">
          <span className="dc-fence-label">Discord preview</span>
          <span className="dc-fence-note">How this looks once it is posted</span>
        </figcaption>
      ) : (
        head
      )}

      <div className="dc-surface">
        {empty ? (
          <p className="dc-empty">Nothing to show yet. Add some text, an embed or a component.</p>
        ) : (
          <div className="dc-message">
            {command ? (
              <div className="dc-used">
                <span className="dc-used-hook" aria-hidden="true" />
                {command.avatar ? (
                  <img className="dc-used-pip" src={command.avatar} alt="" decoding="async" />
                ) : (
                  <span className="dc-used-pip" aria-hidden="true">
                    {command.user.slice(0, 1)}
                  </span>
                )}
                <span className="dc-used-text">
                  <span className="dc-mention">@{command.user}</span> used{' '}
                  <span className="dc-link">/{command.name}</span>
                </span>
              </div>
            ) : null}

            <img className="dc-avatar" src="/proton-mark.png" alt="" decoding="async" />

            <div className="dc-body">
              <div className="dc-head">
                <span className="dc-author">{botName ?? 'Proton'}</span>
                <span className="dc-app">APP</span>
                {/* Both halves of this string are ambient: the wall clock when no `now` is
                    supplied, and the viewer's locale and timezone in either case. The server
                    renders one and the browser another, so the text is allowed to differ rather
                    than logged as a hydration mismatch on every page that shows a preview. */}
                <span className="dc-time" suppressHydrationWarning>
                  {stamp(at)}
                </span>
              </div>

              {message.v2.length > 0 ? (
                <div className="dc-v2">
                  {message.v2.map((node, index) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: a node is identified by its position in the layout
                    <V2Node key={index} mentions={mentions} node={node} roles={roles} />
                  ))}
                </div>
              ) : (
                <>
                  {message.content?.trim() ? (
                    <div className="dc-content">
                      <Markdown text={message.content} {...mentions} />
                    </div>
                  ) : null}

                  {message.embeds.map((embed, index) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: the edited value cannot key its own card
                    <EmbedCard embed={embed} key={index} mentions={mentions} now={at} />
                  ))}

                  {message.components.length > 0 ? (
                    <div className="dc-components">
                      {message.components.map((row, index) => (
                        // biome-ignore lint/suspicious/noArrayIndexKey: a row is identified by its position in the message
                        <ComponentRow key={index} roles={roles} row={row} />
                      ))}
                    </div>
                  ) : null}
                </>
              )}

              {attachment ? <div className="dc-attachment">{attachment}</div> : null}
            </div>
          </div>
        )}
      </div>
    </figure>
  );
}
