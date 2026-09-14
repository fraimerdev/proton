import { Link, useNavigate, useRouter } from '@tanstack/react-router';
import type { ReactElement } from 'react';
import { useEffect, useRef, useState } from 'react';
import { guildIconUrl, type SessionGuild } from '../../lib/guild-access.ts';
import { SUPPORT_INVITE } from '../../lib/site-meta.ts';
import { cx, SearchField } from '../ui/controls.tsx';
import { Icon } from '../ui/icon.tsx';
import { menuItemFor, Popover } from '../ui/overlay.tsx';

export { menuItemFor } from '../ui/overlay.tsx';

export interface Viewer {
  id: string;
  name: string;
  image: string | null;
}

function initials(name: string): string {
  return [...name].slice(0, 2).join('');
}

export function ProtonMark({ size = 28 }: { size?: number }): ReactElement {
  return (
    <img
      src="/brand/proton-mark-128.png"
      alt=""
      width={size}
      height={size}
      className="topbar-mark"
      decoding="async"
    />
  );
}

function Avatar({
  src,
  name,
  size,
  round = false,
}: {
  src: string | null;
  name: string;
  size: number;
  round?: boolean | undefined;
}): ReactElement {
  const image = useRef<HTMLImageElement>(null);
  const [failed, setFailed] = useState<string | null>(null);

  // A 404 that lands before hydration fires onError before React listens, so read it off the element.
  useEffect(() => {
    const element = image.current;
    if (src && element?.complete && element.naturalWidth === 0) setFailed(src);
  }, [src]);

  if (src && failed !== src) {
    return (
      <img
        ref={image}
        src={src}
        alt=""
        width={size}
        height={size}
        className={cx('topbar-avatar', round && 'round')}
        style={{ width: size, height: size }}
        onError={() => setFailed(src)}
      />
    );
  }

  return (
    <span
      className={cx('topbar-avatar', 'avatar-fallback', round && 'round')}
      style={{ width: size, height: size }}
      aria-hidden
    >
      {initials(name)}
    </span>
  );
}

export function GuildAvatar({
  guild,
  size = 20,
}: {
  guild: SessionGuild;
  size?: number;
}): ReactElement {
  return <Avatar src={guildIconUrl(guild, size > 32 ? 256 : 64)} name={guild.name} size={size} />;
}

function enabledOptions(list: HTMLElement | null): HTMLElement[] {
  return [...(list?.querySelectorAll<HTMLElement>('[role="option"]:not(:disabled)') ?? [])];
}

function ServerPicker({
  guilds,
  current,
  presenceKnown,
}: {
  guilds: readonly SessionGuild[];
  current: SessionGuild | undefined;
  presenceKnown: boolean;
}): ReactElement {
  const anchor = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const intent = useRef<number | undefined>(undefined);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const navigate = useNavigate();
  const router = useRouter();

  const searchable = guilds.length > 6;
  const needle = query.trim().toLowerCase();
  const shown = guilds.filter((guild) => guild.name.toLowerCase().includes(needle));

  useEffect(() => {
    if (!open || searchable) return;

    const options = enabledOptions(list.current);
    const target =
      options.find((option) => option.getAttribute('aria-selected') === 'true') ?? options[0];
    target?.focus({ preventScroll: true });
  }, [open, searchable]);

  const forget = (): void => window.clearTimeout(intent.current);

  const preload = (guildId: string): void => {
    forget();
    intent.current = window.setTimeout(() => {
      void router.preloadRoute({ to: '/dashboard/$guildId', params: { guildId } });
    }, router.options.defaultPreloadDelay ?? 50);
  };

  return (
    <>
      <button
        ref={anchor}
        type="button"
        className="topbar-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => {
          setQuery('');
          setOpen((value) => !value);
        }}
      >
        {current ? <GuildAvatar guild={current} /> : <Icon name="list" size={16} />}
        <span className="truncate topbar-trigger-label">{current?.name ?? 'Choose a server'}</span>
        <Icon name="caret-down" size={12} weight="fill" className="chevron" />
      </button>

      <Popover
        anchor={anchor}
        open={open}
        onClose={() => setOpen(false)}
        minWidth={268}
        maxWidth={320}
      >
        {searchable ? (
          <div className="picker-search">
            <SearchField
              value={query}
              onChange={setQuery}
              placeholder="Search servers…"
              label="Search servers"
              autoFocus
            />
          </div>
        ) : null}

        <div
          ref={list}
          className="popover-scroll"
          role="listbox"
          aria-label="Servers"
          onKeyDown={(event) => {
            const target = menuItemFor(enabledOptions(list.current), event.key);
            if (!target) return;
            event.preventDefault();
            target.focus();
          }}
        >
          {shown.map((guild) => (
            <button
              key={guild.id}
              type="button"
              role="option"
              aria-selected={guild.id === current?.id}
              className="menu-item"
              disabled={presenceKnown && !guild.present}
              onPointerEnter={() => preload(guild.id)}
              onPointerLeave={forget}
              onFocus={() => preload(guild.id)}
              onBlur={forget}
              onClick={() => {
                forget();
                setOpen(false);
                void navigate({
                  to: '/dashboard/$guildId',
                  params: { guildId: guild.id },
                });
              }}
            >
              <GuildAvatar guild={guild} size={22} />
              <span className="truncate">{guild.name}</span>
              {presenceKnown && !guild.present ? (
                <span className="push-right text-xs text-muted">Not added</span>
              ) : guild.id === current?.id ? (
                <Icon name="check" size={14} weight="fill" className="menu-item-check" />
              ) : null}
            </button>
          ))}

          {shown.length === 0 ? <p className="picker-note">No matching servers</p> : null}
        </div>

        <div className="menu-separator" />
        <Link to="/dashboard" className="menu-item" onClick={() => setOpen(false)}>
          <Icon name="list" size={15} />
          Your servers
        </Link>
      </Popover>
    </>
  );
}

export function UserMenu({
  viewer,
  onSignOut,
}: {
  viewer: Viewer;
  onSignOut: () => void;
}): ReactElement {
  const anchor = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const close = (): void => setOpen(false);

  useEffect(() => {
    if (!open) return;
    menu.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus({ preventScroll: true });
  }, [open]);

  return (
    <>
      <button
        ref={anchor}
        type="button"
        className="topbar-trigger topbar-user"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Account menu for ${viewer.name}`}
        onClick={() => setOpen((value) => !value)}
        onKeyDown={(event) => {
          if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
          event.preventDefault();
          setOpen(true);
        }}
      >
        <Avatar src={viewer.image} name={viewer.name} size={22} round />
        <span className="topbar-user-name truncate">{viewer.name}</span>
        <Icon name="caret-down" size={12} weight="fill" className="chevron" />
      </button>

      <Popover
        anchor={anchor}
        open={open}
        onClose={close}
        align="end"
        minWidth={248}
        maxWidth={300}
        className="account-menu"
      >
        <div className="menu-account">
          <Avatar src={viewer.image} name={viewer.name} size={40} round />
          <span className="menu-account-text">
            <span className="menu-account-name truncate">{viewer.name}</span>
            <span className="menu-account-detail truncate">Signed in with Discord</span>
          </span>
        </div>
        <div className="menu-separator" />
        <div
          ref={menu}
          role="menu"
          aria-label="Account"
          onKeyDown={(event) => {
            if (event.key === 'Tab') {
              event.preventDefault();
              close();
              return;
            }

            const items = [
              ...(menu.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []),
            ];
            const target = menuItemFor(items, event.key);
            if (!target) return;
            event.preventDefault();
            target.focus();
          }}
        >
          <Link to="/dashboard" role="menuitem" className="menu-item" onClick={close}>
            <Icon name="squares-four" size={17} />
            Your servers
          </Link>
          <div className="menu-separator" />
          <a
            href={SUPPORT_INVITE}
            target="_blank"
            rel="noreferrer"
            role="menuitem"
            className="menu-item"
            onClick={close}
          >
            <Icon name="discord-logo" size={17} />
            Support server
            <span className="visually-hidden"> (opens in a new tab)</span>
          </a>
          <Link to="/commands" role="menuitem" className="menu-item" onClick={close}>
            <Icon name="book-open" size={17} />
            Commands
          </Link>
          <Link to="/faq" role="menuitem" className="menu-item" onClick={close}>
            <Icon name="question" size={17} />
            FAQ
          </Link>
          <div className="menu-separator" />
          <button
            type="button"
            role="menuitem"
            className="menu-item menu-item-danger"
            onClick={onSignOut}
          >
            <Icon name="sign-out" size={17} />
            Sign out
          </button>
        </div>
      </Popover>
    </>
  );
}

export function Topbar({
  guilds,
  guildId,
  presenceKnown,
  viewer,
  onSignOut,
  onToggleNav,
  navOpen,
}: {
  guilds: readonly SessionGuild[];
  guildId: string | undefined;
  presenceKnown: boolean;
  viewer: Viewer;
  onSignOut: () => void;
  onToggleNav?: (() => void) | undefined;
  navOpen?: boolean | undefined;
}): ReactElement {
  const current = guilds.find((guild) => guild.id === guildId);

  return (
    <header className="topbar">
      <div className="shell-container topbar-inner">
        {onToggleNav ? (
          <button
            type="button"
            className="topbar-nav-toggle"
            aria-label={navOpen === true ? 'Close navigation' : 'Open navigation'}
            aria-expanded={navOpen === true}
            onClick={onToggleNav}
          >
            <Icon name="list" size={18} />
          </button>
        ) : null}

        <Link to="/" className="topbar-brand">
          <ProtonMark />
          Proton
        </Link>

        <ServerPicker guilds={guilds} current={current} presenceKnown={presenceKnown} />

        <span className="topbar-spacer" />

        <UserMenu viewer={viewer} onSignOut={onSignOut} />
      </div>
    </header>
  );
}
