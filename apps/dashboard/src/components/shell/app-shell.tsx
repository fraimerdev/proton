import type { ModuleSummary } from '@proton/core';
import { Link, useNavigate, useRouterState } from '@tanstack/react-router';
import {
  type ReactElement,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { DiscordUserGuild, SessionGuild } from '../../lib/guild-access.ts';
import { areaForField, areasFor } from '../panels/areas.ts';
import { useDismiss, useFocusTrap } from './dismiss.ts';
import { Icon } from './icon.tsx';
import type { IconName } from './icon-set.gen.ts';
import { ProtonMark } from './mark.tsx';
import {
  BROWSE_VIEWS,
  type BrowseView,
  CATEGORY_LABELS,
  CATEGORY_ORDER,
  configurableDescriptors,
  isCategory,
  moduleIcon,
  moduleState,
} from './module-meta.ts';

export { ProtonMark } from './mark.tsx';
export { type ModuleState, moduleState } from './module-meta.ts';

export function browsableViews(modules: readonly ModuleSummary[]): BrowseView[] {
  return BROWSE_VIEWS.filter((entry) => modules.some((m) => m.id === entry.moduleId));
}

export interface ShellUser {
  id: string;
  name: string;
  image: string | null;
  email: string | null;
}

export function initialsOf(name: string): string {
  const words = name.split(/\s+/).filter(Boolean);
  const letters = words.slice(0, 2).map((word) => word[0] ?? '');

  return (letters.join('') || name.slice(0, 2)).toUpperCase();
}

// Discord only serves powers of two, and asks for the nearest one up rather than resampling: 64
// is right for the rail's 40px avatar and blurs into mush behind the picker's 72px crest.
export function guildIconUrl(guild: DiscordUserGuild, size: 64 | 256 = 64): string | null {
  return guild.icon
    ? `https://cdn.discordapp.com/icons/${guild.id}/${guild.icon}.png?size=${size}`
    : null;
}

export function accessLabel(guild: DiscordUserGuild): string {
  return guild.owner ? 'Owner' : 'Manage Server';
}

export interface PaletteEntry {
  key: string;
  label: string;
  trail: string;

  // Lowercased once when the index is built. Doing it in the filter costs a template string and a
  // toLowerCase per entry per keystroke, over roughly 250 entries.
  haystack: string;
  icon: IconName;
  moduleId: string;
  field?: string;
  area?: string;
  view?: string;
}

export interface PageHeadProps {
  title: string;
  trail?: ReactNode;
  aside?: ReactNode;
}

export function PageHead({ title, trail, aside }: PageHeadProps): ReactElement {
  return (
    <div className="page-head">
      <div className="page-heading">
        {trail ? <div className="page-trail">{trail}</div> : null}
        <h1 className="page-title">{title}</h1>
      </div>
      {aside}
    </div>
  );
}

function searchString(search: unknown, key: string): string | undefined {
  const value = (search as Record<string, unknown>)[key];

  return typeof value === 'string' ? value : undefined;
}

export interface AppShellProps {
  guildId: string;
  guilds: readonly SessionGuild[];
  user: ShellUser;
  modules: readonly ModuleSummary[];
  children: ReactNode;
}

export function AppShell({
  guildId,
  guilds,
  user,
  modules,
  children,
}: AppShellProps): ReactElement {
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [userOpen, setUserOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);

  const userButton = useRef<HTMLButtonElement>(null);
  const userMenu = useRef<HTMLDivElement>(null);
  const sidebar = useRef<HTMLElement>(null);
  const drawerButton = useRef<HTMLButtonElement>(null);

  // Four values, not the whole location: selecting the location object re-renders the rail, the
  // sidebar and the topbar on every ?page= step through a browser tab.
  const { pathname, section, view, area } = useRouterState({
    structuralSharing: true,
    select: (state) => ({
      pathname: state.location.pathname.replace(/(.)\/$/, '$1'),
      section: searchString(state.location.search, 'section'),
      view: searchString(state.location.search, 'view'),
      area: searchString(state.location.search, 'area'),
    }),
  });

  const navId = useId();

  // Read after mount, never seeded: the server cannot know the platform, and a keycap that
  // disagreed with the first client render is a hydration mismatch. The handler takes either key,
  // so a Windows admin was being shown a shortcut with a modifier their keyboard does not have.
  const [onApple, setOnApple] = useState(true);
  useEffect(() => {
    setOnApple(/Mac|iPhone|iPad/.test(navigator.userAgent));
  }, []);

  // Apple writes the chord without a separator; everywhere else needs one, and a space inside a
  // single keycap reads as two keys crammed into one box.
  const shortcutCap = onApple ? '⌘K' : 'Ctrl+K';

  const guild = guilds.find((candidate) => candidate.id === guildId);
  const base = `/dashboard/${guildId}`;

  const onGeneral = pathname === base;
  const browsable = useMemo(() => browsableViews(modules), [modules]);
  const onBrowseView = browsable.some(
    (entry) => pathname === `${base}/${entry.moduleId}` && view === entry.viewId,
  );

  const openModuleId =
    !onBrowseView && pathname.startsWith(`${base}/`) ? pathname.slice(base.length + 1) : null;

  // Stable, because useDismiss lists the closer in its effect deps: a fresh arrow per render tears
  // down and re-registers two document listeners every time the shell re-renders with a menu open.
  const closeUser = useCallback(() => setUserOpen(false), []);
  const closeDrawer = useCallback(() => setDrawerOpen(false), []);

  useDismiss(userOpen, closeUser, userMenu, userButton);
  useDismiss(drawerOpen, closeDrawer, sidebar, drawerButton);

  // Navigating from the drawer closes it, which takes the focused link out of the document. Without
  // this the next Tab started from <body>, at the top of the page.
  const drawerWasOpen = useRef(false);
  useEffect(() => {
    drawerWasOpen.current = drawerOpen;
  }, [drawerOpen]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: navigation is the trigger, not an input
  useEffect(() => {
    if (drawerWasOpen.current) drawerButton.current?.focus();
    setDrawerOpen(false);
  }, [pathname, section, view, area]);

  useEffect(() => {
    function onKey(event: KeyboardEvent): void {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setPaletteOpen((open) => !open);
      }
    }

    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  // The drawer and its scrim only exist below 900px. Widening past it with the drawer open would
  // otherwise leave the page behind an inert flag it can no longer see a scrim for.
  useEffect(() => {
    if (!drawerOpen) return;

    const wide = window.matchMedia('(min-width: 901px)');
    function onWide(): void {
      if (wide.matches) setDrawerOpen(false);
    }

    onWide();
    wide.addEventListener('change', onWide);
    return () => wide.removeEventListener('change', onWide);
  }, [drawerOpen]);

  return (
    <>
      <a className="skip-link" href="#main">
        Skip to content
      </a>

      <div className="shell" data-drawer={drawerOpen ? 'open' : undefined}>
        <nav className="rail" aria-label="Servers">
          <Link to="/dashboard" className="rail-home" aria-label="All servers">
            <ProtonMark />
          </Link>
          <span className="rail-sep" />

          {guilds.map((candidate) => {
            const url = guildIconUrl(candidate);

            return (
              <Link
                key={candidate.id}
                to="/dashboard/$guildId"
                params={{ guildId: candidate.id }}
                search={{}}
                className="rail-guild"
                data-present={candidate.present ? undefined : 'false'}
                title={
                  candidate.present
                    ? candidate.name
                    : `${candidate.name} — Proton is not in this server`
                }
                aria-label={
                  candidate.present
                    ? candidate.name
                    : `${candidate.name}, Proton is not in this server`
                }
                aria-current={candidate.id === guildId ? 'page' : undefined}
              >
                {url ? <img src={url} alt="" width={40} height={40} /> : initialsOf(candidate.name)}
              </Link>
            );
          })}

          <span className="rail-spacer" />

          <button
            ref={userButton}
            type="button"
            className="rail-user"
            aria-label="Account"
            aria-expanded={userOpen}
            aria-haspopup="menu"
            onClick={() => setUserOpen((open) => !open)}
          >
            {user.image ? (
              <img src={user.image} alt="" width={34} height={34} />
            ) : (
              initialsOf(user.name)
            )}
          </button>
        </nav>

        <header className="topbar">
          <button
            ref={drawerButton}
            type="button"
            className="icon-button"
            aria-label="Server menu"
            aria-expanded={drawerOpen}
            onClick={() => setDrawerOpen((open) => !open)}
          >
            <Icon name={drawerOpen ? 'x' : 'list'} />
          </button>
          <span className="topbar-name">{guild?.name ?? 'This server'}</span>
          <button
            type="button"
            className="icon-button"
            aria-label="Search"
            onClick={() => setPaletteOpen(true)}
          >
            <Icon name="magnifying-glass" />
          </button>
          <button
            type="button"
            className="icon-button"
            aria-label="Account"
            aria-expanded={userOpen}
            aria-haspopup="menu"
            onClick={() => setUserOpen((open) => !open)}
          >
            <Icon name="user-circle" />
          </button>
        </header>

        <button
          type="button"
          className="drawer-scrim"
          aria-label="Close menu"
          tabIndex={-1}
          onClick={() => setDrawerOpen(false)}
        />

        <aside className="sidebar" ref={sidebar}>
          <div className="sidebar-head">
            <div className="sidebar-name">{guild?.name ?? 'This server'}</div>
            <div className="sidebar-meta">{guild ? accessLabel(guild) : 'Server settings'}</div>
          </div>

          <button
            type="button"
            className="search-trigger"
            aria-keyshortcuts={onApple ? 'Meta+K' : 'Control+K'}
            onClick={() => setPaletteOpen(true)}
          >
            <Icon name="magnifying-glass" />
            Search settings
            <span className="kbd">{shortcutCap}</span>
          </button>

          <nav className="sidebar-nav" aria-label="Proton">
            <div className="nav-group">
              <Link
                to="/dashboard/$guildId"
                params={{ guildId }}
                search={{}}
                className="nav-item"
                aria-current={onGeneral ? 'page' : undefined}
              >
                <NavInner icon="sliders-horizontal" label="Modules" current={onGeneral} />
              </Link>
            </div>

            {browsable.length > 0 ? (
              // Labelled group, not a loose span: the five category names organise the sidebar on
              // screen and were absent from the tree, so a reader met twenty-seven ungrouped links.
              // biome-ignore lint/a11y/useSemanticElements: a fieldset groups form controls; this groups links
              <div className="nav-group" role="group" aria-labelledby={`${navId}-browse`}>
                <span className="nav-group-label" id={`${navId}-browse`}>
                  Browse
                </span>
                {browsable.map((entry) => {
                  const current = pathname === `${base}/${entry.moduleId}` && view === entry.viewId;

                  return (
                    <Link
                      key={entry.viewId}
                      to="/dashboard/$guildId/$moduleId"
                      params={{ guildId, moduleId: entry.moduleId }}
                      search={{ view: entry.viewId }}
                      className="nav-item"
                      aria-current={current ? 'page' : undefined}
                    >
                      <NavInner icon={entry.icon} label={entry.title} current={current} />
                    </Link>
                  );
                })}
              </div>
            ) : null}

            {CATEGORY_ORDER.map((category) => {
              const owned = modules.filter((module) => module.category === category);
              if (owned.length === 0) return null;

              return (
                // biome-ignore lint/a11y/useSemanticElements: a fieldset groups form controls; this groups links
                <div
                  className="nav-group"
                  key={category}
                  role="group"
                  aria-labelledby={`${navId}-${category}`}
                >
                  <span className="nav-group-label" id={`${navId}-${category}`}>
                    {CATEGORY_LABELS[category]}
                  </span>
                  {owned.map((module) => (
                    <ModuleNavItem
                      key={module.id}
                      guildId={guildId}
                      module={module}
                      open={openModuleId === module.id}
                    />
                  ))}
                </div>
              );
            })}
          </nav>
        </aside>

        {/* Inert behind the drawer's scrim: without it Tab walked out of the drawer and went on
            focusing rows the scrim had already covered. */}
        <main className="main" id="main" inert={drawerOpen}>
          <div className="page">{children}</div>
        </main>

        {userOpen ? (
          <UserMenu ref={userMenu} user={user} onClose={() => setUserOpen(false)} />
        ) : null}

        {paletteOpen ? (
          <CommandPalette
            guildId={guildId}
            modules={modules}
            onClose={() => setPaletteOpen(false)}
          />
        ) : null}
      </div>
    </>
  );
}

function ModuleNavItem({
  guildId,
  module,
  open,
}: {
  guildId: string;
  module: ModuleSummary;
  open: boolean;
}): ReactElement {
  const state = moduleState(module);

  return (
    <Link
      to="/dashboard/$guildId/$moduleId"
      params={{ guildId, moduleId: module.id }}
      search={{}}
      className="nav-item"
      data-state={state}
      aria-current={open ? 'page' : undefined}
    >
      <NavInner icon={moduleIcon(module.dashboard?.icon)} label={module.name} current={open} />
      {state === 'off' ? null : (
        <span className="sr-only">
          {state === 'running'
            ? ', on'
            : state === 'blocked'
              ? ', on but a permission is missing'
              : ', on but not on this plan'}
        </span>
      )}
    </Link>
  );
}

interface NavInnerProps {
  icon: IconName;
  label: string;
  badge?: string;
  current: boolean;
}

function NavInner({ icon, label, badge, current }: NavInnerProps): ReactElement {
  return (
    <>
      <Icon name={icon} weight={current ? 'fill' : 'regular'} />
      <span className="nav-item-label">{label}</span>
      {badge ? <span className="nav-badge">{badge}</span> : null}
    </>
  );
}

function UserMenu({
  ref,
  user,
  onClose,
}: {
  ref: RefObject<HTMLDivElement | null>;
  user: ShellUser;
  onClose: () => void;
}): ReactElement {
  const first = useRef<HTMLAnchorElement>(null);

  // The menu renders at the end of the shell, so Tab from the account button used to walk the
  // sidebar and the whole page before reaching it. Focus goes in, and useDismiss brings it back.
  useFocusTrap(ref, true);
  useEffect(() => first.current?.focus(), []);

  const [signOutFailed, setSignOutFailed] = useState(false);

  // Neither the response nor a rejection was checked, so a sign-out the server refused looked
  // exactly like one that worked: the menu closed and the session stayed live.
  async function signOut(): Promise<void> {
    setSignOutFailed(false);

    try {
      const response = await fetch('/api/auth/sign-out', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });

      if (!response.ok) {
        setSignOutFailed(true);
        return;
      }
    } catch {
      setSignOutFailed(true);
      return;
    }

    window.location.href = '/';
  }

  return (
    <div className="user-menu" ref={ref} role="menu" aria-label="Account">
      <div className="user-menu-head">
        <span className="user-menu-avatar" aria-hidden="true">
          {user.image ? (
            <img src={user.image} alt="" width={38} height={38} decoding="async" />
          ) : (
            initialsOf(user.name)
          )}
        </span>
        <span className="user-menu-who">
          <span className="user-menu-name">{user.name}</span>
          <span className="user-menu-role">{user.email ?? 'Signed in with Discord'}</span>
        </span>
      </div>

      <div className="user-menu-group" role="none">
        <Link to="/dashboard" className="menu-item" role="menuitem" ref={first} onClick={onClose}>
          <Icon name="layout" />
          Your servers
        </Link>
        <Link to="/commands" className="menu-item" role="menuitem" onClick={onClose}>
          <Icon name="command" />
          Commands
        </Link>
        <Link to="/faq" className="menu-item" role="menuitem" onClick={onClose}>
          <Icon name="question" />
          FAQ
        </Link>
      </div>

      <div className="user-menu-group" role="none">
        <Link to="/privacy" className="menu-item" role="menuitem" onClick={onClose}>
          <Icon name="shield-check" />
          What Proton stores
        </Link>
        <Link to="/terms" className="menu-item" role="menuitem" onClick={onClose}>
          <Icon name="file-text" />
          Terms
        </Link>
      </div>

      <div className="user-menu-group" role="none">
        <button
          type="button"
          className="menu-item menu-item-danger"
          role="menuitem"
          onClick={() => void signOut()}
        >
          <Icon name="sign-out" />
          Sign out
        </button>
      </div>

      {signOutFailed ? (
        <p className="user-menu-failure" role="alert">
          Proton could not end the session. You are still signed in — try again, or close the
          browser to drop the cookie.
        </p>
      ) : null}
    </div>
  );
}

export function paletteIndex(modules: readonly ModuleSummary[]): PaletteEntry[] {
  const entries: PaletteEntry[] = [];

  for (const module of modules) {
    const trail = isCategory(module.category)
      ? `Modules / ${CATEGORY_LABELS[module.category]}`
      : 'Modules';

    entries.push({
      key: `module:${module.id}`,
      label: module.name,
      trail,
      haystack: `${module.name} ${trail}`.toLowerCase(),
      icon: moduleIcon(module.dashboard?.icon),
      moduleId: module.id,
    });

    // The three destinations the sidebar promotes to the top were the three the search could not
    // reach: typing "leaderboard" answered "Nothing matches that" with the Leaderboard row visible
    // behind the dialog.
    for (const browse of BROWSE_VIEWS.filter((entry) => entry.moduleId === module.id)) {
      const viewTrail = `${module.name} / views`;

      entries.push({
        key: `view:${module.id}:${browse.viewId}`,
        label: browse.title,
        trail: viewTrail,
        haystack: `${browse.title} ${viewTrail}`.toLowerCase(),
        icon: browse.icon,
        moduleId: module.id,
        view: browse.viewId,
      });
    }

    for (const area of areasFor(module.id)) {
      const areaTrail = `${module.name} / settings`;

      entries.push({
        key: `area:${module.id}:${area.id}`,
        label: area.title,
        trail: areaTrail,
        haystack: `${area.title} ${area.blurb} ${areaTrail}`.toLowerCase(),
        icon: area.icon,
        moduleId: module.id,
        area: area.id,
      });
    }

    for (const field of configurableDescriptors(module.fields)) {
      const area = areaForField(module.id, field.path, module.dashboard?.sections);
      const fieldTrail = `${module.name} / ${area ? area.title : 'settings'}`;

      entries.push({
        key: `field:${module.id}:${field.path}`,
        label: field.label,
        trail: fieldTrail,
        haystack: `${field.label} ${fieldTrail}`.toLowerCase(),
        icon: 'sliders-horizontal',
        moduleId: module.id,
        field: field.path,
        ...(area ? { area: area.id } : {}),
      });
    }
  }

  return entries;
}

export function paletteResults(index: readonly PaletteEntry[], query: string): PaletteEntry[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return index.filter((entry) => entry.field === undefined).slice(0, 8);

  return index.filter((entry) => entry.haystack.includes(needle)).slice(0, 9);
}

function CommandPalette({
  guildId,
  modules,
  onClose,
}: {
  guildId: string;
  modules: readonly ModuleSummary[];
  onClose: () => void;
}): ReactElement {
  const navigate = useNavigate();
  const inputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const resultsRef = useRef<HTMLDivElement>(null);
  const restoreTo = useRef<Element | null>(null);
  const listId = useId();

  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);

  const index = useMemo(() => paletteIndex(modules), [modules]);
  const results = useMemo(() => paletteResults(index, query), [index, query]);

  useFocusTrap(dialogRef, true);

  useEffect(() => {
    restoreTo.current = document.activeElement;
    inputRef.current?.focus();

    return () => {
      if (restoreTo.current instanceof HTMLElement) restoreTo.current.focus();
    };
  }, []);

  // Focus stays in the input, so the results list never scrolls itself: on a short viewport the
  // arrow keys walk the highlight off the bottom of a 60vh box that does not move.
  useEffect(() => {
    resultsRef.current
      ?.querySelector(`[id="${CSS.escape(`${listId}-${selected}`)}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [listId, selected]);

  function activate(entry: PaletteEntry): void {
    onClose();

    void navigate({
      to: '/dashboard/$guildId/$moduleId',
      params: { guildId, moduleId: entry.moduleId },
      search:
        entry.view !== undefined
          ? { view: entry.view }
          : entry.area === undefined
            ? {}
            : { area: entry.area },
      hash: entry.field ?? '',
    });
  }

  function onKeyDown(event: ReactKeyboardEvent<HTMLInputElement>): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      setSelected((current) => (results.length === 0 ? 0 : (current + 1) % results.length));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setSelected((current) =>
        results.length === 0 ? 0 : (current - 1 + results.length) % results.length,
      );
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const hit = results[selected];
      if (hit) activate(hit);
    }
  }

  return (
    <div className="palette-scrim">
      <button
        type="button"
        className="palette-backdrop"
        aria-label="Close search"
        tabIndex={-1}
        onClick={onClose}
      />

      {/* Escape listens on the dialog, not the input: one Tab moves focus to the ESC button, and
          from there the key the button is named after stopped working. */}
      <div
        className="palette"
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Search Proton"
        onKeyDown={(event) => {
          if (event.key !== 'Escape') return;
          event.preventDefault();
          onClose();
        }}
      >
        <div className="palette-head">
          <Icon name="magnifying-glass" />
          <input
            ref={inputRef}
            type="text"
            role="combobox"
            value={query}
            placeholder="Jump to a module or setting"
            aria-label="Search"
            aria-expanded
            aria-controls={listId}
            aria-activedescendant={results[selected] ? `${listId}-${selected}` : undefined}
            autoComplete="off"
            onKeyDown={onKeyDown}
            onChange={(event) => {
              setQuery(event.target.value);
              setSelected(0);
            }}
          />
          <button type="button" className="palette-esc" aria-label="Close" onClick={onClose}>
            ESC
          </button>
        </div>

        {/* Outside the listbox, not inside it: a listbox may only hold options, and a reader that
            honours that never reads a sentence parked among them. */}
        {results.length === 0 ? (
          <div className="palette-empty">
            <span className="empty-state-title">Nothing matches that.</span>
            <span className="status">
              Search covers module names and every setting inside them.
            </span>
          </div>
        ) : null}

        <div
          className="palette-results"
          id={listId}
          ref={resultsRef}
          role="listbox"
          aria-label="Results"
        >
          {results.map((entry, position) => (
            // biome-ignore lint/a11y/useFocusableInteractive: aria-activedescendant keeps focus on the input
            <div
              key={entry.key}
              id={`${listId}-${position}`}
              className="palette-item"
              role="option"
              aria-selected={position === selected}
              data-selected={position === selected}
              onMouseEnter={() => setSelected(position)}
              onClick={() => activate(entry)}
              onKeyDown={() => undefined}
            >
              <Icon name={entry.icon} weight={position === selected ? 'fill' : 'regular'} />
              <span className="palette-item-text">
                <span className="palette-item-label">{entry.label}</span>
                <span className="palette-item-path">{entry.trail}</span>
              </span>
              {position === selected ? <span className="kbd">ENTER</span> : null}
            </div>
          ))}
        </div>
      </div>

      <span aria-live="polite" className="sr-only">
        {results.length} {results.length === 1 ? 'result' : 'results'}
      </span>
    </div>
  );
}
