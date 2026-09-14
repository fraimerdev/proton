import { Link, useLocation } from '@tanstack/react-router';
import type { ReactElement, ReactNode } from 'react';
import { createContext, use, useEffect, useId, useRef, useState } from 'react';
import { menuItemFor, ProtonMark } from '../shell/topbar.tsx';
import { useSlidingIndicator } from '../ui/controls.tsx';
import { Icon } from '../ui/icon.tsx';
import { Popover } from '../ui/overlay.tsx';

// Handed down from the root route rather than read here. This module is imported by every public
// page, and reaching into lib/queries.ts from it pulls the whole server-function graph into the
// first chunk the browser parses.
const SignedIn = createContext<boolean | null>(null);

const HOME_ONLY = { exact: true } as const;
const MODULES_ONLY = { exact: true, includeHash: true } as const;

const COMPACT = '(max-width: 767px)';

export function SignedInProvider({
  value,
  children,
}: {
  value: boolean | null;
  children: ReactNode;
}): ReactElement {
  return <SignedIn value={value}>{children}</SignedIn>;
}

export function useSignedIn(): boolean | null {
  return use(SignedIn);
}

function useScrolled(): boolean {
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const check = (): void => setScrolled(window.scrollY > 0);
    check();
    window.addEventListener('scroll', check, { passive: true });
    return () => window.removeEventListener('scroll', check);
  }, []);

  return scrolled;
}

function PrimaryAction({ signedIn }: { signedIn: boolean | null }): ReactElement {
  if (signedIn === true) {
    return (
      <Link to="/dashboard" className="button button-primary site-bar-primary">
        Open the dashboard
      </Link>
    );
  }

  return (
    <Link to="/signin" className="button button-primary site-bar-primary">
      <Icon name="discord-logo" size={15} weight="fill" />
      Log in with Discord
    </Link>
  );
}

function SiteLinks({ page }: { page: number }): ReactElement {
  const [aim, setAim] = useState(-1);
  const { track, indicator } = useSlidingIndicator<HTMLElement>(
    aim === -1 ? page : aim,
    'modules commands faq',
  );

  const point = (index: number, pointerType: string): void => {
    if (pointerType !== 'touch') setAim(index);
  };

  const focus = (index: number, link: HTMLElement): void => {
    if (link.matches(':focus-visible')) setAim(index);
  };

  return (
    <nav
      ref={track}
      aria-label="Site"
      className="site-bar-links"
      data-current={page === -1 ? undefined : ''}
      onPointerLeave={() => setAim(-1)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setAim(-1);
      }}
    >
      <span ref={indicator} className="site-bar-thumb" aria-hidden />
      <Link
        to="/"
        hash="modules"
        activeOptions={MODULES_ONLY}
        className="site-bar-link"
        onPointerEnter={(event) => point(0, event.pointerType)}
        onFocus={(event) => focus(0, event.currentTarget)}
      >
        Modules
      </Link>
      <Link
        to="/commands"
        className="site-bar-link"
        data-page={page === 1 ? '' : undefined}
        onPointerEnter={(event) => point(1, event.pointerType)}
        onFocus={(event) => focus(1, event.currentTarget)}
      >
        Commands
      </Link>
      <Link
        to="/faq"
        className="site-bar-link"
        data-page={page === 2 ? '' : undefined}
        onPointerEnter={(event) => point(2, event.pointerType)}
        onFocus={(event) => focus(2, event.currentTarget)}
      >
        FAQ
      </Link>
    </nav>
  );
}

function SiteMenu({ page }: { page: number }): ReactElement {
  const trigger = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLElement>(null);
  const menuId = useId();
  const href = useLocation({ select: (location) => location.href });
  const [openAt, setOpenAt] = useState<string | null>(null);

  // Cleared, not just compared: Back or Forward onto the href it opened at would reopen it.
  if (openAt !== null && openAt !== href) setOpenAt(null);

  const open = openAt === href;
  const close = (): void => setOpenAt(null);
  const dismiss = (): void => {
    const active = document.activeElement;
    if (active instanceof HTMLElement && list.current?.contains(active)) active.blur();
    setOpenAt(null);
  };

  useEffect(() => {
    if (!open) return;

    list.current?.querySelector<HTMLElement>('a[href]')?.focus({ preventScroll: true });

    const compact = window.matchMedia(COMPACT);
    const widened = (): void => {
      if (compact.matches) return;
      const active = document.activeElement;
      if (active === document.body || list.current?.contains(active)) {
        const brand = trigger.current?.closest('.site-bar-island')?.querySelector<HTMLElement>('a');
        brand?.focus({ preventScroll: true });
      }
      setOpenAt(null);
    };

    compact.addEventListener('change', widened);
    return () => compact.removeEventListener('change', widened);
  }, [open]);

  return (
    <>
      <button
        ref={trigger}
        type="button"
        className="site-bar-menu"
        aria-label="Menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpenAt(open ? null : href)}
        onKeyDown={(event) => {
          if (event.key !== 'ArrowDown') return;
          event.preventDefault();
          setOpenAt(href);
        }}
      >
        <Icon name={open ? 'x' : 'list'} size={18} />
      </button>

      <Popover anchor={trigger} open={open} onClose={dismiss} align="end" className="site-menu">
        <nav
          ref={list}
          id={menuId}
          aria-label="Site"
          onKeyDown={(event) => {
            const items = [...(list.current?.querySelectorAll<HTMLElement>('a[href]') ?? [])];

            if (event.key === 'Tab') {
              const edge = event.shiftKey ? items[0] : items[items.length - 1];
              if (document.activeElement !== edge) return;
              event.preventDefault();
              close();
              return;
            }

            const target = menuItemFor(items, event.key);
            if (!target) return;
            event.preventDefault();
            target.focus();
          }}
        >
          <Link
            to="/"
            hash="modules"
            activeOptions={MODULES_ONLY}
            className="menu-item"
            onClick={close}
          >
            <Icon name="squares-four" size={17} />
            Modules
          </Link>
          <Link
            to="/commands"
            className="menu-item"
            data-page={page === 1 ? '' : undefined}
            onClick={close}
          >
            <Icon name="book-open" size={17} />
            Commands
          </Link>
          <Link
            to="/faq"
            className="menu-item"
            data-page={page === 2 ? '' : undefined}
            onClick={close}
          >
            <Icon name="question" size={17} />
            FAQ
          </Link>
          <div className="menu-separator" />
          <a href="/invite" className="button button-secondary site-menu-invite" onClick={close}>
            Add to Discord
          </a>
        </nav>
      </Popover>
    </>
  );
}

export function SiteHeader(): ReactElement {
  const signedIn = useSignedIn();
  const scrolled = useScrolled();
  const pathname = useLocation({ select: (location) => location.pathname });
  const page = pathname === '/commands' ? 1 : pathname === '/faq' ? 2 : -1;

  return (
    <header className="site-bar" data-scrolled={scrolled ? '' : undefined}>
      <div className="site-bar-island">
        <Link to="/" activeOptions={HOME_ONLY} className="topbar-brand site-bar-brand">
          <ProtonMark />
          <span className="site-bar-wordmark">Proton</span>
        </Link>

        <SiteLinks page={page} />

        <div className="site-bar-actions">
          <a href="/invite" className="button button-secondary site-bar-invite">
            Add to Discord
          </a>
          <PrimaryAction signedIn={signedIn} />
          <SiteMenu page={page} />
        </div>
      </div>
    </header>
  );
}

export function SiteFooter(): ReactElement {
  return (
    <footer className="site-footer">
      <div className="site-footer-inner">
        <span>Proton</span>
        <span className="topbar-spacer" />
        <Link to="/commands">Commands</Link>
        <Link to="/faq">FAQ</Link>
        <Link to="/privacy">Privacy</Link>
        <Link to="/terms">Terms</Link>
      </div>
    </footer>
  );
}

export function SitePage({ children }: { children: ReactNode }): ReactElement {
  return (
    <div className="site">
      <SiteHeader />
      <main className="site-main">{children}</main>
      <SiteFooter />
    </div>
  );
}
