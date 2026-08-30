import { type CaseSearchResult, caseQuerySchema } from '@proton/core';
import { type EscalationRung, escalationLadderSchema } from '@proton/module-cases';
import { useSuspenseQuery } from '@tanstack/react-query';
import { createFileRoute, lazyRouteComponent, useNavigate } from '@tanstack/react-router';
import type { ReactElement } from 'react';
import { EscalationLadderEditor } from '../../../components/cases/escalation-ladder.tsx';
import { SectionCard } from '../../../components/form/section.tsx';
import type { ModuleForm } from '../../../components/module/form.ts';
import { useModuleForm } from '../../../components/module/form.ts';
import { Duration, Num, usePanelSchema } from '../../../components/module/inputs.tsx';
import {
  ActiveView,
  ModuleChrome,
  ModuleSettings,
  tabsFor,
} from '../../../components/module/page.tsx';
import { moduleRoute } from '../../../components/module/route.tsx';
import type { ModuleView, ViewEntry } from '../../../components/module/views.ts';
import { viewSearchUpdate } from '../../../components/module/views.ts';
import { modulesQuery } from '../../../lib/queries.ts';
import { LIVE, queryKeys, STALE } from '../../../lib/query-keys.ts';

const VIEWS: readonly ModuleView[] = [
  {
    id: 'cases',
    title: 'Cases',
    searchSchema: caseQuerySchema,

    query: ({ guildId, search }) => ({
      queryKey: queryKeys.view(guildId, 'cases', search),

      // Imported lazily: server/modules.ts opens better-auth's database at module scope.
      queryFn: async () =>
        (await import('../../../server/modules.ts')).searchCases({ data: { guildId, ...search } }),
      staleTime: STALE.browse,
      ...LIVE,
    }),
    View: lazyRouteComponent(
      () => import('../../../components/views/views.tsx'),
      'CaseBrowserView',
    ),
  } satisfies ViewEntry<typeof caseQuerySchema, CaseSearchResult>,
];

export const Route = createFileRoute('/dashboard/$guildId/cases')({
  ...moduleRoute('cases', { views: VIEWS }),
  component: CasesPage,
});

function CasesPage(): ReactElement {
  const { guildId } = Route.useParams();
  const search = Route.useSearch();

  const { modules } = useSuspenseQuery(modulesQuery(guildId)).data;

  const entry = VIEWS.find((view) => view.id === search.view);
  const summary = modules.find((candidate) => candidate.id === 'cases');

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

      {/* Split out: useModuleForm suspends on three queries the loader skips for a browse tab. */}
      {entry ? <Browse guildId={guildId} entry={entry} /> : <Settings guildId={guildId} />}
    </>
  );
}

function Browse({ guildId, entry }: { guildId: string; entry: ModuleView }): ReactElement {
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

function Settings({ guildId }: { guildId: string }): ReactElement {
  const form = useModuleForm(guildId, 'cases');

  return (
    <ModuleSettings form={form}>
      <SectionCard id="cases:general" title="General">
        <Num
          path="historyLimit"
          label="Cases shown in /history"
          min={1}
          max={25}
          defaultValue={10}
        />
      </SectionCard>

      <SectionCard id="cases:escalation" title="Warn escalation">
        <Duration path="escalationWindow" label="Escalation window" defaultValue="30d" />
      </SectionCard>

      <SectionCard id="cases:panel:escalationLadder" title={null}>
        <Ladder form={form} />
      </SectionCard>
    </ModuleSettings>
  );
}

function Ladder({ form }: { form: ModuleForm }): ReactElement {
  const rungs = form.value('escalationLadder', []) as EscalationRung[];
  usePanelSchema('escalationLadder', 'Warn escalation', escalationLadderSchema, rungs);

  return (
    <EscalationLadderEditor rungs={rungs} onChange={(next) => form.set('escalationLadder', next)} />
  );
}
