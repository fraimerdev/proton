import type { ModuleSummary } from '@proton/core';
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
import { createFileRoute, Link, lazyRouteComponent, useNavigate } from '@tanstack/react-router';
import type { ReactElement, ReactNode } from 'react';
import { FieldRow, SectionCard, SettingsGrid } from '../../../components/form/section.tsx';
import type { AreaEntry } from '../../../components/module/areas.ts';
import { activeArea } from '../../../components/module/areas.ts';
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
import { Icon } from '../../../components/shell/icon.tsx';
import { moduleState } from '../../../components/shell/module-meta.ts';
import { useToggleModule } from '../../../components/shell/module-toggle.tsx';
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

/**
 * Three faces rather than five stacked cards. Declared here rather than in the shared area index:
 * tickets keeps one settings form across all three, so the navigation is a face switch and not the
 * hub-and-sub-page shape the indexed modules have.
 */
const FACES: readonly AreaEntry[] = [
  // Each blurb says something its face's own lede does not. A note under the tab that repeats the
  // paragraph below it is a line the reader has now read twice on one screen.
  {
    id: 'types',
    title: 'Ticket types',
    blurb: 'What a member picks when they open a ticket: who answers it, and where it lands.',
    icon: 'ticket',
  },
  {
    id: 'panels',
    title: 'Panels',
    blurb: 'Nothing opens a ticket until one of these is posted in a channel.',
    icon: 'layout',
  },
  {
    id: 'shared',
    title: 'Every ticket',
    blurb: 'What holds whatever kind of ticket it is — names, limits, logs and saved replies.',
    icon: 'sliders-horizontal',
  },
];

const VIEWS: readonly ModuleView[] = [
  {
    id: 'tickets',
    title: 'Ticket queue',
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
    areas: FACES,
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
  const face = activeArea(FACES, search.area);

  return (
    <>
      {summary ? (
        <ModuleChrome
          guildId={guildId}
          summary={summary}
          area={entry ? undefined : face}
          tabs={tabsFor(VIEWS, search.view, face?.id, FACES)}
        />
      ) : null}

      {/* Split, not one component: the loader skips the config, channel and role fetches while a
          view tab is open, so mounting the settings form here would suspend on three of them. */}
      {entry ? <TicketsBrowse entry={entry} /> : <TicketsSettings face={face?.id ?? 'types'} />}
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

function TicketsSettings({ face }: { face: string }): ReactElement {
  const { guildId } = Route.useParams();
  const form = useModuleForm(guildId, 'tickets');

  const types = form.value('types', []) as TicketType[];
  const panels = form.value('panels', []) as TicketPanel[];

  return (
    <ModuleSettings form={form}>
      <OffBand summary={form.summary} />

      {/* Every face stays mounted, hidden rather than unmounted: each editor reports its own list to
          the save gate, and a list left half-filled on the face nobody is looking at is the case the
          gate exists for. */}
      <div hidden={face !== 'types'}>
        {types.length === 0 ? (
          <Ordering>
            Nothing can be opened yet. Make a ticket type, attach it to a panel, then post the panel
            in a channel.
          </Ordering>
        ) : null}

        <SettingsGrid>
          <SectionCard id="tickets:panel:types" title={null} span="full">
            <Types form={form} />
          </SectionCard>
        </SettingsGrid>
      </div>

      <div hidden={face !== 'panels'}>
        {types.length === 0 && panels.length === 0 ? (
          <Ordering>
            No ticket type yet. A panel offers the types you attach to it, so there is nothing to
            put on one until a type exists.{' '}
            <Link to="." search={{ area: 'types' }}>
              Make a ticket type
            </Link>
            .
          </Ordering>
        ) : (
          <SettingsGrid>
            <SectionCard id="tickets:panel:panels" title={null} span="full">
              <Panels form={form} />
            </SectionCard>
          </SettingsGrid>
        )}
      </div>

      <div hidden={face !== 'shared'}>
        <SharedFace form={form} />
      </div>
    </ModuleSettings>
  );
}

function OffBand({ summary }: { summary: ModuleSummary }): ReactElement | null {
  const toggle = useToggleModule();
  if (moduleState(summary) !== 'off') return null;

  return (
    <div className="module-off">
      <Icon name="lightning-slash" />
      <p className="module-off-text">
        {summary.name} is switched off. These settings are saved, and nothing runs in this server
        until you switch it on.
      </p>
      <button type="button" className="button button-quiet" onClick={() => toggle(summary, true)}>
        Switch {summary.name} on
      </button>
    </div>
  );
}

function Ordering({ children }: { children: ReactNode }): ReactElement {
  return (
    <div className="module-first-run">
      <Icon name="lightbulb" />
      <p className="module-first-run-text">{children}</p>
    </div>
  );
}

function SharedFace({ form }: { form: ModuleForm }): ReactElement {
  return (
    <SettingsGrid>
      <SectionCard id="tickets:general" title="General" hint="Applies to every ticket.">
        <Tokens
          path="staffRoleIds"
          kind="role-id"
          label="Support roles"
          help="A ticket type can add roles that reach only its own tickets."
          maxItems={20}
        />
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
        <FieldRow>
          <ChannelField
            path="logChannelId"
            label="Ticket log channel"
            channelTypes={[0]}
            optional
          />
          <ChannelField
            path="transcriptChannelId"
            label="Transcript channel"
            help="Used when a ticket type does not name one of its own."
            channelTypes={[0]}
            optional
          />
        </FieldRow>
      </SectionCard>

      <SectionCard
        id="tickets:limits"
        title="Limits"
        hint="How many tickets a member can open, how often, and what a blacklisted member is told."
      >
        {/* The per-member cap and the server-wide one are read against each other — a member
            limit of 3 means nothing without knowing the queue stops at 200. */}
        <FieldRow>
          <Num
            path="maxOpenPerUser"
            label="Open per member"
            help="A ticket type may set a lower limit of its own. Your plan caps this too."
            min={1}
            max={100}
            defaultValue={3}
          />
          <Num
            path="maxOpenPerGuild"
            label="Open in the server"
            help="A ceiling on the queue. Discord allows 500 channels in a server in total."
            min={1}
            max={500}
            defaultValue={200}
          />
        </FieldRow>
        <Duration path="creationCooldown" label="Wait between opening tickets" defaultValue="5s" />
        <Text
          path="blacklistMessage"
          label="Message for blacklisted members"
          minLength={1}
          maxLength={500}
          defaultValue="You cannot open tickets in this server."
        />
      </SectionCard>

      <SectionCard id="tickets:panel:responses" title="Saved replies" span="full">
        <Responses form={form} />
      </SectionCard>
    </SettingsGrid>
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
      staffRoleIds={form.value('staffRoleIds', []) as string[]}
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
      roles={form.roles}
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
