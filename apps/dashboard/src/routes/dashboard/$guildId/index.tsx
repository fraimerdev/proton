import type { ModuleSummary } from '@proton/core';
import { useQueries, useSuspenseQuery } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import type { ReactElement, ReactNode } from 'react';
import { moduleState } from '../../../components/module/page.tsx';
import { ModuleLink } from '../../../components/module/route.tsx';
import { Workspace } from '../../../components/shell/app-shell.tsx';
import { EmptyState, Spinner, StatusBanner } from '../../../components/ui/feedback.tsx';
import { Icon } from '../../../components/ui/icon.tsx';
import { Rows, Section } from '../../../components/ui/layout.tsx';
import { MODULE_BY_ID } from '../../../lib/modules/catalogue.ts';
import { modulesQuery, sessionQuery } from '../../../lib/queries.ts';
import { queryKeys } from '../../../lib/query-keys.ts';
import { searchBlockedMembers, searchCases, searchTickets } from '../../../server/modules.ts';

export const Route = createFileRoute('/dashboard/$guildId/')({
  component: Overview,
});

/**
 * One row of the operational area. The count is a real number from a real endpoint or it is not
 * shown at all — an overview that guesses is worse than an overview that is quiet.
 */
function FactRow({
  icon,
  label,
  detail,
  value,
  to,
  search,
  guildId,
}: {
  icon: Parameters<typeof Icon>[0]['name'];
  label: string;
  detail?: ReactNode;
  value: ReactNode;
  to?: string | undefined;
  search?: { area?: string | undefined } | undefined;
  guildId: string;
}): ReactElement {
  const body = (
    <>
      <Icon name={icon} size={17} className="nav-row-icon" />
      <span className="row-main">
        <span className="row-title">{label}</span>
        {detail !== undefined ? <span className="row-description">{detail}</span> : null}
      </span>
      <span className="row-control">{value}</span>
    </>
  );

  if (to === undefined) return <div className="nav-row">{body}</div>;

  return (
    <ModuleLink guildId={guildId} moduleId={to} search={{ area: search?.area }} className="nav-row">
      {body}
      <Icon name="caret-right" size={15} className="nav-row-chevron" />
    </ModuleLink>
  );
}

function Count({
  value,
  pending,
  failed,
  label,
}: {
  value: number | undefined;
  pending: boolean;
  failed: boolean;
  label: string;
}): ReactElement {
  if (failed) return <span className="text-muted text-sm">Unavailable</span>;
  if (pending || value === undefined) return <Spinner label={label} />;

  return <span className="text-secondary">{value}</span>;
}

function Attention({
  modules,
  guildId,
}: {
  modules: readonly ModuleSummary[];
  guildId: string;
}): ReactElement | null {
  const blocked = modules.filter((summary) => moduleState(summary) === 'attention');
  if (blocked.length === 0) return null;

  return (
    <StatusBanner
      tone="warning"
      title={blocked.length === 1 ? '1 module cannot run' : `${blocked.length} modules cannot run`}
    >
      <div className="stack stack-6" style={{ marginTop: 4 }}>
        {blocked.map((summary) => (
          <div key={summary.id}>
            <ModuleLink
              guildId={guildId}
              moduleId={summary.id}
              search={{ area: undefined }}
              className="text-primary"
              style={{ fontWeight: 'var(--weight-semibold)' }}
            >
              {MODULE_BY_ID.get(summary.id)?.label ?? summary.name}
            </ModuleLink>{' '}
            — {summary.status?.disabledReason?.humanReason ?? 'Proton did not say why.'}
          </div>
        ))}
      </div>
    </StatusBanner>
  );
}

function Overview(): ReactElement {
  const { guildId } = Route.useParams();
  const { guilds } = useSuspenseQuery(sessionQuery()).data;
  const { modules } = useSuspenseQuery(modulesQuery(guildId)).data;

  const guild = guilds.find((candidate) => candidate.id === guildId);
  const byId = new Map(modules.map((summary) => [summary.id, summary]));
  const on = (id: string): boolean => byId.get(id)?.enabled === true;

  // One page of one row each: the endpoints answer with a total, and the total is all this needs.
  const [cases, tickets, unclaimed, blocked] = useQueries({
    queries: [
      {
        queryKey: [...queryKeys.guild(guildId), 'overview', 'cases'],
        queryFn: () => searchCases({ data: { guildId, page: 1, pageSize: 1 } }),
        enabled: on('cases') || on('moderation'),
        retry: false,
      },
      {
        queryKey: [...queryKeys.guild(guildId), 'overview', 'tickets'],
        queryFn: () => searchTickets({ data: { guildId, page: 1, pageSize: 1, status: 'open' } }),
        enabled: on('tickets'),
        retry: false,
      },
      {
        queryKey: [...queryKeys.guild(guildId), 'overview', 'tickets-unclaimed'],
        queryFn: () => searchTickets({ data: { guildId, page: 1, pageSize: 100, status: 'open' } }),
        enabled: on('tickets'),
        retry: false,
      },
      {
        queryKey: [...queryKeys.guild(guildId), 'overview', 'blocked'],
        queryFn: () => searchBlockedMembers({ data: { guildId, page: 1, pageSize: 1 } }),
        enabled: on('moderation') || on('honeypot'),
        retry: false,
      },
    ],
  });

  const security = modules.filter(
    (summary) =>
      ['antinuke', 'antiraid', 'automod', 'honeypot', 'phishing', 'verification'].includes(
        summary.id,
      ) && summary.enabled,
  );

  const anythingOn = modules.some((summary) => summary.enabled);

  return (
    <Workspace>
      <header className="page-head">
        <div className="page-head-main">
          <h1 className="page-title">
            <Icon name="squares-four" size={28} className="page-title-icon" />
            Overview
          </h1>
          {guild ? <p className="page-subtitle">{guild.name}</p> : null}
        </div>
      </header>

      <div className="page-banners">
        <Attention modules={modules} guildId={guildId} />
      </div>

      {!anythingOn ? (
        <EmptyState icon="squares-four" title="Nothing is switched on" inset>
          Switch on a module in the sidebar.
        </EmptyState>
      ) : null}

      {security.length > 0 ? (
        <Section label="Security">
          <Rows>
            {security.map((summary) => {
              const meta = MODULE_BY_ID.get(summary.id);
              const state = moduleState(summary);

              return (
                <FactRow
                  key={summary.id}
                  guildId={guildId}
                  icon={meta?.icon ?? 'shield-check'}
                  label={meta?.label ?? summary.name}
                  to={summary.id}
                  value={
                    state === 'attention' ? (
                      <span className="text-warning text-sm">Cannot run</span>
                    ) : (
                      <span className="text-success text-sm">On</span>
                    )
                  }
                />
              );
            })}
          </Rows>
        </Section>
      ) : null}

      {on('cases') || on('moderation') || on('honeypot') ? (
        <Section label="Moderation">
          <Rows>
            {on('cases') || on('moderation') ? (
              <FactRow
                guildId={guildId}
                icon="clipboard-text"
                label="Cases"
                to="cases"
                search={{ area: 'log' }}
                value={
                  <Count
                    value={cases.data?.total}
                    pending={cases.isPending}
                    failed={cases.isError}
                    label="Loading cases"
                  />
                }
              />
            ) : null}
            {on('moderation') || on('honeypot') ? (
              <FactRow
                guildId={guildId}
                icon="prohibit"
                label="Blocked members"
                to="moderation"
                search={{ area: 'blocked' }}
                value={
                  <Count
                    value={blocked.data?.total}
                    pending={blocked.isPending}
                    failed={blocked.isError}
                    label="Loading blocked members"
                  />
                }
              />
            ) : null}
          </Rows>
        </Section>
      ) : null}

      {on('tickets') ? (
        <Section label="Member tools">
          <Rows>
            <FactRow
              guildId={guildId}
              icon="ticket"
              label="Open tickets"
              to="tickets"
              search={{ area: 'queue' }}
              value={
                <Count
                  value={tickets.data?.total}
                  pending={tickets.isPending}
                  failed={tickets.isError}
                  label="Loading open tickets"
                />
              }
            />
            <FactRow
              guildId={guildId}
              icon="user-plus"
              label="Unclaimed tickets"
              detail="Counted across the first hundred open tickets."
              to="tickets"
              search={{ area: 'queue' }}
              value={
                <Count
                  value={
                    unclaimed.data?.tickets.filter((ticket) => ticket.claimedById === null).length
                  }
                  pending={unclaimed.isPending}
                  failed={unclaimed.isError}
                  label="Loading unclaimed tickets"
                />
              }
            />
          </Rows>
        </Section>
      ) : null}
    </Workspace>
  );
}
