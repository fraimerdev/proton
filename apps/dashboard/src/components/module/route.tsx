import { useQuery } from '@tanstack/react-query';
import { Link, useParams, useSearch } from '@tanstack/react-router';
import { zodValidator } from '@tanstack/zod-adapter';
import type { ReactElement } from 'react';
import { z } from 'zod';
import { documentTitle } from '../../lib/document-title.ts';
import {
  channelsQuery,
  moduleConfigQuery,
  modulesQuery,
  rolesQuery,
  sessionQuery,
} from '../../lib/queries.ts';
import { PageHead } from '../shell/app-shell.tsx';
import { Icon } from '../shell/icon.tsx';
import { Spinner } from '../shell/pending.tsx';
import type { AreaEntry } from './areas.ts';
import { activeArea, resolveArea } from './areas.ts';
import { ModuleChrome, tabsFor } from './page.tsx';
import type { ModuleView } from './views.ts';
import { parseViewSearch, resolveView } from './views.ts';

// Loose, because the active view's own filters ride in the same query string and a strict object
// would strip them before the loader could re-parse them with the view's real schema. `view` and
// `area` stay unknown so that `?view=1` reaches resolveView's sentence rather than dying here as a
// raw Zod issue dump.
export const moduleSearchSchema = z.looseObject({
  view: z.unknown().optional(),
  area: z.unknown().optional(),
});

export type ModuleSearch = z.infer<typeof moduleSearchSchema>;

export interface ModuleRouteSpec {
  areas?: readonly AreaEntry[];
  views?: readonly ModuleView[];

  // The page's lazy editors. Preloaded beside the config rather than after it, so a module with a
  // bespoke editor does not open on an empty section while its chunk is still in flight.
  preload?: readonly { preload?: (() => Promise<void> | undefined) | undefined }[];
}

export function moduleRoute(moduleId: string, spec: ModuleRouteSpec = {}) {
  const areas = spec.areas ?? [];
  const views = spec.views ?? [];
  const editors = spec.preload ?? [];

  return {
    validateSearch: zodValidator(moduleSearchSchema),
    loaderDeps: ({ search }: { search: ModuleSearch }) => search,

    loader: async ({
      context,
      params,
      deps,
    }: {
      context: { queryClient: import('@tanstack/react-query').QueryClient };
      params: { guildId: string };
      deps: ModuleSearch;
    }) => {
      const entry = resolveView(moduleId, views, deps.view);
      const viewSearch = entry ? parseViewSearch(entry, deps) : undefined;
      const { queryClient } = context;

      // Thrown from the loader like an unknown view, so a bad ?area= reaches the error component
      // with its sentence rather than rendering an empty settings page that looks like a broken
      // module.
      const area = resolveArea(moduleId, areas, deps.area);

      // Split by tab, not fetched together: a view renders none of the settings form, so asking
      // for the config, the channel list and the role list costs an api call and two Discord calls
      // whose answers are thrown away.
      const [{ modules }, { guilds }] = await Promise.all([
        queryClient.fetchQuery(modulesQuery(params.guildId)),
        queryClient.fetchQuery(sessionQuery()),

        entry
          ? Promise.all([
              queryClient.fetchQuery(entry.query({ guildId: params.guildId, search: viewSearch })),

              // Cleared after the first client load, hence the ?.() — the chunk arrives alongside
              // its data rather than after it, so the tab never opens on a suspense gap.
              entry.View.preload?.(),
            ])
          : Promise.all([
              queryClient.fetchQuery(moduleConfigQuery(params.guildId, moduleId)),
              queryClient.fetchQuery(channelsQuery(params.guildId)),
              queryClient.fetchQuery(rolesQuery(params.guildId)),

              // Cleared after the first client load, hence the ?.().
              ...editors.map((editor) => editor.preload?.()),
            ]),
      ]);

      const summary = modules.find((candidate) => candidate.id === moduleId);
      if (!summary)
        throw new Error(
          `This server has no '${moduleId}' module — the link may be out of date. Pick a ` +
            `module from the list on the left.`,
        );

      return {
        viewSearch,
        title: documentTitle(
          entry?.title ?? area?.title ?? summary.name,
          guilds.find((guild) => guild.id === params.guildId)?.name,
        ),
      };
    },

    head: ({ loaderData }: { loaderData?: { title: string } | undefined }) => ({
      meta: [{ title: loaderData?.title ?? documentTitle() }],
    }),

    pendingComponent: () => <ModulePending moduleId={moduleId} areas={areas} views={views} />,
    errorComponent: ({ error }: { error: Error }) => <ModuleError error={error} />,
  };
}

/**
 * The module list is fetched by the parent route and awaited before the shell renders, so this
 * page's name, category and blurb are in the cache while its own fetches are still out. A bare
 * spinner threw all of that away and then jumped the header into place when the config arrived.
 *
 * useQuery, not useSuspenseQuery: suspending here would replace the very header this exists to keep.
 */
function ModulePending({
  moduleId,
  areas,
  views,
}: {
  moduleId: string;
  areas: readonly AreaEntry[];
  views: readonly ModuleView[];
}): ReactElement {
  const { guildId } = useParams({ strict: false }) as { guildId: string };
  const search = useSearch({ strict: false }) as ModuleSearch;

  const summary = useQuery(modulesQuery(guildId)).data?.modules.find(
    (candidate) => candidate.id === moduleId,
  );

  const area = activeArea(areas, search.area);
  const entry = views.find((candidate) => candidate.id === search.view);

  return (
    <>
      {summary ? (
        <ModuleChrome
          guildId={guildId}
          summary={summary}
          area={entry ? undefined : area}
          tabs={tabsFor(views, search.view, area?.id)}
        />
      ) : null}
      <Spinner />
    </>
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

        {/* A stale ?area= or ?view= link is the common way in here, and the address bar is not a
            recovery. The link drops the search that caused it. */}
        <Link to="." search={{}} className="button button-quiet">
          Open its settings
        </Link>
      </div>
    </>
  );
}
