import { type BlockedMemberList, blockedMemberQuerySchema } from '@proton/core';
import { useSuspenseQuery } from '@tanstack/react-query';
import { createFileRoute, lazyRouteComponent, useNavigate } from '@tanstack/react-router';
import type { ReactElement } from 'react';
import { SectionCard } from '../../../components/form/section.tsx';
import { useModuleForm } from '../../../components/module/form.ts';
import { Duration, Num, Toggle } from '../../../components/module/inputs.tsx';
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
    id: 'blocked',
    title: 'Blocked members',
    searchSchema: blockedMemberQuerySchema,

    query: ({ guildId, search }) => ({
      queryKey: queryKeys.view(guildId, 'blocked', search),

      // Imported lazily: server/modules.ts opens better-auth's database at module scope.
      queryFn: async () =>
        (await import('../../../server/modules.ts')).searchBlockedMembers({
          data: { guildId, ...search },
        }),
      staleTime: STALE.browse,
      ...LIVE,
    }),
    View: lazyRouteComponent(
      () => import('../../../components/views/views.tsx'),
      'BlockedMembersView',
    ),
  } satisfies ViewEntry<typeof blockedMemberQuerySchema, BlockedMemberList>,
];

export const Route = createFileRoute('/dashboard/$guildId/moderation')({
  ...moduleRoute('moderation', { views: VIEWS }),
  component: ModerationPage,
});

function ModerationPage(): ReactElement {
  const { guildId } = Route.useParams();
  const search = Route.useSearch();

  const { modules } = useSuspenseQuery(modulesQuery(guildId)).data;

  const entry = VIEWS.find((view) => view.id === search.view);
  const summary = modules.find((candidate) => candidate.id === 'moderation');

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
  const form = useModuleForm(guildId, 'moderation');

  return (
    <ModuleSettings form={form}>
      <SectionCard id="moderation:general" title="General">
        <Toggle
          path="publicReplies"
          label="Announce outcomes in the channel"
          defaultValue={false}
        />
      </SectionCard>

      <SectionCard id="moderation:policy" title="Policy">
        <Toggle path="requireReason" label="Require a reason" defaultValue={false} />
        <Duration
          path="defaultTimeoutDuration"
          label="Default timeout length"
          help="Discord caps timeouts at 28 days"
          defaultValue="1h"
        />
        <Num
          path="defaultBanDeleteDays"
          label="Default message deletion on ban (days)"
          min={0}
          max={7}
          defaultValue={0}
        />
      </SectionCard>
    </ModuleSettings>
  );
}
