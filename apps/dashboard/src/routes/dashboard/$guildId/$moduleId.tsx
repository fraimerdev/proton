import type { FieldDescriptor, ModuleConfigView, ModuleSummary } from '@proton/core';
import { tryParseDuration } from '@proton/core';
import { useMutation, useQueryClient, useSuspenseQuery } from '@tanstack/react-query';
import {
  createFileRoute,
  Link,
  useBlocker,
  useNavigate,
  useRouterState,
} from '@tanstack/react-router';
import { zodValidator } from '@tanstack/zod-adapter';
import { type ReactElement, useEffect, useMemo, useRef, useState } from 'react';
import { GeneratedForm, hiddenBy, sectionKey } from '../../../components/form/generated-form.tsx';
import { SectionCard } from '../../../components/form/section.tsx';
import {
  type AreaEntry,
  areasFor,
  resolveArea,
  shownDescriptors,
  shownPanels,
  shownSections,
} from '../../../components/panels/areas.ts';
import {
  applyPanels,
  initialPanelValues,
  panelDescriptors,
  panelsFor,
} from '../../../components/panels/registry.ts';
import { PageHead } from '../../../components/shell/app-shell.tsx';
import { Icon } from '../../../components/shell/icon.tsx';
import { ModuleHeader } from '../../../components/shell/module-header.tsx';
import {
  configurableDescriptors,
  type ModuleState,
  moduleIcon,
  moduleState,
  shortReason,
} from '../../../components/shell/module-meta.ts';
import {
  type AnyViewEntry,
  activeView,
  type ModuleSearch,
  moduleSearchSchema,
  parseViewSearch,
  resolveView,
  tabsFor,
  viewSearchUpdate,
  viewsFor,
} from '../../../components/views/registry.ts';

import { toConfig, toFormValues } from '../../../lib/config-paths.ts';
import {
  channelsQuery,
  moduleConfigQuery,
  moduleDescriptorsQuery,
  modulesQuery,
  rolesQuery,
  sessionQuery,
} from '../../../lib/queries.ts';
import { queryKeys } from '../../../lib/query-keys.ts';
import { updateModuleConfig } from '../../../server/modules.ts';

export const Route = createFileRoute('/dashboard/$guildId/$moduleId')({
  validateSearch: zodValidator(moduleSearchSchema),
  loaderDeps: ({ search }) => search,
  loader: async ({ context, params, deps }) => {
    const entry = resolveView(params.moduleId, deps.view);
    const viewSearch = entry ? parseViewSearch(entry, deps) : undefined;
    const { queryClient } = context;

    // Thrown from the loader like an unknown view, so a bad ?area= reaches the error component with
    // its sentence rather than rendering an empty settings page that looks like a broken module.
    resolveArea(params.moduleId, deps.area);

    // Split by tab, not fetched together: a view renders none of the settings form, so asking for
    // the config, the channel list and the role list costs an api call and two Discord calls whose
    // answers are thrown away. What is left is a cache hit once the shell has loaded.
    const [{ modules }] = await Promise.all([
      queryClient.fetchQuery(modulesQuery(params.guildId)),

      entry
        ? Promise.all([
            queryClient.fetchQuery(entry.query({ guildId: params.guildId, search: viewSearch })),

            // Cleared after the first client load, hence the ?.() — the chunk arrives alongside its
            // data rather than after it, so the tab never opens on a suspense gap.
            entry.View.preload?.(),
          ])
        : Promise.all([
            queryClient.fetchQuery(moduleConfigQuery(params.guildId, params.moduleId)),
            queryClient.fetchQuery(moduleDescriptorsQuery(params.guildId, params.moduleId)),
            queryClient.fetchQuery(channelsQuery(params.guildId)),
            queryClient.fetchQuery(rolesQuery(params.guildId)),

            // Same reason as the view components: the chunk lands beside its data rather than
            // after it, so a module with a panel does not open on an empty section.
            ...panelsFor(params.moduleId).map((entry) => entry.Panel.preload?.()),
          ]),
    ]);

    if (!modules.some((candidate) => candidate.id === params.moduleId))
      throw new Error(`unknown module '${params.moduleId}'`);

    return { viewSearch };
  },
  component: ModulePage,
  errorComponent: ModuleError,
});

interface Baseline {
  values: Record<string, unknown>;
  panelValues: Record<string, unknown>;
}

/**
 * What a successful write actually changed in Discord. Branched on the module's state and not on
 * its switch: a module that is on but missing a permission is not running, and telling its admin
 * the change is live is the one thing the product promises never to do.
 */
export function savedLine(
  state: ModuleState,
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

// Why Save is refusing, named alongside the setting holding the field off the page: two of
// verification's durations sit behind a showWhen, and dropping hidden descriptors from the gate
// instead would only move the same refusal to the API, which cannot see the mode at all.
export function unreadableLine(
  descriptor: FieldDescriptor,
  descriptors: readonly FieldDescriptor[],
  values: Record<string, unknown>,
): string {
  const opening = `“${descriptor.label}” is not a duration yet`;
  const holding = hiddenBy(descriptor, descriptors, values);

  return holding === null
    ? `${opening}.`
    : `${opening}, and this page only shows it while ${holding}.`;
}

function moduleOf(modules: readonly ModuleSummary[], moduleId: string): ModuleSummary {
  const found = modules.find((candidate) => candidate.id === moduleId);
  if (!found) throw new Error(`unknown module '${moduleId}'`);

  return found;
}

function ModulePage(): ReactElement {
  const { guildId, moduleId } = Route.useParams();
  const { viewSearch } = Route.useLoaderData();
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });

  const { modules } = useSuspenseQuery(modulesQuery(guildId)).data;

  const summary = useMemo(() => moduleOf(modules, moduleId), [modules, moduleId]);
  const commands = useMemo(
    () => [...new Set(modules.flatMap((candidate) => candidate.commands))].sort(),
    [modules],
  );

  const entry = activeView(moduleId, search.view);

  const areas = areasFor(moduleId);
  const area = areas.find((candidate) => candidate.id === search.area);
  const tabs = tabsFor(viewsFor(moduleId), search.view, area?.id);
  const onHub = !entry && areas.length > 0 && area === undefined;

  return (
    <>
      {/* Above the tabs, not inside the settings tab: the switch governs the whole module, and a
          data view is a face of the same module rather than a separate thing to turn on. */}
      <ModuleHeader
        guildId={guildId}
        summary={summary}
        area={entry ? undefined : area}
        showLede={!entry}
      />

      {tabs.length > 0 ? (
        <nav className="tabs" aria-label={`${summary.name} views`}>
          {tabs.map((tab) => (
            <Link
              key={tab.key}
              className="tab"
              to="/dashboard/$guildId/$moduleId"
              params={{ guildId, moduleId }}
              search={tab.search}
              aria-current={tab.current ? 'page' : undefined}
            >
              {tab.title}
            </Link>
          ))}
        </nav>
      ) : null}

      {entry ? (
        <ActiveView
          entry={entry}
          guildId={guildId}
          search={viewSearch}
          onSearch={(patch) => void navigate(viewSearchUpdate(patch))}
        />
      ) : onHub ? (
        <AreaHub guildId={guildId} moduleId={moduleId} areas={areas} />
      ) : (
        // Keyed on the module, so opening the next one remounts rather than carrying the previous
        // one's edits over. The settings queries live in here for the same reason the loader only
        // fetches them when no view tab is open: a view renders none of it.
        <ModuleSettings
          key={moduleId}
          area={area}
          guildId={guildId}
          moduleId={moduleId}
          summary={summary}
          commands={commands}
        />
      )}
    </>
  );
}

// The blocker hands whole locations, and every route's search schema in the union: read the keys
// that decide whether ModuleSettings survives the move.
function searchKey(location: { search: unknown }, key: string): unknown {
  const search = location.search;

  return typeof search === 'object' && search !== null
    ? (search as Record<string, unknown>)[key]
    : undefined;
}

/**
 * Whether the settings form is still on screen after the move, and so still holding its edits.
 * Two areas of one module keep it mounted; leaving the last area for the hub does not, because
 * the hub replaces the whole subtree — and that discard used to happen with no confirmation at all.
 */
export function settingsSurvives(
  moduleId: string,
  current: { pathname: string; search: unknown },
  next: { pathname: string; search: unknown },
): boolean {
  if (current.pathname !== next.pathname) return false;
  if (searchKey(current, 'view') !== searchKey(next, 'view')) return false;
  if (areasFor(moduleId).length === 0) return true;

  return searchKey(current, 'area') !== undefined && searchKey(next, 'area') !== undefined;
}

function AreaHub({
  guildId,
  moduleId,
  areas,
}: {
  guildId: string;
  moduleId: string;
  areas: readonly AreaEntry[];
}): ReactElement {
  const settings = useSuspenseQuery(moduleConfigQuery(guildId, moduleId)).data;

  return (
    <div className="module-list">
      {areas.map((area) => {
        const count = area.count?.(settings.config);

        return (
          <div className="module-row" key={area.id}>
            <i>
              <Icon name={area.icon} />
            </i>
            <Link
              to="/dashboard/$guildId/$moduleId"
              params={{ guildId, moduleId }}
              search={{ area: area.id }}
              className="module-open"
            >
              <span className="module-name">{area.title}</span>
              <span className="module-desc module-desc-plain">{area.blurb}</span>
            </Link>
            {count === undefined ? null : (
              <span className={`area-count${count === null ? ' area-count-empty' : ''}`}>
                {count ?? 'None yet'}
              </span>
            )}
            <Icon name="arrow-right" className="area-chevron" />
          </div>
        );
      })}
    </div>
  );
}

function ModuleSettings({
  area,
  guildId,
  moduleId,
  summary,
  commands,
}: {
  area: AreaEntry | undefined;
  guildId: string;
  moduleId: string;
  summary: ModuleSummary;
  commands: readonly string[];
}): ReactElement {
  const hash = useRouterState({ select: (state) => state.location.hash });
  const queryClient = useQueryClient();

  const settings = useSuspenseQuery(moduleConfigQuery(guildId, moduleId)).data;
  const channels = useSuspenseQuery(channelsQuery(guildId)).data;
  const roles = useSuspenseQuery(rolesQuery(guildId)).data;
  const { guilds } = useSuspenseQuery(sessionQuery()).data;

  // Off the module index and onto their own hour-long cache entry: 26 kB of descriptors for 27
  // modules rode every guild page load so that one form could read one module's worth.
  const { descriptors: declared } = useSuspenseQuery(
    moduleDescriptorsQuery(guildId, moduleId),
  ).data;

  const panels = useMemo(() => panelsFor(moduleId), [moduleId]);

  const descriptors = useMemo(
    () => [...configurableDescriptors(declared), ...panelDescriptors(moduleId, commands)],
    [moduleId, declared, commands],
  );

  const seed = (stored: ModuleConfigView): Baseline => ({
    values: toFormValues(descriptors, stored.config),
    panelValues: initialPanelValues(moduleId, stored.config),
  });

  const [values, setValues] = useState(() => seed(settings).values);
  const [panelValues, setPanelValues] = useState(() => seed(settings).panelValues);
  const [baseline, setBaseline] = useState<Baseline>(() => seed(settings));

  // Holds the save bar open through the confirmation. Without it the bar — and the only place the
  // outcome is reported — vanishes in the same frame the write lands.
  const [settled, setSettled] = useState(false);

  function reseed(stored: ModuleConfigView): void {
    const next = seed(stored);

    setValues(next.values);
    setPanelValues(next.panelValues);
    setBaseline(next);
  }

  const save = useMutation({
    mutationFn: (submitted: Baseline) =>
      updateModuleConfig({
        data: {
          guildId,
          moduleId,
          config: applyPanels(
            moduleId,
            toConfig(descriptors, submitted.values, settings.config),
            submitted.panelValues,
          ),
        },
      }),

    // Re-seeded from result.after, not from what was submitted: the API normalises some configs on
    // the way in — the permissions module prunes empty override lists — so trusting the submission
    // would leave the form showing values the server did not keep, and no unsaved-changes bar.
    onSuccess: (result) => {
      queryClient.setQueryData(moduleConfigQuery(guildId, moduleId).queryKey, result.after);
      void queryClient.invalidateQueries({ queryKey: queryKeys.modules(guildId) });
      reseed(result.after);
      setSettled(true);
    },
  });

  useEffect(() => {
    if (!settled) return;

    const timer = setTimeout(() => setSettled(false), 4000);
    return () => clearTimeout(timer);
  }, [settled]);

  const dirty =
    JSON.stringify(values) !== JSON.stringify(baseline.values) ||
    JSON.stringify(panelValues) !== JSON.stringify(baseline.panelValues);

  const blocker = useBlocker({
    // Moving between two areas keeps this component mounted, so the edits survive the move and
    // confirming a discard there would be confirming a loss that cannot happen. Leaving the last
    // area for the hub does unmount it — `onHub` swaps the whole subtree — as does switching to a
    // data view, and both are blocked.
    shouldBlockFn: ({ current, next }) => dirty && !settingsSurvives(moduleId, current, next),
    enableBeforeUnload: () => dirty,
    withResolver: true,
  });

  // Live form values, not settings.config: the matrix must show where logs land after unsaved edits.
  const liveConfig = useMemo(
    () => toConfig(descriptors, values, settings.config),
    [descriptors, values, settings.config],
  );

  useEffect(() => {
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
    // an off rule's body, a field the current mode does not show, a section none of whose fields
    // are shown. Scrolling to a display:none element moves nothing and looks like a dead link.
    // The collapsed body above is not one of these — it is React state, and the toggle owns it.
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
    });

    const timer = setTimeout(() => target.classList.remove('field-flash'), 1600);
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(timer);
    };
  }, [hash]);

  function reset(): void {
    setValues(baseline.values);
    setPanelValues(baseline.panelValues);
    setSettled(false);
    save.reset();
  }

  const seededFrom = useRef(settings);

  // The loader awaits fetchQuery, so the mount seed is already fresh; this catches the other way
  // in — a save, or an invalidation from elsewhere, replacing the config under an untouched form.
  useEffect(() => {
    if (seededFrom.current === settings) return;
    seededFrom.current = settings;

    if (!dirty) reseed(settings);
  });

  const guildName = guilds.find((guild) => guild.id === guildId)?.name ?? 'this server';

  // Rendering only. `descriptors` and `panels` stay whole above, because toConfig rebuilds the
  // config from the descriptor list it is given — narrowing that one would save an area's fields
  // over the config and drop every other area's.
  const sections = shownSections(area, summary.dashboard?.sections);
  const fields = shownDescriptors(area, descriptors, summary.dashboard?.sections);
  const areaPanels = shownPanels(area, panels);

  // Which sections a collapsed form is hiding an edit inside. The save bar says work is unsaved;
  // on a seven-section module it cannot say where, and reopening every card to find it is the
  // whole complaint.
  const changed = new Set(
    Object.keys(values).filter(
      (path) => JSON.stringify(values[path]) !== JSON.stringify(baseline.values[path]),
    ),
  );

  // Checked over every descriptor, not just this area's: the save writes the whole config, so a
  // duration left unreadable on another area would be rejected by the API with the field named and
  // nothing on screen to fix. Naming it here is the difference between the two.
  const unreadable = descriptors.find(
    (descriptor) =>
      descriptor.kind === 'duration' &&
      typeof values[descriptor.path] === 'string' &&
      values[descriptor.path] !== '' &&
      tryParseDuration(values[descriptor.path] as string) === null,
  );

  if (fields.length === 0 && areaPanels.length === 0) {
    return (
      <div className="card">
        <div className="empty-state">
          <span className="tile">
            <Icon name={moduleIcon(summary.dashboard?.icon)} />
          </span>
          <span className="empty-state-title">{summary.name} has nothing to configure.</span>
          <p className="status">
            It runs on the switch above. Everything else about it is decided by Proton’s own
            deployment, not by this server.
          </p>
        </div>
      </div>
    );
  }

  return (
    <>
      <GeneratedForm
        descriptors={fields}
        values={values}
        changed={changed}
        channels={channels}
        roles={roles}
        sections={sections}
        scope={moduleId}
        suppressTitle={area?.title}
        onChange={(path, value) => setValues((prev) => ({ ...prev, [path]: value }))}
      />

      {areaPanels.map((panel) => {
        const key = panel.key;
        const Panel = panel.Panel;

        return (
          <SectionCard
            key={key ?? panel.title}
            id={sectionKey(moduleId, `panel:${key ?? panel.title}`)}
            title={panel.title === area?.title ? null : panel.title}
            edited={
              key !== null &&
              JSON.stringify(panelValues[key]) !== JSON.stringify(baseline.panelValues[key])
            }
          >
            <Panel
              value={key === null ? undefined : panelValues[key]}
              onChange={
                key === null
                  ? () => undefined
                  : (next) => setPanelValues((prev) => ({ ...prev, [key]: next }))
              }
              channels={channels}
              roles={roles}
              liveConfig={liveConfig}
              guildId={guildId}
            />
          </SectionCard>
        );
      })}

      {/* Both outcomes belong in the bar that triggered them. Rendered in flow they landed after
          seven cards and a panel, so a save that failed from a sticky button at the bottom of the
          viewport reported itself three thousand pixels away. */}
      {dirty || save.error || settled ? (
        <div className="save-bar">
          <div className="save-bar-inner">
            <span className="save-bar-status" aria-live="polite">
              {save.error ? (
                <span className="save-bar-text save-bar-failed" role="alert">
                  <Icon name="warning-circle" weight="fill" />
                  Could not save: {save.error.message}
                </span>
              ) : settled ? (
                <span className="save-bar-text save-bar-saved">
                  <Icon name="check-circle" weight="fill" />
                  {savedLine(moduleState(summary), summary, guildName)}
                </span>
              ) : unreadable ? (
                <span className="save-bar-text save-bar-failed" role="alert">
                  <Icon name="warning-circle" weight="fill" />
                  {unreadableLine(unreadable, descriptors, values)}
                </span>
              ) : (
                <span className="save-bar-text">You have unsaved changes.</span>
              )}
            </span>

            {dirty ? (
              <>
                <button type="button" className="button button-ghost" onClick={reset}>
                  Reset
                </button>
                <button
                  type="button"
                  className="button"
                  disabled={save.isPending || unreadable !== undefined}
                  onClick={() => save.mutate({ values, panelValues })}
                >
                  {save.isPending ? 'Saving…' : 'Save changes'}
                </button>
              </>
            ) : null}
          </div>
        </div>
      ) : null}

      {blocker.status === 'blocked' ? (
        <LeaveConfirm moduleName={summary.name} onStay={blocker.reset} onLeave={blocker.proceed} />
      ) : null}
    </>
  );
}

function ActiveView({
  entry,
  guildId,
  search,
  onSearch,
}: {
  entry: AnyViewEntry;
  guildId: string;
  search: unknown;
  onSearch: (patch: ModuleSearch) => void;
}): ReactElement {
  const { data } = useSuspenseQuery(entry.query({ guildId, search }));

  return <entry.View search={search} data={data} onSearch={onSearch} />;
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
  const stay = useRef<HTMLButtonElement>(null);

  // Focus lands on the safe choice, not on the page behind the dialog — a confirm nobody's keyboard
  // is inside is a confirm the next Enter or Tab goes around.
  useEffect(() => {
    stay.current?.focus();

    function onKey(event: KeyboardEvent): void {
      if (event.key === 'Escape') {
        event.preventDefault();
        onStay();
      }
    }

    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onStay]);

  return (
    <div className="palette-scrim">
      <button
        type="button"
        className="palette-backdrop"
        aria-label="Keep editing"
        tabIndex={-1}
        onClick={onStay}
      />

      <div className="confirm" role="alertdialog" aria-modal="true" aria-labelledby="leave-title">
        <h2 className="confirm-title" id="leave-title">
          Leave {moduleName} without saving?
        </h2>
        <p className="confirm-text">
          The changes on this page have not been sent to Proton yet. Leaving discards them.
        </p>
        <div className="confirm-actions">
          <button ref={stay} type="button" className="button button-quiet" onClick={onStay}>
            Keep editing
          </button>
          <button type="button" className="button button-danger" onClick={onLeave}>
            Discard changes
          </button>
        </div>
      </div>
    </div>
  );
}

function ModuleError({ error }: { error: Error }): ReactElement {
  const { guildId, moduleId } = Route.useParams();

  return (
    <>
      <PageHead title="This page did not load" />
      <div className="gap-card">
        <div className="gap-body">
          <span className="gap-head">
            <Icon name="warning-circle" weight="fill" className="state-blocked" />
            <span className="gap-name">Proton could not open this module</span>
          </span>
          <p className="gap-text" role="alert">
            {error.message}
          </p>
        </div>

        {/* A stale ?area= or ?view= link is the common way in here, and the address bar is not a
            recovery. Both links drop the search that caused it. */}
        <Link
          to="/dashboard/$guildId/$moduleId"
          params={{ guildId, moduleId }}
          search={{}}
          className="button button-quiet"
        >
          Open its settings
        </Link>
      </div>
    </>
  );
}
