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
import { type AreaEntry, areaForField, areasFor } from '../panels/areas.ts';
import { useDismiss } from './dismiss.ts';
import { Icon } from './icon.tsx';
import type { IconName } from './icon-set.gen.ts';
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

export { type ModuleState, moduleState } from './module-meta.ts';

export function browsableViews(modules: readonly ModuleSummary[]): BrowseView[] {
  return BROWSE_VIEWS.filter((entry) => modules.some((m) => m.id === entry.moduleId));
}

export interface ShellUser {
  id: string;
  name: string;
  image: string | null;
}

export function initialsOf(name: string): string {
  const words = name.split(/\s+/).filter(Boolean);
  const letters = words.slice(0, 2).map((word) => word[0] ?? '');

  return (letters.join('') || name.slice(0, 2)).toUpperCase();
}

export function guildIconUrl(guild: DiscordUserGuild): string | null {
  return guild.icon
    ? `https://cdn.discordapp.com/icons/${guild.id}/${guild.icon}.png?size=64`
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

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function useFocusTrap(ref: RefObject<HTMLElement | null>, active: boolean): void {
  useEffect(() => {
    if (!active) return;

    function onKey(event: KeyboardEvent): void {
      if (event.key !== 'Tab' || !ref.current) return;

      const items = [...ref.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
      const first = items[0];
      const last = items[items.length - 1];
      if (!first || !last) return;

      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [ref, active]);
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

  // biome-ignore lint/correctness/useExhaustiveDependencies: navigation is the trigger, not an input
  useEffect(() => {
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

          <button type="button" className="search-trigger" onClick={() => setPaletteOpen(true)}>
            <Icon name="magnifying-glass" />
            Search settings
            <span className="kbd">⌘K</span>
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
              <div className="nav-group">
                <span className="nav-group-label">Browse</span>
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
                <div className="nav-group" key={category}>
                  <span className="nav-group-label">{CATEGORY_LABELS[category]}</span>
                  {owned.map((module) => (
                    <ModuleNavItem
                      key={module.id}
                      area={area}
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

        <main className="main" id="main">
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

export function ProtonMark({ size = 28 }: { size?: number }): ReactElement {
  return (
    <img
      src="/proton-mark.png"
      alt="Proton"
      width={size}
      height={size}
      decoding="async"
      style={{ display: 'block' }}
    />
  );
}

function ModuleNavItem({
  area,
  guildId,
  module,
  open,
}: {
  area: string | undefined;
  guildId: string;
  module: ModuleSummary;
  open: boolean;
}): ReactElement {
  const state = moduleState(module);
  const areas = areasFor(module.id);
  const nested = open && areas.length > 0;

  return (
    <div
      className="nav-module"
      data-state={state}
      data-open={open ? 'true' : undefined}
      data-nested={nested ? 'true' : undefined}
    >
      <Link
        to="/dashboard/$guildId/$moduleId"
        params={{ guildId, moduleId: module.id }}
        search={{}}
        className="nav-item"
        // With areas open the sub-nav owns aria-current, down to the row you are actually on. Two
        // elements claiming it in one nav is worse than none, and [data-nested] keeps the look.
        aria-current={open && !nested ? 'page' : undefined}
      >
        <NavInner icon={moduleIcon(module.dashboard?.icon)} label={module.name} current={open} />
      </Link>

      {nested ? (
        <AreaNav areas={areas} current={area} guildId={guildId} moduleId={module.id} />
      ) : null}
    </div>
  );
}

function AreaNav({
  areas,
  current,
  guildId,
  moduleId,
}: {
  areas: readonly AreaEntry[];
  current: string | undefined;
  guildId: string;
  moduleId: string;
}): ReactElement {
  return (
    <div className="nav-areas">
      <Link
        to="/dashboard/$guildId/$moduleId"
        params={{ guildId, moduleId }}
        search={{}}
        className="nav-area"
        aria-current={current === undefined ? 'page' : undefined}
      >
        Overview
      </Link>

      {areas.map((entry) => (
        <Link
          key={entry.id}
          to="/dashboard/$guildId/$moduleId"
          params={{ guildId, moduleId }}
          search={{ area: entry.id }}
          className="nav-area"
          aria-current={current === entry.id ? 'page' : undefined}
        >
          {entry.title}
        </Link>
      ))}
    </div>
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
  async function signOut(): Promise<void> {
    await fetch('/api/auth/sign-out', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });

    window.location.href = '/';
  }

  return (
    <div className="user-menu" ref={ref} role="menu" aria-label="Account">
      <div className="user-menu-head">
        <div className="user-menu-name">{user.name}</div>
        <div className="user-menu-role">Signed in with Discord</div>
      </div>
      <Link to="/privacy" className="menu-item" role="menuitem" onClick={onClose}>
        <Icon name="shield-check" />
        What Proton stores
      </Link>
      <button type="button" className="menu-item" role="menuitem" onClick={() => void signOut()}>
        <Icon name="sign-out" />
        Sign out
      </button>
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

      <div
        className="palette"
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Search Proton"
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

        <div className="palette-results" id={listId} role="listbox" aria-label="Results">
          {results.length === 0 ? (
            <div className="palette-empty">
              <span className="empty-state-title">Nothing matches that.</span>
              <span className="status">
                Search covers module names and every setting inside them.
              </span>
            </div>
          ) : null}

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
