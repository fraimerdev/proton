import { useSuspenseQuery } from '@tanstack/react-query';
import { Link, useRouterState } from '@tanstack/react-router';
import { type ReactElement, type ReactNode, useEffect } from 'react';
import { saveFailure } from '../../lib/errors.ts';
import { ConfirmDialog } from '../shell/confirm.tsx';
import { Icon } from '../shell/icon.tsx';
import { ModuleHeader } from '../shell/module-header.tsx';
import { moduleIcon, moduleState, shortReason } from '../shell/module-meta.ts';
import type { AreaEntry } from './areas.ts';
import type { ModuleForm } from './form.ts';
import { ModuleFormProvider } from './inputs.tsx';
import type { ModuleView } from './views.ts';

export interface TabDescriptor {
  key: string;
  title: string;
  search: Record<string, unknown>;
  current: boolean;
}

export const SETTINGS_TAB = 'settings';

// The settings tab is the absence of ?view=, not the id 'settings', which a view may legally own.
export function tabsFor(
  views: readonly { id: string; title: string }[],
  view: unknown,
  area?: string | undefined,
): readonly TabDescriptor[] {
  if (views.length === 0) return [];

  const active = views.find((entry) => entry.id === view);

  return [
    // Carries the open area, or the tab marked current navigates somewhere else when clicked —
    // to the module's hub, unmounting the settings form and the edits in it.
    {
      key: SETTINGS_TAB,
      title: 'Settings',
      search: area === undefined ? {} : { area },
      current: active === undefined,
    },
    ...views.map((entry) => ({
      key: `view:${entry.id}`,
      title: entry.title,
      search: { view: entry.id },
      current: entry === active,
    })),
  ];
}

export function ModuleChrome({
  summary,
  area,
  tabs,
}: {
  // Accepted and unused: every module page passes it, and the header stopped needing it when the
  // crumb became a relative link.
  guildId: string;
  summary: Parameters<typeof ModuleHeader>[0]['summary'];
  area: AreaEntry | undefined;
  tabs: readonly TabDescriptor[];
}): ReactElement {
  return (
    <>
      {/* Above the tabs, not inside the settings tab: the switch governs the whole module, and a
          data view is a face of the same module rather than a separate thing to turn on. */}
      <ModuleHeader summary={summary} area={area} showLede={area === undefined} />

      {tabs.length > 0 ? (
        <nav className="tabs" aria-label={`${summary.name} views`}>
          {tabs.map((tab) => (
            <Link
              key={tab.key}
              className="tab"
              to="."
              search={tab.search}
              aria-current={tab.current ? 'page' : undefined}
            >
              {tab.title}
            </Link>
          ))}
        </nav>
      ) : null}
    </>
  );
}

export function AreaHub({
  areas,
  config,
}: {
  areas: readonly AreaEntry[];
  config: Record<string, unknown>;
}): ReactElement {
  return (
    <ul className="area-menu">
      {areas.map((area) => {
        const count = area.count?.(config);

        return (
          <li className="area-card" key={area.id}>
            <span className="tile">
              <Icon name={area.icon} />
            </span>
            <Link to="." search={{ area: area.id }} className="area-open">
              <span className="area-title">{area.title}</span>
              <span className="area-blurb">{area.blurb}</span>
            </Link>
            {count === undefined ? null : (
              <span className={`area-count${count === null ? ' area-count-empty' : ''}`}>
                {count ?? 'None yet'}
              </span>
            )}
            <Icon name="caret-right" className="area-chevron" />
          </li>
        );
      })}
    </ul>
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

function useHashJump(): void {
  useEffect(() => {
    const hash = window.location.hash.slice(1);
    if (!hash) return;

    const target = [...document.querySelectorAll('[data-path]')].find(
      (element) => element.getAttribute('data-path') === hash,
    );
    if (!target) return;

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

    const frame = requestAnimationFrame(() => {
      target.scrollIntoView({ block: 'center' });
      target.classList.add('field-flash');

      // The field's own control, not the first focusable thing in the row: the head renders the
      // info trigger before the input, and landing on it means the next keystroke opens a tooltip.
      target
        .querySelector<HTMLElement>('input, select, textarea, .picker-trigger, .token-add')
        ?.focus({ preventScroll: true });
    });

    const timer = setTimeout(() => target.classList.remove('field-flash'), 1600);
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(timer);
    };
  }, []);
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
 * are the page's own; this owns the save bar, the announcement, and the discard confirmation.
 */
export function ModuleSettings({
  form,
  children,
}: {
  form: ModuleForm;
  children: ReactNode;
}): ReactElement {
  useHashJump();

  const { summary, guildName } = form;

  return (
    <ModuleFormProvider form={form}>
      {children}

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

      {/* Both outcomes belong in the bar that triggered them. Rendered in flow they landed after
          seven cards and a panel, so a save that failed from a sticky button at the bottom of the
          viewport reported itself three thousand pixels away. */}
      {form.dirty || form.error || form.settled ? (
        <div className="save-bar">
          <div className="save-bar-inner">
            <span className="save-bar-status">
              {/* The problem first: it is the reason Save is disabled right now, and testing it
                  last let a four-second-old "Saved." sit where the explanation belonged. */}
              {form.problem ? (
                <span className="save-bar-text save-bar-failed" role="alert">
                  <Icon name="warning-circle" weight="fill" />
                  {form.problem}
                </span>
              ) : form.error ? (
                <span className="save-bar-text save-bar-failed" role="alert">
                  <Icon name="warning-circle" weight="fill" />
                  {saveFailure(form.error, 'Could not save')}
                </span>
              ) : form.dirty ? (
                <span className="save-bar-text">You have unsaved changes.</span>
              ) : (
                <span className="save-bar-text save-bar-saved">
                  <Icon name="check-circle" weight="fill" />
                  {savedLine(moduleState(summary), summary, guildName)}
                </span>
              )}
            </span>

            {form.dirty ? (
              <>
                <button type="button" className="button button-ghost" onClick={form.reset}>
                  Reset
                </button>
                <button
                  type="button"
                  className="button"
                  disabled={form.saving || form.problem !== null}
                  onClick={form.save}
                >
                  {form.saving ? 'Saving…' : 'Save changes'}
                </button>
              </>
            ) : null}
          </div>
        </div>
      ) : null}

      {form.blocked ? (
        <LeaveConfirm moduleName={summary.name} onStay={form.stay} onLeave={form.leave} />
      ) : null}
    </ModuleFormProvider>
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
