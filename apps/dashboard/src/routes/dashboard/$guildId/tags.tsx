import { type TagSearchResult, tagQuerySchema } from '@proton/module-tags/query';
import { useSuspenseQuery } from '@tanstack/react-query';
import { createFileRoute, lazyRouteComponent, useNavigate } from '@tanstack/react-router';
import type { ReactElement } from 'react';
import { SectionCard } from '../../../components/form/section.tsx';
import { useModuleForm } from '../../../components/module/form.ts';
import { Toggle } from '../../../components/module/inputs.tsx';
import {
  ActiveView,
  ModuleChrome,
  ModuleSettings,
  tabsFor,
} from '../../../components/module/page.tsx';
import { moduleRoute } from '../../../components/module/route.tsx';
import {
  type ModuleView,
  type ViewEntry,
  viewSearchUpdate,
} from '../../../components/module/views.ts';
import { modulesQuery } from '../../../lib/queries.ts';
import { LIVE, queryKeys, STALE } from '../../../lib/query-keys.ts';

const VIEWS: readonly ModuleView[] = [
  {
    id: 'tags',
    title: 'Tags',
    searchSchema: tagQuerySchema,

    query: ({ guildId, search }) => ({
      queryKey: queryKeys.view(guildId, 'tags', search),

      // Imported lazily: server/modules.ts opens better-auth's database at module scope.
      queryFn: async () =>
        (await import('../../../server/modules.ts')).searchTags({ data: { guildId, ...search } }),
      staleTime: STALE.browse,
      ...LIVE,
    }),
    View: lazyRouteComponent(() => import('../../../components/views/views.tsx'), 'TagBrowserView'),
  } satisfies ViewEntry<typeof tagQuerySchema, TagSearchResult>,
];

export const Route = createFileRoute('/dashboard/$guildId/tags')({
  ...moduleRoute('tags', { views: VIEWS }),
  component: TagsPage,
});

function TagsPage(): ReactElement {
  const { guildId } = Route.useParams();
  const search = Route.useSearch();

  const summary = useSuspenseQuery(modulesQuery(guildId)).data.modules.find(
    (candidate) => candidate.id === 'tags',
  );

  const entry = VIEWS.find((candidate) => candidate.id === search.view);

  return (
    <>
      {summary ? (
        <ModuleChrome
          guildId={guildId}
          summary={summary}
          area={undefined}
          tabs={tabsFor(VIEWS, search.view)}
        />
      ) : null}

      {/* Split, not one component: the loader skips the config, channel and role fetches while a
          view tab is open, so mounting the settings form here would suspend on three of them. */}
      {entry ? <TagsBrowse entry={entry} /> : <TagsSettings />}
    </>
  );
}

function TagsBrowse({ entry }: { entry: ModuleView }): ReactElement {
  const { guildId } = Route.useParams();
  const { viewSearch } = Route.useLoaderData();
  const navigate = useNavigate({ from: Route.fullPath });

  return (
    <ActiveView
      entry={entry}
      guildId={guildId}
      search={viewSearch}
      onSearch={(patch) => void navigate(viewSearchUpdate(patch))}
    />
  );
}

function TagsSettings(): ReactElement {
  const { guildId } = Route.useParams();
  const form = useModuleForm(guildId, 'tags');

  return (
    <ModuleSettings form={form}>
      <SectionCard id="tags:posting" title="How tags are posted">
        <Toggle path="ephemeral" label="Show tags only to whoever asked" defaultValue={false} />
        <Toggle
          path="allowMentions"
          label="Let tag text ping people"
          help="A stored @everyone becomes pingable by any member"
          defaultValue={false}
        />
      </SectionCard>
    </ModuleSettings>
  );
}
