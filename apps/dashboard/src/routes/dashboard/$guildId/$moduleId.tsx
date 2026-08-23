import type { ModuleConfigView, ModuleSummary } from '@proton/core';
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
import { GeneratedForm, sectionKey } from '../../../components/form/generated-form.tsx';
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
import { moduleState, PageHead } from '../../../components/shell/app-shell.tsx';
import { Icon } from '../../../components/shell/icon.tsx';
import { configurableDescriptors, whereToFix } from '../../../components/shell/module-meta.ts';
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
  const tabs = tabsFor(viewsFor(moduleId), search.view);

  const areas = areasFor(moduleId);
  const area = areas.find((candidate) => candidate.id === search.area);
  const onHub = !entry && areas.length > 0 && area === undefined;

  return (
    <>
      <PageHead title={area ? area.title : summary.name} />

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

// The blocker hands whole locations, and every route's search schema in the union: read the one
// key that decides whether ModuleSettings survives the move.
function viewOf(location: { search: unknown }): unknown {
  const search = location.search;

  return typeof search === 'object' && search !== null
    ? (search as Record<string, unknown>).view
    : undefined;
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
            <span className="area-count">{count}</span>
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
    },
  });

  const dirty =
    JSON.stringify(values) !== JSON.stringify(baseline.values) ||
    JSON.stringify(panelValues) !== JSON.stringify(baseline.panelValues);

  const blocker = useBlocker({
    // Moving between areas keeps this component mounted, so the edits survive the move and there
    // is nothing to lose — confirming a discard there would be confirming a loss that cannot
    // happen. Switching to a data view does unmount it, and is still blocked.
    shouldBlockFn: ({ current, next }) =>
      dirty && !(current.pathname === next.pathname && viewOf(current) === viewOf(next)),
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

  const state = moduleState(summary);
  const enabled = summary.enabled;
  const guildName = guilds.find((guild) => guild.id === guildId)?.name ?? 'this server';

  // Rendering only. `descriptors` and `panels` stay whole above, because toConfig rebuilds the
  // config from the descriptor list it is given — narrowing that one would save an area's fields
  // over the config and drop every other area's.
  const sections = shownSections(area, summary.dashboard?.sections);
  const fields = shownDescriptors(area, descriptors, summary.dashboard?.sections);
  const areaPanels = shownPanels(area, panels);

  const hasChannelField = fields.some((descriptor) => descriptor.kind === 'channel-id');

  return (
    <>
      {enabled && (state === 'blocked' || state === 'degraded') ? (
        <div className={`gap-card${state === 'degraded' ? ' gap-card-warn' : ''}`}>
          <div className="gap-body">
            <span className="gap-head">
              <Icon
                name={state === 'degraded' ? 'warning' : 'warning-circle'}
                weight="fill"
                className={`state-${state}`}
              />
              <span className="gap-name">Not running</span>
            </span>
            <p className="gap-text" role="alert">
              {summary.status?.disabledReason?.humanReason}
            </p>
            {whereToFix(summary.status?.disabledReason?.code) ? (
              <span className="where">
                <Icon name="arrow-elbow-down-right" />
                {whereToFix(summary.status?.disabledReason?.code)}
              </span>
            ) : null}
          </div>
        </div>
      ) : null}

      <GeneratedForm
        descriptors={fields}
        values={values}
        channels={channels}
        roles={roles}
        sections={sections}
        scope={moduleId}
        onChange={(path, value) => setValues((prev) => ({ ...prev, [path]: value }))}
      />

      {hasChannelField ? (
        <p className="status">
          Channels Proton cannot view are not listed here, because Discord never returns them.
        </p>
      ) : null}

      {areaPanels.map((panel) => {
        const key = panel.key;
        const Panel = panel.Panel;

        return (
          <SectionCard
            key={key ?? panel.title}
            id={sectionKey(moduleId, `panel:${key ?? panel.title}`)}
            title={panel.title}
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

      <div aria-live="polite">
        {save.isSuccess && !dirty ? (
          <span className="saved-line">
            <Icon name="check-circle" weight="fill" />
            Saved. Changes are live in {guildName}.
          </span>
        ) : null}
      </div>

      {save.error ? (
        <p className="field-error" role="alert">
          {save.error.message}
        </p>
      ) : null}

      {dirty ? (
        <div className="save-bar">
          <div className="save-bar-inner">
            <span className="save-bar-text">You have unsaved changes.</span>
            <button type="button" className="button button-ghost" onClick={reset}>
              Reset
            </button>
            <button
              type="button"
              className="button"
              disabled={save.isPending}
              onClick={() => save.mutate({ values, panelValues })}
            >
              {save.isPending ? 'Saving…' : 'Save changes'}
            </button>
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
  return (
    <div className="palette-scrim">
      <div className="confirm" role="alertdialog" aria-modal="true" aria-labelledby="leave-title">
        <h2 className="confirm-title" id="leave-title">
          Leave {moduleName} without saving?
        </h2>
        <p className="confirm-text">
          The changes on this page have not been sent to Proton yet. Leaving discards them.
        </p>
        <div className="confirm-actions">
          <button type="button" className="button button-quiet" onClick={onStay}>
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
      </div>
    </>
  );
}
