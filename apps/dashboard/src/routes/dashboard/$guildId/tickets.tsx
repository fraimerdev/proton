import {
  type TicketPanel,
  type TicketResponse,
  type TicketType,
  ticketPanelsSchema,
  ticketResponsesSchema,
  ticketTypesSchema,
} from '@proton/module-tickets/config';
import { type TicketSearchResult, ticketQuerySchema } from '@proton/module-tickets/query';
import { useSuspenseQuery } from '@tanstack/react-query';
import { createFileRoute, lazyRouteComponent, useNavigate } from '@tanstack/react-router';
import type { ReactElement } from 'react';
import { SectionCard } from '../../../components/form/section.tsx';
import type { ModuleForm } from '../../../components/module/form.ts';
import { useModuleForm } from '../../../components/module/form.ts';
import {
  ChannelField,
  Duration,
  Num,
  Text,
  Tokens,
  usePanelSchema,
} from '../../../components/module/inputs.tsx';
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

const TicketTypesEditor = lazyRouteComponent(
  () => import('../../../components/tickets/types.tsx'),
  'TicketTypesEditor',
);

const TicketPanelsEditor = lazyRouteComponent(
  () => import('../../../components/tickets/panels.tsx'),
  'TicketPanelsEditor',
);

const TicketResponsesEditor = lazyRouteComponent(
  () => import('../../../components/tickets/responses.tsx'),
  'TicketResponsesEditor',
);

const VIEWS: readonly ModuleView[] = [
  {
    id: 'tickets',
    title: 'Tickets',
    searchSchema: ticketQuerySchema,

    query: ({ guildId, search }) => ({
      queryKey: queryKeys.view(guildId, 'tickets', search),

      // Imported lazily: server/modules.ts opens better-auth's database at module scope.
      queryFn: async () =>
        (await import('../../../server/modules.ts')).searchTickets({
          data: { guildId, ...search },
        }),
      staleTime: STALE.browse,
      ...LIVE,
    }),
    View: lazyRouteComponent(
      () => import('../../../components/views/views.tsx'),
      'TicketBrowserView',
    ),
  } satisfies ViewEntry<typeof ticketQuerySchema, TicketSearchResult>,
];

export const Route = createFileRoute('/dashboard/$guildId/tickets')({
  ...moduleRoute('tickets', {
    views: VIEWS,
    preload: [TicketTypesEditor, TicketPanelsEditor, TicketResponsesEditor],
  }),
  component: TicketsPage,
});

function TicketsPage(): ReactElement {
  const { guildId } = Route.useParams();
  const search = Route.useSearch();

  const summary = useSuspenseQuery(modulesQuery(guildId)).data.modules.find(
    (candidate) => candidate.id === 'tickets',
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
      {entry ? <TicketsBrowse entry={entry} /> : <TicketsSettings />}
    </>
  );
}

function TicketsBrowse({ entry }: { entry: ModuleView }): ReactElement {
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

function TicketsSettings(): ReactElement {
  const { guildId } = Route.useParams();
  const form = useModuleForm(guildId, 'tickets');

  return (
    <ModuleSettings form={form}>
      <SectionCard id="tickets:general" title="General">
        <Tokens
          path="staffRoleIds"
          kind="role-id"
          label="Support roles"
          help="Reach every ticket. A ticket type can add roles that reach only its own."
          maxItems={20}
        />
      </SectionCard>

      <SectionCard id="tickets:channels" title="Ticket channels">
        <Text
          path="namePattern"
          label="Ticket channel name"
          help="Used when a ticket type does not set its own. {number}, {user} and {type} are replaced."
          minLength={1}
          maxLength={100}
          defaultValue="ticket-{number}"
          // The schema refines this, and a length check cannot see it: without {number} or {user}
          // every ticket channel would be named the same, so the API refused the whole save.
          validate={(value) =>
            value.includes('{number}') || value.includes('{user}')
              ? null
              : 'A ticket channel name needs {number} or {user} in it, or every ticket would share one name.'
          }
        />
        <Text
          path="closeConfirmation"
          label="Closing message"
          minLength={1}
          maxLength={2000}
          defaultValue="This ticket is closed. Staff can reopen it, and it will be tidied up later."
        />
      </SectionCard>

      <SectionCard id="tickets:limits" title="Limits">
        <Num
          path="maxOpenPerUser"
          label="Open tickets per member"
          help="A ticket type may set a lower limit of its own. Your plan caps this too."
          min={1}
          max={100}
          defaultValue={3}
        />
        <Num
          path="maxOpenPerGuild"
          label="Open tickets in the whole server"
          help="A ceiling on the queue. Discord allows 500 channels in a server in total."
          min={1}
          max={500}
          defaultValue={200}
        />
        <Duration path="creationCooldown" label="Wait between opening tickets" defaultValue="5s" />
        <Text
          path="blacklistMessage"
          label="Message for blacklisted members"
          minLength={1}
          maxLength={500}
          defaultValue="You cannot open tickets in this server."
        />
      </SectionCard>

      <SectionCard id="tickets:records" title="Logging and transcripts">
        <ChannelField path="logChannelId" label="Ticket log channel" channelTypes={[0]} optional />
        <ChannelField
          path="transcriptChannelId"
          label="Transcript channel"
          help="Used when a ticket type does not name one of its own."
          channelTypes={[0]}
          optional
        />
      </SectionCard>

      {/* Before panels, because a panel has nothing to offer until a type exists. */}
      <SectionCard id="tickets:panel:types" title="Ticket types">
        <Types form={form} />
      </SectionCard>

      <SectionCard id="tickets:panel:panels" title="Ticket panels">
        <Panels form={form} />
      </SectionCard>

      <SectionCard id="tickets:panel:responses" title="Saved replies">
        <Responses form={form} />
      </SectionCard>
    </ModuleSettings>
  );
}

function Types({ form }: { form: ModuleForm }): ReactElement {
  const types = form.value('types', []) as TicketType[];
  usePanelSchema('types', 'Ticket types', ticketTypesSchema, types);

  return (
    <TicketTypesEditor
      types={types}
      channels={form.channels}
      roles={form.roles}
      tier={form.tier}
      onChange={(next) => form.set('types', next)}
    />
  );
}

function Panels({ form }: { form: ModuleForm }): ReactElement {
  const panels = form.value('panels', []) as TicketPanel[];
  usePanelSchema('panels', 'Ticket panels', ticketPanelsSchema, panels);

  return (
    <TicketPanelsEditor
      panels={panels}
      channels={form.channels}
      tier={form.tier}
      types={form.value('types', []) as TicketType[]}
      onChange={(next) => form.set('panels', next)}
    />
  );
}

function Responses({ form }: { form: ModuleForm }): ReactElement {
  const responses = form.value('responses', []) as TicketResponse[];
  usePanelSchema('responses', 'Saved replies', ticketResponsesSchema, responses);

  return (
    <TicketResponsesEditor responses={responses} onChange={(next) => form.set('responses', next)} />
  );
}
