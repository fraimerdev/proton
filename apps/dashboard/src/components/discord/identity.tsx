import type { ReactElement, ReactNode } from 'react';

export const PROTON_AVATAR = '/brand/proton-avatar-120.png';

export function AppTag(): ReactElement {
  return (
    <span className="dc-bot-tag">
      <svg
        className="dc-bot-tag-check"
        viewBox="0 0 16 16"
        width={14}
        height={14}
        role="img"
        aria-label="Verified"
        focusable="false"
      >
        <path d="M4.5 8.25 7 10.75l4.5-5" />
      </svg>
      App
    </span>
  );
}

export function MiniAvatar({ name }: { name: string }): ReactElement {
  return (
    <span className="dc-avatar-mini" aria-hidden>
      {name.slice(0, 1)}
    </span>
  );
}

function CommandGlyph(): ReactElement {
  return (
    <svg
      className="dc-command-glyph"
      viewBox="0 0 16 16"
      width={14}
      height={14}
      aria-hidden="true"
      focusable="false"
    >
      <rect x="1.5" y="1.5" width="13" height="13" rx="3.5" />
      <path d="M9.75 4.5 6.25 11.5" />
    </svg>
  );
}

export function CommandLine({
  user,
  command,
  avatar,
}: {
  user: string;
  command: string;
  avatar?: ReactNode;
}): ReactElement {
  return (
    <div className="dc-reference">
      {avatar ?? <MiniAvatar name={user} />}
      <span className="dc-reference-user">{user}</span>
      used
      <span className="dc-command">
        <CommandGlyph />
        {command}
      </span>
    </div>
  );
}

export function ReplyLine({
  user,
  text,
  pinged = false,
}: {
  user: string;
  text: string;
  pinged?: boolean | undefined;
}): ReactElement {
  return (
    <div className="dc-reference">
      <MiniAvatar name={user} />
      <span className="dc-reference-user">{pinged ? `@${user}` : user}</span>
      <span className="dc-reference-text">{text}</span>
    </div>
  );
}
