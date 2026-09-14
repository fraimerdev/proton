import type { ReactElement, ReactNode } from 'react';
import { cx } from '../ui/controls.tsx';
import { Icon } from '../ui/icon.tsx';

export type AvatarTone = 'blurple' | 'green' | 'pink' | 'orange' | 'teal';

export interface ChannelGroup {
  name: string;
  channels: readonly { name: string; active?: boolean | undefined }[];
}

export interface EmbedFieldView {
  name: string;
  value: ReactNode;
  inline?: boolean | undefined;
}

function Avatar({
  name,
  tone,
  size = 'full',
}: {
  name: string;
  tone: AvatarTone;
  size?: 'full' | 'small' | 'mini' | undefined;
}): ReactElement {
  return (
    <span
      className={cx(
        size === 'full' && 'dc-avatar',
        'landing-avatar',
        size !== 'full' && `landing-avatar-${size}`,
        `landing-avatar-${tone}`,
      )}
      aria-hidden
    >
      {name.slice(0, 1)}
    </span>
  );
}

export function Mention({ children }: { children: ReactNode }): ReactElement {
  return <span className="dc-mention">{children}</span>;
}

export function ChatCode({ children }: { children: ReactNode }): ReactElement {
  return <span className="dc-code">{children}</span>;
}

export function ChatLink({ children }: { children: ReactNode }): ReactElement {
  return <span className="dc-link">{children}</span>;
}

export function ChatTime({ children }: { children: ReactNode }): ReactElement {
  return <span className="landing-time">{children}</span>;
}

export function ChatText({ children }: { children: ReactNode }): ReactElement {
  return <div className="dc-content">{children}</div>;
}

export function ChatHeading({
  level,
  children,
}: {
  level: 1 | 2;
  children: ReactNode;
}): ReactElement {
  return <div className={`dc-heading-${level}`}>{children}</div>;
}

export function ChatSubtext({ children }: { children: ReactNode }): ReactElement {
  return <div className="dc-small landing-subtext">{children}</div>;
}

export function ChatCodeBlock({ children }: { children: ReactNode }): ReactElement {
  return <div className="dc-codeblock">{children}</div>;
}

export function ChatSeparator(): ReactElement {
  return <div className="dc-separator" />;
}

export function ChatMessage({
  author = '',
  tone = 'blurple',
  proton = false,
  continued = false,
  time = '',
  command,
  children,
}: {
  author?: string | undefined;
  tone?: AvatarTone | undefined;
  proton?: boolean | undefined;
  continued?: boolean | undefined;
  time?: string | undefined;
  command?: { user: string; name: string; tone: AvatarTone } | undefined;
  children: ReactNode;
}): ReactElement {
  if (continued) {
    return (
      <div className="landing-msg landing-msg-continued">
        <div className="landing-msg-body">{children}</div>
      </div>
    );
  }

  return (
    <div className={cx('landing-msg', proton && 'landing-msg-proton')}>
      {command ? (
        <div className="landing-msg-command">
          <Avatar name={command.user} tone={command.tone} size="mini" />
          <span className="landing-msg-command-user">{command.user}</span>
          used
          <span className="landing-msg-command-name">/{command.name}</span>
        </div>
      ) : null}

      <div className="dc-message">
        {proton ? (
          <span className="dc-avatar landing-avatar landing-avatar-proton" aria-hidden>
            <img src="/brand/proton-mark-128.png" alt="" width={26} height={26} />
          </span>
        ) : (
          <Avatar name={author} tone={tone} />
        )}

        <div className="dc-body">
          <div className="dc-head">
            <span className="dc-author">{proton ? 'Proton' : author}</span>
            {proton ? <span className="dc-bot-tag">App</span> : null}
            <span className="dc-timestamp">{time}</span>
          </div>
          {children}
        </div>
      </div>
    </div>
  );
}

export function ChatEmbed({
  color,
  title,
  description,
  fields,
  footer,
}: {
  color: string;
  title?: ReactNode;
  description?: ReactNode;
  fields?: readonly EmbedFieldView[] | undefined;
  footer?: ReactNode;
}): ReactElement {
  return (
    <div className="dc-embed" style={{ borderLeftColor: color }}>
      <div className="dc-embed-main">
        {title !== undefined ? <div className="dc-embed-title">{title}</div> : null}
        {description !== undefined ? (
          <div className="dc-embed-description">{description}</div>
        ) : null}
        {fields !== undefined && fields.length > 0 ? (
          <div className="dc-embed-fields">
            {fields.map((field) => (
              <div key={field.name} className={cx('dc-embed-field', field.inline && 'inline')}>
                <div className="dc-embed-field-name">{field.name}</div>
                <div className="dc-embed-field-value">{field.value}</div>
              </div>
            ))}
          </div>
        ) : null}
        {footer !== undefined ? (
          <div className="dc-embed-footer">
            <span>{footer}</span>
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function ChatContainer({
  accent,
  children,
}: {
  accent: string;
  children: ReactNode;
}): ReactElement {
  return (
    <div className="dc-container" style={{ borderLeftColor: accent }}>
      {children}
    </div>
  );
}

export function ChatRow({ children }: { children: ReactNode }): ReactElement {
  return (
    <div className="dc-rows">
      <div className="dc-row">{children}</div>
    </div>
  );
}

export function ChatButton({
  tone,
  emoji,
  children,
}: {
  tone?: 'secondary' | 'success' | 'danger' | undefined;
  emoji?: string | undefined;
  children: ReactNode;
}): ReactElement {
  return (
    <span className={cx('dc-button', tone)}>
      {emoji !== undefined ? <span className="dc-button-emoji">{emoji}</span> : null}
      {children}
    </span>
  );
}

export function ChatHeader({ channel, topic }: { channel: string; topic?: string }): ReactElement {
  return (
    <div className="landing-chat-head">
      <Icon name="hash" size={20} className="landing-chat-hash" />
      <span className="landing-chat-name">{channel}</span>
      {topic !== undefined ? <span className="landing-chat-topic">{topic}</span> : null}
      <span className="landing-chat-tools" aria-hidden>
        <Icon name="users-three" size={19} />
        <Icon name="magnifying-glass" size={17} />
      </span>
    </div>
  );
}

export function Composer({ channel }: { channel: string }): ReactElement {
  return (
    <div className="landing-composer" aria-hidden>
      <Icon name="plus" size={18} weight="fill" className="landing-composer-add" />
      <span className="landing-composer-placeholder">Message #{channel}</span>
      <Icon name="gift" size={20} />
      <Icon name="smiley" size={20} />
    </div>
  );
}

const RAIL_SERVERS = ['Northwind', 'Pixel Club', 'Night Owls'] as const;

function initials(name: string): string {
  return name
    .split(' ')
    .map((word) => word.slice(0, 1))
    .join('');
}

export function ServerRail({ active }: { active: string }): ReactElement {
  return (
    <div className="landing-rail" aria-hidden>
      <span className="landing-rail-item landing-rail-home">
        <Icon name="discord-logo" size={26} weight="fill" />
      </span>
      <span className="landing-rail-divider" />
      {RAIL_SERVERS.map((name) => (
        <span key={name} className={cx('landing-rail-item', name === active && 'active')}>
          {initials(name)}
        </span>
      ))}
      <span className="landing-rail-item landing-rail-add">
        <Icon name="plus" size={20} />
      </span>
    </div>
  );
}

export function ChannelList({
  server,
  groups,
  user,
}: {
  server: string;
  groups: readonly ChannelGroup[];
  user: { name: string; tone: AvatarTone };
}): ReactElement {
  return (
    <div className="landing-channel-list" aria-hidden>
      <div className="landing-server-name">
        {server}
        <Icon name="caret-down" size={14} weight="fill" />
      </div>

      <div className="landing-channels">
        {groups.map((group) => (
          <div key={group.name} className="landing-category-block">
            <div className="landing-category">
              <Icon name="caret-down" size={9} weight="fill" />
              {group.name}
            </div>
            {group.channels.map((channel) => (
              <div key={channel.name} className={cx('landing-channel', channel.active && 'active')}>
                <Icon name="hash" size={18} className="landing-channel-hash" />
                {channel.name}
              </div>
            ))}
          </div>
        ))}
      </div>

      <div className="landing-user">
        <Avatar name={user.name} tone={user.tone} size="small" />
        <span className="landing-user-name">
          {user.name}
          <span className="landing-user-status">Online</span>
        </span>
      </div>
    </div>
  );
}

export function ChatWindow({
  channel,
  topic,
  className,
  children,
}: {
  channel: string;
  topic?: string;
  className?: string | undefined;
  children: ReactNode;
}): ReactElement {
  return (
    <div className={cx('dc landing-window', className)}>
      <ChatHeader channel={channel} {...(topic !== undefined ? { topic } : {})} />
      <div className="landing-messages">{children}</div>
    </div>
  );
}
