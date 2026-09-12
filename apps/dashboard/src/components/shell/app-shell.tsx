import type { ModuleSummary } from '@proton/core';
import { Link, useNavigate, useRouterState } from '@tanstack/react-router';
import {
  createContext,
  type ReactElement,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
import { type DiscordUserGuild, guildIconUrl, type SessionGuild } from '../../lib/guild-access.ts';
import { Popover } from '../form/picker.tsx';
import { areaForField, areasFor } from '../module/area-index.ts';
import { modulePath } from '../module/paths.ts';
import { useDismiss, useFocusTrap } from './dismiss.ts';
import { Icon } from './icon.tsx';
import type { IconName } from './icon-set.gen.ts';
import { ProtonMark } from './mark.tsx';
import {
  BROWSE_VIEWS,
  type BrowseView,
  CATEGORY_LABELS,
  configurableDescriptors,
  isCategory,
  type ModuleState,
  moduleAliases,
  moduleIcon,
  moduleState,
  navGrouped,
  shortReason,
} from './module-meta.ts';
import { SIGN_OUT_FAILED, useSignOut } from './sign-out.ts';

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

// Re-exported rather than defined here: the module form needs it to put the server's crest on the
// emoji picker's rail, and importing the whole signed-in shell to get one URL builder would pull
// the palette and the guild menus into every module page's chunk.
export { guildIconUrl };

export function accessLabel(guild: DiscordUserGuild): string {
  return guild.owner ? 'Owner' : 'Manage Server';
}

export type PaletteKind = 'module' | 'view' | 'area' | 'field';

export interface PaletteEntry {
  key: string;
  label: string;
  trail: string;

  // Lowercased once when the index is built. Doing it in the filter costs a template string and a
  // toLowerCase per entry per keystroke, over roughly 250 entries.
  haystack: string;

  // The label alone, lowercased: what an exact or prefix match is measured against, so the module
  // called "Counter channels" can beat the thirty-six field labels containing the word channel.
  name: string;
  kind: PaletteKind;
  icon: IconName;
  moduleId: string;
  field?: string;
  area?: string;
  view?: string;
  on?: boolean;
}

export interface PageHeadProps {
  title: string;
  trail?: ReactNode;
  lede?: ReactNode;
  aside?: ReactNode;
}

/**
 * Title, orientation crumb, one-line lede and the page's own actions, on one baseline. The lede is
 * part of the head rather than a paragraph after it: read as a sibling it pushed every page's first
 * control a line further down, and the actions had nothing to align against.
 */
export function PageHead({ title, trail, lede, aside }: PageHeadProps): ReactElement {
  return (
    <div className="page-head">
      <div className="page-heading">
        {trail ? <div className="page-trail">{trail}</div> : null}
        <h1 className="page-title">{title}</h1>
        {lede ? <p className="page-lede">{lede}</p> : null}
      </div>
      {aside ? <div className="page-actions">{aside}</div> : null}
    </div>
  );
}

function searchString(search: unknown, key: string): string | undefined {
  const value = (search as Record<string, unknown>)[key];

  return typeof value === 'string' ? value : undefined;
}

const NAV_GROUP_STORE = 'proton.nav-groups';

function storedNavGroups(): string[] | null {
  try {
    const raw = window.localStorage.getItem(NAV_GROUP_STORE);
    if (raw === null) return null;

    const parsed: unknown = JSON.parse(raw);

    return Array.isArray(parsed)
      ? parsed.filter((id): id is string => typeof id === 'string')
      : null;
  } catch {
    return null;
  }
}

function rememberNavGroups(open: readonly string[]): void {
  try {
    window.localStorage.setItem(NAV_GROUP_STORE, JSON.stringify(open));
  } catch {
    return;
  }
}

const SaveSlotContext = createContext<HTMLElement | null>(null);
const ShellSavingContext = createContext(false);

export function useSaveSlot(): HTMLElement | null {
  return useContext(SaveSlotContext);
}

export function useShellSaving(): boolean {
  return useContext(ShellSavingContext);
}

export interface AppShellProps {
  guildId: string;
  guilds: readonly SessionGuild[];
  presenceKnown: boolean;
  user: ShellUser;
  modules: readonly ModuleSummary[];
  saving: boolean;

  // Whether the last switch write failed. The page below says what went wrong, at full length; this
  // is only here to stop the bar announcing "Saved" over the top of it.
  saveFailed: boolean;
  children: ReactNode;
}

export function AppShell({
  guildId,
  guilds,
  presenceKnown,
  user,
  modules,
  saving,
  saveFailed,
  children,
}: AppShellProps): ReactElement {
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [userOpen, setUserOpen] = useState(false);
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [saveSlot, setSaveSlot] = useState<HTMLDivElement | null>(null);
  const [navQuery, setNavQuery] = useState('');

  const userButton = useRef<HTMLButtonElement>(null);
  const userMenu = useRef<HTMLDivElement>(null);
  const switcherButton = useRef<HTMLButtonElement>(null);
  const switcherMenu = useRef<HTMLDivElement>(null);
  const sidebar = useRef<HTMLElement>(null);
  const drawerButton = useRef<HTMLButtonElement>(null);

  // Four values, not the whole location: selecting the location object re-renders the top bar and
  // the sidebar on every ?page= step through a browser tab.
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
  const access = guild ? accessLabel(guild) : 'Switch server';
  const base = `/dashboard/${guildId}`;

  const onGeneral = pathname === base;
  const browsable = useMemo(() => browsableViews(modules), [modules]);
  const records = useMemo(() => browsable.filter((entry) => entry.record === true), [browsable]);
  const onBrowseView = browsable.some(
    (entry) => pathname === `${base}/${entry.moduleId}` && view === entry.viewId,
  );

  const pageModuleId = pathname.startsWith(`${base}/`) ? pathname.slice(base.length + 1) : null;
  const openModuleId = onBrowseView ? null : pageModuleId;

  const listed = useMemo(
    () => modules.filter((module) => modulePath(module.id) !== undefined),
    [modules],
  );
  const groups = useMemo(() => navGrouped(listed), [listed]);

  const needle = navQuery.trim().toLowerCase();
  const filtered = groups.map((group) => ({
    group,
    shown:
      needle === ''
        ? group.modules
        : group.modules.filter(
            (module) =>
              module.name.toLowerCase().includes(needle) ||
              group.label.toLowerCase().includes(needle) ||
              moduleAliases(module.id).includes(needle),
          ),
  }));

  const shownRecords =
    needle === '' ? records : records.filter((entry) => entry.title.toLowerCase().includes(needle));

  const currentGroup = groups.find((group) =>
    group.modules.some((module) => module.id === pageModuleId),
  )?.id;

  const [openGroups, setOpenGroups] = useState<readonly string[]>(
    currentGroup === undefined ? [] : [currentGroup],
  );

  // Read after mount, never seeded: the server cannot see localStorage. The group holding the page
  // being looked at opens whichever way the admin left the sidebar — the active row has to be on
  // screen — and a group they closed themselves stays closed, because this only runs on navigation.
  useEffect(() => {
    const stored = storedNavGroups();

    setOpenGroups((current) => {
      const kept = stored ?? current;

      return currentGroup !== undefined && !kept.includes(currentGroup)
        ? [...kept, currentGroup]
        : kept;
    });
  }, [currentGroup]);

  function toggleGroup(id: string): void {
    const next = openGroups.includes(id)
      ? openGroups.filter((held) => held !== id)
      : [...openGroups, id];

    setOpenGroups(next);
    rememberNavGroups(next);
  }

  const crumbPage = onGeneral ? 'Modules' : modules.find((m) => m.id === pageModuleId)?.name;
  const crumbFace =
    browsable.find((entry) => entry.moduleId === pageModuleId && entry.viewId === view)?.title ??
    (pageModuleId === null
      ? undefined
      : areasFor(pageModuleId).find((entry, index) => index > 0 && entry.id === area)?.title);

  // Stable, because useDismiss lists the closer in its effect deps: a fresh arrow per render tears
  // down and re-registers two document listeners every time the shell re-renders with a menu open.
  const closeUser = useCallback(() => setUserOpen(false), []);
  const closeSwitcher = useCallback(() => setSwitcherOpen(false), []);
  const closeDrawer = useCallback(() => setDrawerOpen(false), []);

  useDismiss(userOpen, closeUser, userMenu, userButton);
  useDismiss(switcherOpen, closeSwitcher, switcherMenu, switcherButton);
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
    setSwitcherOpen(false);

    // A filter left standing can hide the row the admin has just landed on.
    setNavQuery('');
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

  // The drawer and its scrim only exist below 1000px. Widening past it with the drawer open would
  // otherwise leave the page behind an inert flag it can no longer see a scrim for.
  useEffect(() => {
    if (!drawerOpen) return;

    const wide = window.matchMedia('(min-width: 1001px)');
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
        <button
          type="button"
          className="drawer-scrim"
          aria-label="Close menu"
          tabIndex={-1}
          onClick={() => setDrawerOpen(false)}
        />

        <aside className="sidebar" ref={sidebar}>
          <div className="sidebar-head">
            <button
              ref={switcherButton}
              type="button"
              className="switcher"
              aria-label={`Server: ${guild?.name ?? 'this server'}. Switch server`}
              aria-expanded={switcherOpen}
              aria-haspopup="menu"
              onClick={() => setSwitcherOpen((open) => !open)}
            >
              <span className="switcher-crest" aria-hidden="true">
                {guild && guildIconUrl(guild) ? (
                  <img src={guildIconUrl(guild) ?? ''} alt="" width={30} height={30} />
                ) : (
                  initialsOf(guild?.name ?? 'Server')
                )}
              </span>
              <span className="switcher-text">
                <span className="switcher-name">{guild?.name ?? 'This server'}</span>
                <span className="switcher-access">{access}</span>
              </span>
              <Icon name="caret-down" className="switcher-caret" />
            </button>

            {switcherOpen ? (
              <ServerSwitcherMenu
                ref={switcherMenu}
                guilds={guilds}
                guildId={guildId}
                presenceKnown={presenceKnown}
                onClose={closeSwitcher}
              />
            ) : null}
          </div>

          <nav className="sidebar-nav" aria-label="Proton">
            <Link
              to="/dashboard/$guildId"
              params={{ guildId }}
              search={{}}
              activeOptions={{ exact: true, includeSearch: true }}
              className="nav-item nav-item-top"
            >
              <NavInner icon="layout" label="All modules" />
            </Link>

            <div className="nav-search">
              <Icon name="magnifying-glass" />
              <input
                type="search"
                value={navQuery}
                placeholder="Filter modules"
                aria-label="Filter modules"
                autoComplete="off"
                onChange={(event) => setNavQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') setNavQuery('');
                }}
              />
            </div>

            {shownRecords.length > 0 ? (
              // Labelled group, not a loose span: the group names organise the sidebar on screen and
              // were absent from the tree, so a reader met twenty-seven ungrouped links. Never
              // collapsed, because three rows of it are what an admin comes back for.
              // biome-ignore lint/a11y/useSemanticElements: a fieldset groups form controls; this groups links
              <div className="nav-group" role="group" aria-labelledby={`${navId}-records`}>
                <span className="nav-group-label nav-group-label-plain" id={`${navId}-records`}>
                  Records
                </span>
                <div className="nav-group-list">
                  {shownRecords.map((entry) => {
                    const to = modulePath(entry.moduleId);
                    if (!to) return null;

                    return (
                      <Link
                        key={entry.viewId}
                        to={to}
                        params={{ guildId }}
                        search={{ view: entry.viewId }}
                        activeOptions={{ exact: true, includeSearch: true }}
                        className="nav-item"
                      >
                        <NavInner icon={entry.icon} label={entry.title} />
                      </Link>
                    );
                  })}
                </div>
              </div>
            ) : null}

            {filtered.map(({ group, shown }) => {
              if (shown.length === 0) return null;

              const open = needle !== '' || openGroups.includes(group.id);
              const on = group.modules.filter((module) => module.enabled).length;

              return (
                // biome-ignore lint/a11y/useSemanticElements: a fieldset groups form controls; this groups links
                <div
                  className="nav-group"
                  key={group.id}
                  role="group"
                  aria-labelledby={`${navId}-${group.id}`}
                >
                  <button
                    type="button"
                    className="nav-group-head"
                    id={`${navId}-${group.id}`}
                    aria-expanded={open}
                    aria-controls={`${navId}-${group.id}-list`}
                    onClick={() => toggleGroup(group.id)}
                  >
                    <Icon name={open ? 'caret-down' : 'caret-right'} className="nav-group-caret" />
                    <span className="nav-group-label">{group.label}</span>
                    <span className="nav-group-tally" aria-hidden="true">
                      {on}/{group.modules.length}
                    </span>
                    <span className="sr-only">
                      , {on} of {group.modules.length} on
                    </span>
                  </button>

                  <div className="nav-group-list" id={`${navId}-${group.id}-list`} hidden={!open}>
                    {shown.map((module) => (
                      <ModuleNavItem
                        key={module.id}
                        guildId={guildId}
                        module={module}
                        open={openModuleId === module.id}
                        browsing={onBrowseView && pageModuleId === module.id}
                        area={area}
                      />
                    ))}
                  </div>
                </div>
              );
            })}

            {needle !== '' &&
            shownRecords.length === 0 &&
            filtered.every(({ shown }) => shown.length === 0) ? (
              <p className="nav-empty">No module matches that.</p>
            ) : null}
          </nav>

          <div className="sidebar-foot">
            <button
              ref={userButton}
              type="button"
              className="account"
              aria-label={`Account: ${user.name}`}
              aria-expanded={userOpen}
              aria-haspopup="menu"
              onClick={() => setUserOpen((open) => !open)}
            >
              <span className="account-avatar" aria-hidden="true">
                {user.image ? (
                  <img src={user.image} alt="" width={28} height={28} />
                ) : (
                  initialsOf(user.name)
                )}
              </span>
              <span className="account-name">{user.name}</span>
              <Icon name="caret-down" className="account-caret" />
            </button>

            <Link to="/" className="sidebar-exit" aria-label="Exit, back to the Proton site">
              Back to the site
            </Link>

            {userOpen ? <UserMenu ref={userMenu} user={user} onClose={closeUser} /> : null}
          </div>
        </aside>

        <div className="shell-main">
          <header className="topbar">
            <button
              ref={drawerButton}
              type="button"
              className="topbar-icon topbar-burger"
              aria-label="Server menu"
              aria-expanded={drawerOpen}
              onClick={() => setDrawerOpen((open) => !open)}
            >
              <Icon name={drawerOpen ? 'x' : 'list'} />
            </button>

            {/* Outside the crumb, because the crumb is not drawn above 1000px and this is the only
                Proton mark in the signed-in chrome. */}
            <Link to="/dashboard" className="crumb-home" aria-label="Proton — all servers">
              <ProtonMark size={20} />
            </Link>

            {/* Below 1000px only, where the sidebar has become a drawer and nothing else on screen
                says where you are. Above it the sidebar's active row and the h1 both do, and the
                centre of the bar is spent on what neither of them can say. */}
            <nav className="crumbs" aria-label="Breadcrumb">
              <span className="crumb-rule" aria-hidden="true" />
              <Link
                to="/dashboard/$guildId"
                params={{ guildId }}
                search={{}}
                className="crumb-server"
                title={guild?.name}
              >
                {guild?.name ?? 'This server'}
              </Link>
              {crumbPage ? (
                <>
                  <span className="crumb-sep crumb-lead" aria-hidden="true">
                    /
                  </span>
                  {/* Marked as the parent only when a face is open, because the phone bar has room
                      for one crumb and the open face is the one that is current. */}
                  <span
                    className={crumbFace ? 'crumb-page crumb-parent' : 'crumb-page'}
                    aria-current={crumbFace ? undefined : 'page'}
                  >
                    {crumbPage}
                  </span>
                  {crumbFace ? (
                    <>
                      <span className="crumb-sep crumb-parent" aria-hidden="true">
                        /
                      </span>
                      <span className="crumb-page crumb-face" aria-current="page">
                        {crumbFace}
                      </span>
                    </>
                  ) : null}
                </>
              ) : null}
            </nav>

            <ServerHealth
              guildId={guildId}
              guildName={guild?.name ?? 'this server'}
              modules={modules}
              presenceKnown={presenceKnown}
            />

            <div className="topbar-tools">
              <button
                type="button"
                className="topbar-search"
                aria-keyshortcuts={onApple ? 'Meta+K' : 'Control+K'}
                onClick={() => setPaletteOpen(true)}
              >
                <Icon name="magnifying-glass" />
                <span className="topbar-search-label">Search settings</span>
                <span className="kbd">{shortcutCap}</span>
              </button>

              <button
                type="button"
                className="topbar-icon topbar-search-compact"
                aria-label="Search settings"
                onClick={() => setPaletteOpen(true)}
              >
                <Icon name="magnifying-glass" />
              </button>

              <Link to="/faq" className="topbar-icon" aria-label="Questions about Proton">
                <Icon name="question" />
              </Link>
            </div>

            <div className="topbar-save">
              <div className="save-slot" ref={setSaveSlot} />
              <ShellSaveState saving={saving} failed={saveFailed} />
            </div>
          </header>

          {/* Inert behind the drawer's scrim: without it Tab walked out of the drawer and went on
              focusing rows the scrim had already covered. */}
          <main className="main" id="main" inert={drawerOpen}>
            <SaveSlotContext.Provider value={saveSlot}>
              <ShellSavingContext.Provider value={saving}>
                <div className="page">{children}</div>
              </ShellSavingContext.Provider>
            </SaveSlotContext.Provider>
          </main>
        </div>

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

/**
 * The bar's own save readout, for the one write that has no form: the master switch. It says nothing
 * at rest — the line it replaced claimed "Changes save as you make them" on every module page, where
 * the fields below it stage until Save — and nothing at all when the write failed, because the page
 * itself is already reporting that at full length.
 */
function ShellSaveState({
  saving,
  failed,
}: {
  saving: boolean;
  failed: boolean;
}): ReactElement | null {
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const wasSaving = useRef(false);

  useEffect(() => {
    if (saving) {
      wasSaving.current = true;
      setSavedAt(null);
      return;
    }

    if (!wasSaving.current) return;
    wasSaving.current = false;
    setSavedAt(new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));

    const timer = setTimeout(() => setSavedAt(null), 10_000);
    return () => clearTimeout(timer);
  }, [saving]);

  useEffect(() => {
    if (failed) setSavedAt(null);
  }, [failed]);

  if (saving) {
    return (
      <span className="save-default" data-pending="true">
        Saving…
      </span>
    );
  }

  if (savedAt === null || failed) return null;

  return <span className="save-default">Saved {savedAt}</span>;
}

/**
 * What the chrome can and cannot tell an admin about Proton in this server. The dashboard never talks
 * to Discord, and the api reports every permission as granted rather than claiming a check it cannot
 * make — so this names which half is verified instead of drawing a green tick over both.
 */
function ServerHealth({
  guildId,
  guildName,
  modules,
  presenceKnown,
}: {
  guildId: string;
  guildName: string;
  modules: readonly ModuleSummary[];
  presenceKnown: boolean;
}): ReactElement {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const panelId = useId();

  // Stable, because useDismiss lists the closer in its effect deps.
  const close = useCallback(() => setOpen(false), []);
  useDismiss(open, close, pop, button);

  const on = modules.filter((module) => module.enabled);
  const stalled = on.filter((module) => {
    const state = moduleState(module);

    return state === 'blocked' || state === 'degraded';
  });
  const intents = stalled.filter(
    (module) => module.status?.disabledReason?.code === 'missing_intent',
  );

  const summary =
    stalled.length > 0
      ? `${stalled.length} of ${on.length} on are not running`
      : `${on.length} of ${modules.length} modules on`;

  return (
    <>
      <button
        ref={button}
        type="button"
        className="health"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((current) => !current)}
      >
        <span
          className="state-mark"
          data-state={stalled.length > 0 ? 'blocked' : 'running'}
          aria-hidden="true"
        />
        <span className="sr-only">Proton in this server: </span>
        <span className="health-text">{summary}</span>
        <Icon name="caret-down" className="health-caret" />
      </button>

      {open ? (
        <Popover
          anchor={button}
          popRef={pop}
          className="health-pop"
          want={{ width: 360, height: 460 }}
          id={panelId}
        >
          <p className="health-pop-head">Proton in {guildName}</p>

          <dl className="health-rows">
            <div className="health-row">
              <dt>Modules on</dt>
              <dd>
                {on.length} of {modules.length}
              </dd>
            </div>

            <div className="health-row">
              <dt>Privileged intents</dt>
              <dd>
                {intents.length === 0
                  ? 'Every intent these modules need is on. Proton checks this for itself.'
                  : `${intents.length} module${intents.length === 1 ? '' : 's'} need an intent that is switched off.`}
              </dd>
            </div>

            <div className="health-row">
              <dt>Permissions</dt>
              <dd>
                Not checked here. Proton checks each one as it runs an action, and names the missing
                permission then.
              </dd>
            </div>

            <div className="health-row">
              <dt>Last event handled</dt>
              <dd>Not reported to this dashboard.</dd>
            </div>

            {presenceKnown ? null : (
              <div className="health-row">
                <dt>Proton’s presence</dt>
                <dd>Discord did not answer, so this page could not check it.</dd>
              </div>
            )}
          </dl>

          {stalled.length > 0 ? (
            <div className="health-stalled">
              <p className="health-pop-head">On but not running</p>
              {stalled.map((module) => {
                const to = modulePath(module.id);
                if (!to) return null;

                return (
                  <Link
                    key={module.id}
                    to={to}
                    params={{ guildId }}
                    search={{}}
                    className="health-stalled-row"
                    onClick={() => setOpen(false)}
                  >
                    <span className="health-stalled-name">{module.name}</span>
                    <span className="health-stalled-why">
                      {shortReason(module.status?.disabledReason?.code)}
                    </span>
                  </Link>
                );
              })}
            </div>
          ) : null}

          <div className="health-legend">
            <p className="health-pop-head">What the marks in the sidebar mean</p>
            <dl className="health-legend-list">
              {STATE_LEGEND.map(([state, word]) => (
                <div className="health-legend-row" key={state}>
                  <dt>
                    <span className="state-mark" data-state={state} aria-hidden="true" />
                  </dt>
                  <dd>{word}</dd>
                </div>
              ))}
            </dl>
          </div>
        </Popover>
      ) : null}
    </>
  );
}

const STATE_LEGEND: readonly [ModuleState, string][] = [
  ['off', 'Off'],
  ['running', 'On and running'],
  ['blocked', 'On, but something is missing'],
  ['degraded', 'On, but not on this plan'],
];

/**
 * The server list, which used to be an icon rail down the left edge of every page. Names are the
 * point of it — an icon column can only say which server is current to someone who already knows
 * the crests apart, and a server with no crest was two letters in a circle.
 */
function ServerSwitcherMenu({
  ref,
  guilds,
  guildId,
  presenceKnown,
  onClose,
}: {
  ref: RefObject<HTMLDivElement | null>;
  guilds: readonly SessionGuild[];
  guildId: string;
  presenceKnown: boolean;
  onClose: () => void;
}): ReactElement {
  const [query, setQuery] = useState('');
  const input = useRef<HTMLInputElement>(null);

  useFocusTrap(ref, true);
  useEffect(() => input.current?.focus(), []);

  const needle = query.trim().toLowerCase();
  const shown = needle
    ? guilds.filter((candidate) => candidate.name.toLowerCase().includes(needle))
    : guilds;

  return (
    <div className="switcher-menu" ref={ref} role="menu" aria-label="Servers">
      {guilds.length > 6 ? (
        <div className="switcher-search">
          <Icon name="magnifying-glass" />
          <input
            ref={input}
            type="text"
            value={query}
            placeholder="Find a server"
            aria-label="Find a server"
            autoComplete="off"
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
      ) : null}

      <div className="switcher-list">
        {shown.map((candidate) => {
          const url = guildIconUrl(candidate);
          const absent = presenceKnown && !candidate.present;
          const current = candidate.id === guildId;

          return (
            <Link
              key={candidate.id}
              to="/dashboard/$guildId"
              params={{ guildId: candidate.id }}
              search={{}}
              className="switcher-row"
              role="menuitem"
              data-present={absent ? 'false' : undefined}
              aria-current={current ? 'true' : undefined}
              aria-label={
                absent ? `${candidate.name}, Proton is not in this server` : candidate.name
              }
              onClick={onClose}
            >
              <span className="switcher-row-crest" aria-hidden="true">
                {url ? <img src={url} alt="" width={28} height={28} /> : initialsOf(candidate.name)}
              </span>
              <span className="switcher-row-text">
                <span className="switcher-row-name">{candidate.name}</span>
                <span className="switcher-row-meta">
                  {absent ? 'Proton is not in this server' : accessLabel(candidate)}
                </span>
              </span>
              {current ? (
                <Icon name="check-circle" weight="fill" className="switcher-row-tick" />
              ) : null}
            </Link>
          );
        })}

        {shown.length === 0 ? <p className="switcher-empty">No server matches that.</p> : null}
      </div>

      <div className="switcher-foot">
        <Link to="/dashboard" className="menu-item" role="menuitem" onClick={onClose}>
          <Icon name="layout" />
          All servers
        </Link>
      </div>
    </div>
  );
}

function ModuleNavItem({
  guildId,
  module,
  open,
  browsing,
  area,
}: {
  guildId: string;
  module: ModuleSummary;
  open: boolean;
  browsing: boolean;
  area: string | undefined;
}): ReactElement | null {
  const state = moduleState(module);
  const to = modulePath(module.id);
  if (!to) return null;

  return (
    // The row addresses the face that is open, not the module's bare url. Router-set aria-current
    // is applied after our own props and can only be narrowed through activeOptions, so the link
    // has to name the current location for the row to be the one marked current — and every other
    // row in the sidebar has to fail that test, which exact + includeSearch is what makes true.
    <Link
      to={to}
      params={{ guildId }}
      search={open && area !== undefined ? { area } : {}}
      activeOptions={{ exact: true, includeSearch: true }}
      className="nav-item"
      data-state={state}
      // A record view is a face of this module, so the module is what is open — but the row that is
      // current is the one in Records, and two rows claiming aria-current is a lie to a reader.
      data-browsing={browsing || undefined}
    >
      <NavInner icon={moduleIcon(module.dashboard?.icon)} label={module.name} />
      <span className="state-mark" data-state={state} aria-hidden="true" />
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
}

function NavInner({ icon, label }: NavInnerProps): ReactElement {
  return (
    <>
      <Icon name={icon} className="nav-item-icon" />
      <span className="nav-item-label">{label}</span>
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

  // Focus goes in, and useDismiss brings it back.
  useFocusTrap(ref, true);
  useEffect(() => first.current?.focus(), []);

  const { signOut, failed: signOutFailed } = useSignOut();

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
          Questions
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
          {SIGN_OUT_FAILED}
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
      haystack: `${module.name} ${trail} ${moduleAliases(module.id)}`.toLowerCase(),
      name: module.name.toLowerCase(),
      kind: 'module',
      icon: moduleIcon(module.dashboard?.icon),
      moduleId: module.id,
      on: module.enabled,
    });

    // The three destinations the sidebar promotes to the top were the three the search could not
    // reach: typing "leaderboard" answered "Nothing matches that" with the Leaderboard row visible
    // behind the dialog.
    for (const browse of BROWSE_VIEWS.filter((entry) => entry.moduleId === module.id)) {
      entries.push({
        key: `view:${module.id}:${browse.viewId}`,
        label: browse.title,
        trail: module.name,
        haystack: `${browse.title} ${module.name}`.toLowerCase(),
        name: browse.title.toLowerCase(),
        kind: 'view',
        icon: browse.icon,
        moduleId: module.id,
        view: browse.viewId,
      });
    }

    for (const area of areasFor(module.id)) {
      entries.push({
        key: `area:${module.id}:${area.id}`,
        label: area.title,
        trail: module.name,
        haystack: `${area.title} ${area.blurb} ${module.name}`.toLowerCase(),
        name: area.title.toLowerCase(),
        kind: 'area',
        icon: area.icon,
        moduleId: module.id,
        area: area.id,
      });
    }

    for (const field of configurableDescriptors(module.fields)) {
      const area = areaForField(module.id, field.path);
      const fieldTrail = `${module.name} / ${area ? area.title : 'settings'}`;

      entries.push({
        key: `field:${module.id}:${field.path}`,
        label: field.label,
        trail: fieldTrail,
        haystack: `${field.label} ${fieldTrail}`.toLowerCase(),
        name: field.label.toLowerCase(),
        kind: 'field',
        icon: 'sliders-horizontal',
        moduleId: module.id,
        field: field.path,
        ...(area ? { area: area.id } : {}),
      });
    }
  }

  return entries;
}

// A module beats a view beats an area beats a field, but only at the same match quality: an exact
// field label still answers before a module that merely shares a word with one of its aliases.
const KIND_SCORE: Record<PaletteKind, number> = { module: 3, view: 2, area: 1, field: 0 };

function paletteScore(entry: PaletteEntry, needle: string, tokens: readonly string[]): number {
  if (!tokens.every((token) => entry.haystack.includes(token))) return -1;

  const quality =
    entry.name === needle
      ? 60
      : entry.name.startsWith(needle)
        ? 50
        : tokens.every((token) => entry.name.includes(token))
          ? 45
          : 20;

  return quality + KIND_SCORE[entry.kind];
}

/**
 * Every match, ranked, not the first nine the registry happened to list. The tokens are matched
 * independently so "queue ticket" finds the ticket queue, and the whole set is returned because the
 * list scrolls and the count is on screen — a silent cap cannot be told from "there is nothing else".
 */
export function paletteResults(index: readonly PaletteEntry[], query: string): PaletteEntry[] {
  const needle = query.trim().toLowerCase();

  if (!needle) {
    const named = index.filter((entry) => entry.kind === 'module');

    // What this server has switched on, first: the empty state used to be registry order, which
    // opened on Help and Ping.
    return [...named.filter((entry) => entry.on), ...named.filter((entry) => !entry.on)].slice(
      0,
      8,
    );
  }

  const tokens = needle.split(/\s+/).filter(Boolean);

  return index
    .map((entry) => ({ entry, score: paletteScore(entry, needle, tokens) }))
    .filter((hit) => hit.score >= 0)
    .sort((a, b) => b.score - a.score)
    .map((hit) => hit.entry);
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

    const to = modulePath(entry.moduleId);
    if (!to) return;

    void navigate({
      to,
      params: { guildId },
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
            Esc
          </button>
        </div>

        {/* On screen, not only in the live region: the list scrolls and is no longer capped, so the
            count is the only thing saying whether there is more of it below the fold. */}
        {query.trim() !== '' && results.length > 0 ? (
          <p className="palette-count">
            {results.length} {results.length === 1 ? 'result' : 'results'}
          </p>
        ) : null}

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
              {position === selected ? <span className="kbd">Enter</span> : null}
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
