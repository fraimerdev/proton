import { useQuery, useSuspenseQuery } from '@tanstack/react-query';
import { Link, useRouterState } from '@tanstack/react-router';
import { type ReactElement, type ReactNode, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { saveFailure } from '../../lib/errors.ts';
import { moduleConfigQuery } from '../../lib/queries.ts';
import { EmojiCatalogProvider } from '../emoji/catalog.tsx';
import { useSaveSlot, useShellSaving } from '../shell/app-shell.tsx';
import { ConfirmDialog } from '../shell/confirm.tsx';
import { Icon } from '../shell/icon.tsx';
import { ModuleHeader } from '../shell/module-header.tsx';
import { moduleIcon, moduleState, settingsTabTitle, shortReason } from '../shell/module-meta.ts';
import { areasFor } from './area-index.ts';
import type { AreaCount, AreaEntry } from './areas.ts';
import { areaCount } from './areas.ts';
import type { ModuleForm } from './form.ts';
import { ModuleFormProvider } from './inputs.tsx';
import type { ModuleView } from './views.ts';

export interface TabDescriptor {
  key: string;
  title: string;
  search: Record<string, unknown>;
  current: boolean;
  kind: 'area' | 'view';
}

export const SETTINGS_TAB = 'settings';

/**
 * One strip, carrying both kinds of face a module has: the areas its settings are split into, and
 * the data views it also holds. They used to be two navigations — a page of link cards for the
 * areas, a tab row for the views — which cost a click and a screen to say what a row of words says.
 *
 * The settings tab is the absence of ?view=, not the id 'settings', which a view may legally own.
 */
export function tabsFor(
  views: readonly { id: string; title: string }[],
  view: unknown,
  area?: string | undefined,
  areas: readonly { id: string; title: string }[] = [],
): readonly TabDescriptor[] {
  const active = views.find((entry) => entry.id === view);

  const faces: TabDescriptor[] =
    areas.length > 0
      ? areas.map((entry, index) => ({
          key: `area:${entry.id}`,
          title: entry.title,
          search: { area: entry.id },
          // The first area is what ?area= resolves to when it is absent, so it is current on the
          // bare url as well as on its own.
          current:
            active === undefined && (area === entry.id || (area === undefined && index === 0)),
          kind: 'area' as const,
        }))
      : views.length > 0
        ? [
            {
              key: SETTINGS_TAB,
              title: 'Settings',
              search: {},
              current: active === undefined,
              kind: 'area' as const,
            },
          ]
        : [];

  if (faces.length === 0) return [];

  return [
    ...faces,
    ...views.map((entry) => ({
      key: `view:${entry.id}`,
      title: entry.title,
      search: { view: entry.id },
      current: entry === active,
      kind: 'view' as const,
    })),
  ];
}

export function ModuleChrome({
  guildId,
  summary,
  area,
  tabs,
}: {
  guildId: string;
  summary: Parameters<typeof ModuleHeader>[0]['summary'];
  area: AreaEntry | undefined;
  tabs: readonly TabDescriptor[];
}): ReactElement {
  // One face and nothing else to switch to is not a navigation. The strip is drawn only where
  // there is somewhere else to go.
  const navigable = tabs.length > 1;

  // enabled:false, so this reads the cache and never fetches: the loader has already put the config
  // there for every settings face, and a browse face renders none of it and must not pay for it.
  const config = useQuery({ ...moduleConfigQuery(guildId, summary.id), enabled: false }).data
    ?.config;

  const counts = new Map<string, AreaCount>();
  for (const entry of areasFor(summary.id)) {
    const count = areaCount(entry, config);
    if (count) counts.set(entry.id, count);
  }

  // Two at most: the head has one line, and a module with four counted areas would otherwise spend
  // it on a list.
  const fact =
    [...counts.values()]
      .map((count) => count.long)
      .slice(0, 2)
      .join(' · ') || null;

  return (
    <>
      {/* Above the tabs, not inside the settings tab: the switch governs the whole module, and a
          data view is a face of the same module rather than a separate thing to turn on. */}
      <ModuleHeader summary={summary} fact={fact} />

      {navigable ? (
        <nav className="tabs" aria-label={`${summary.name} sections`}>
          {tabs.map((tab) => {
            const count = tab.key.startsWith('area:')
              ? counts.get(tab.key.slice('area:'.length))
              : undefined;

            return (
              <Link
                key={tab.key}
                className="tab"
                data-kind={tab.kind}
                to="."
                search={tab.search}
                aria-current={tab.current ? 'page' : undefined}
              >
                {/* The settings face of a module with no sub-pages used to be called Settings, which
                    names the software rather than what it sets. */}
                {tab.key === SETTINGS_TAB ? settingsTabTitle(summary.id, summary.name) : tab.title}
                {count ? <span className="tab-count">{count.short}</span> : null}
              </Link>
            );
          })}
        </nav>
      ) : null}

      {/* Under the strip that named it, not in the page lede. The lede belongs to the module and
          has to stay put as the tabs are clicked, or the whole head jumps on every face change. */}
      {navigable && area?.blurb ? <p className="area-note">{area.blurb}</p> : null}
    </>
  );
}

export function saveAnnouncement(state: {
  dirty: boolean;
  error: unknown;
  settled: boolean;
  unreadable: boolean;
}): string {
  if (state.error || state.unreadable) return '';
  if (state.dirty) return 'You have unsaved changes.';

  return state.settled ? 'Saved.' : '';
}

/**
 * What a successful write actually changed in Discord. Branched on the module's state and not on
 * its switch: a module that is on but missing a permission is not running, and telling its admin
 * the change is live is the one thing the product promises never to do.
 */
export function savedLine(
  state: ReturnType<typeof moduleState>,
  summary: { name: string; status?: { disabledReason?: { code: string } | undefined } | null },
  guildName: string,
): string {
  if (state === 'running') return `Saved. Changes are live in ${guildName}.`;
  if (state === 'off')
    return `Saved. ${summary.name} is switched off, so nothing changes in ${guildName} yet.`;

  return `Saved, but ${summary.name} is not running: ${shortReason(
    summary.status?.disabledReason?.code,
  ).toLowerCase()}.`;
}

/**
 * Keyed on the router's hash, not read once on mount. ModuleSettings stays mounted across an area
 * change and across a hash-only navigation, so a palette jump made from inside the same module
 * changed the address bar and moved nothing — no scroll, no flash, no focus. It only ever appeared
 * to work when arriving from the hub or another module, which is when this happened to remount.
 */
function useHashJump(): void {
  // Stripped, because the two sources spell it differently: the router hands back the fragment
  // bare, `window.location.hash` keeps the '#', and a stray one matches no data-path at all.
  const hash = useRouterState({ select: (state) => state.location.hash }).replace(/^#/, '');

  useEffect(() => {
    if (!hash) return;

    let waiting: ReturnType<typeof setTimeout> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let attempts = 0;

    function jump(): void {
      const target = [...document.querySelectorAll('[data-path]')].find(
        (element) => element.getAttribute('data-path') === hash,
      );

      // A jump into another area of this module arrives before that area does — the settings body
      // is a spinner until its config resolves, so nothing is there to scroll to yet. Polled on a
      // timer rather than a frame, because a background or throttled tab stops serving frames and
      // the jump then never happened at all. Three seconds, then given up on.
      if (!target) {
        if (attempts++ < 60) waiting = setTimeout(jump, 50);
        return;
      }

      // A link into a section this user has collapsed would otherwise scroll to nothing at all.
      const body = target.closest('.form-section-body');
      if (body instanceof HTMLElement && body.hidden) {
        body.parentElement?.querySelector<HTMLButtonElement>('.form-section-toggle')?.click();
      }

      // Everything else between the target and the page that renders hidden rather than unmounting:
      // a field the current mode does not show, a section none of whose fields are shown. Scrolling
      // to a display:none element moves nothing and looks like a dead link.
      for (
        let node = target instanceof HTMLElement ? target : null;
        node !== null;
        node = node.parentElement
      ) {
        if (node.hidden && !node.classList.contains('form-section-body')) node.hidden = false;
      }

      target.scrollIntoView({ block: 'center' });
      target.classList.add('field-flash');

      // The field's own control, not the first focusable thing in the row: the head renders the
      // info trigger before the input, and landing on it means the next keystroke opens a tooltip.
      target
        .querySelector<HTMLElement>('input, select, textarea, .picker-trigger, .token-add')
        ?.focus({ preventScroll: true });

      timer = setTimeout(() => target.classList.remove('field-flash'), 1600);
    }

    jump();

    return () => {
      if (waiting !== undefined) clearTimeout(waiting);
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [hash]);
}

export function EmptyModule({
  summary,
}: {
  summary: { name: string; dashboard?: { icon?: string | null } | null };
}): ReactElement {
  return (
    <div className="card">
      <div className="empty-state">
        <span className="tile">
          <Icon name={moduleIcon(summary.dashboard?.icon)} />
        </span>
        <span className="empty-state-title">{summary.name} has nothing to configure.</span>
        <p className="status">
          It runs on the switch above. There is nothing else for this server to set.
        </p>
      </div>
    </div>
  );
}

/**
 * The settings body: everything a module page has in common below the tabs. The fields themselves
 * are the page's own; this owns the save state, the announcement, and the discard confirmation.
 */
export function ModuleSettings({
  form,
  children,
}: {
  form: ModuleForm;
  children: ReactNode;
}): ReactElement {
  useHashJump();

  const slot = useSaveSlot();
  const { summary, guildName } = form;

  // The bar's readout is 12px in the far corner of a 1240px page, and a refusal from the api is a
  // paragraph. It is reported here instead, where the work is and at full length; the bar keeps a
  // pointer to it. A field that is merely not filled in yet stays out of this — the field itself
  // says so, and a danger block appearing mid-keystroke would be shouting.
  const failure = form.error ? saveFailure(form.error, 'Could not save') : null;
  const failureRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (failure !== null) failureRef.current?.scrollIntoView({ block: 'nearest' });
  }, [failure]);

  // The primary control of this page is a button in a corner the keyboard cannot reach without
  // leaving the form. ⌘K was the only shortcut the shell bound.
  useEffect(() => {
    function onKey(event: KeyboardEvent): void {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 's') return;

      event.preventDefault();
      if (form.dirty && !form.saving && form.problem === null) form.save();
    }

    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [form.dirty, form.saving, form.problem, form.save]);

  return (
    <ModuleFormProvider form={form}>
      <div ref={failureRef}>
        {failure === null ? null : (
          <div className="save-stop">
            <Icon name="warning-circle" weight="fill" />
            <div className="save-stop-body">
              <span className="save-stop-head">Proton did not save {summary.name}</span>
              <p className="save-stop-text" role="alert">
                {failure}
              </p>
            </div>
          </div>
        )}
      </div>

      <EmojiCatalogProvider emojis={form.emojis} guildName={guildName} guildIcon={form.guildIcon}>
        {children}
      </EmojiCatalogProvider>

      {/* Mounted whether or not the bar is. A live region that arrives already holding its message
          is a region the reader was not watching, so the bar's own aria-live announced nothing the
          first time it appeared — which is the only time it matters. */}
      <span aria-live="polite" className="sr-only">
        {saveAnnouncement({
          dirty: form.dirty,
          error: form.error,
          settled: form.settled,
          unreadable: form.problem !== null,
        })}
      </span>

      {slot ? createPortal(<SaveState form={form} />, slot) : null}

      {form.blocked ? (
        <LeaveConfirm moduleName={summary.name} onStay={form.stay} onLeave={form.leave} />
      ) : null}
    </ModuleFormProvider>
  );
}

function SaveState({ form }: { form: ModuleForm }): ReactElement {
  const { summary, guildName } = form;

  // The header's master switch saves through the layout's toggle, not through this form, so a clean
  // form can still have a write in flight above it.
  const shellSaving = useShellSaving();

  const failure = form.error ? saveFailure(form.error, 'Could not save') : null;
  const saved = savedLine(moduleState(summary), summary, guildName);
  const idle =
    !form.dirty &&
    !form.settled &&
    !form.saving &&
    !shellSaving &&
    failure === null &&
    form.problem === null;

  return (
    <div className="save-state" data-idle={idle || undefined}>
      {/* The problem first: it is the reason Save is disabled right now, and testing it last let a
          four-second-old "Saved." sit where the explanation belonged. A refused write is a pointer
          only — its full text is in the content column, where it cannot be clamped at 12px. */}
      {form.problem ? (
        <span className="save-status save-bar-failed" role="alert" data-wrap="true">
          <Icon name="warning-circle" weight="fill" />
          {form.problem}
        </span>
      ) : failure !== null ? (
        <span className="save-status save-bar-failed">Not saved — see the page</span>
      ) : /* Before the dirty branch: this form stays dirty until the write lands, so a save in
             flight was reporting "Unsaved changes" beside a button reading "Saving…". */
      form.saving || shellSaving ? (
        <span className="save-status save-status-pending">Saving…</span>
      ) : form.dirty ? (
        <span className="save-status save-status-dirty">Unsaved changes</span>
      ) : form.settled ? (
        <span className="save-status save-status-saved" title={saved}>
          <Icon name="check-circle" weight="fill" />
          {saved}
        </span>
      ) : null}

      {form.dirty ? (
        <button type="button" className="button button-ghost" onClick={form.reset}>
          Reset
        </button>
      ) : null}
      <button
        type="button"
        className={form.dirty ? 'button' : 'button button-quiet'}
        // shellSaving too: the switch above writes through the layout, not through this form, so an
        // enabled Save used to sit beside the bar's own "Saving…".
        disabled={!form.dirty || form.saving || shellSaving || form.problem !== null}
        aria-keyshortcuts="Control+S Meta+S"
        onClick={form.save}
      >
        {form.saving ? 'Saving…' : 'Save changes'}
      </button>
    </div>
  );
}

function LeaveConfirm({
  moduleName,
  onStay,
  onLeave,
}: {
  moduleName: string;
  onStay: () => void;
  onLeave: () => void;
}): ReactElement {
  return (
    <ConfirmDialog
      title={`Leave ${moduleName} without saving?`}
      cancelLabel="Keep editing"
      confirmLabel="Discard changes"
      onCancel={onStay}
      onConfirm={onLeave}
    >
      The changes on this page have not been sent to Proton yet. Leaving discards them.
    </ConfirmDialog>
  );
}

export function ActiveView({
  entry,
  guildId,
  search,
  onSearch,
}: {
  entry: ModuleView;
  guildId: string;
  search: unknown;
  onSearch: (patch: Record<string, unknown>) => void;
}): ReactElement {
  const { data } = useSuspenseQuery(entry.query({ guildId, search }));
  const pending = useRouterState({ select: (state) => state.isLoading });

  return (
    <div className="view-pending" data-pending={pending || undefined} aria-busy={pending}>
      <entry.View search={search} data={data} onSearch={onSearch} />
    </div>
  );
}
