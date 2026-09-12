import {
  blockedMemberQuerySchema,
  type CaseRecord,
  type CaseSearchResult,
  caseQuerySchema,
  type ModuleSummary,
} from '@proton/core';
import { ticketQuerySchema } from '@proton/module-tickets/query';
import {
  queryOptions,
  type UseQueryResult,
  useQuery,
  useSuspenseQuery,
} from '@tanstack/react-query';
import { createFileRoute, Link } from '@tanstack/react-router';
import { type ReactElement, type ReactNode, useMemo, useRef, useState } from 'react';
import { modulePath } from '../../../components/module/paths.ts';
import { PageHead } from '../../../components/shell/app-shell.tsx';
import { Icon } from '../../../components/shell/icon.tsx';
import {
  actionLook,
  CATEGORY_LABELS,
  CATEGORY_ORDER,
  isCategory,
  isServerLevel,
  type ModuleState,
  moduleBlurb,
  moduleIcon,
  moduleState,
  shortReason,
  whereToFix,
} from '../../../components/shell/module-meta.ts';
import { useToggleModule } from '../../../components/shell/module-toggle.tsx';
import { UserChip } from '../../../components/shell/user-chip.tsx';
import { DataTable, dataColumnHelper } from '../../../components/table/data-table.tsx';
import { documentTitle } from '../../../lib/document-title.ts';
import { guildQuery, modulesQuery } from '../../../lib/queries.ts';
import { LIVE, queryKeys, STALE } from '../../../lib/query-keys.ts';

export const Route = createFileRoute('/dashboard/$guildId/')({
  loader: ({ context, params }) =>
    context.queryClient
      .fetchQuery(guildQuery(params.guildId))
      .then((overview) => ({ title: documentTitle('Overview', overview.name) })),
  head: ({ loaderData }) => ({ meta: [{ title: loaderData?.title ?? documentTitle('Overview') }] }),
  component: GuildOverview,
  errorComponent: GuildOverviewError,
});

const RECENT_CASES = caseQuerySchema.parse({ pageSize: 10 });

const ONE_CASE = caseQuerySchema.parse({ pageSize: 1 });

const OPEN_TICKETS = ticketQuerySchema.parse({ status: 'open', pageSize: 1 });

const LIVE_BLOCKS = blockedMemberQuerySchema.parse({ state: 'live', pageSize: 1 });

const PERMISSION_PATH = whereToFix('missing_permission');

const SHORT_DATE = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
  timeZone: 'UTC',
});

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

interface CaseWeeks {
  from: string;
  to: string;
  priorFrom: string;
  priorTo: string;
}

function utcDay(at: number): string {
  return new Date(at).toISOString().slice(0, 10);
}

// Both ends are inclusive in the api, so seven days is today and the six before it.
function caseWeeks(now: number): CaseWeeks {
  return {
    from: utcDay(now - 6 * DAY_MS),
    to: utcDay(now),
    priorFrom: utcDay(now - 13 * DAY_MS),
    priorTo: utcDay(now - 7 * DAY_MS),
  };
}

function recentCasesQuery(guildId: string) {
  return queryOptions({
    queryKey: queryKeys.view(guildId, 'cases', RECENT_CASES),
    queryFn: async () =>
      (await import('../../../server/modules.ts')).searchCases({
        data: { guildId, ...RECENT_CASES },
      }),
    staleTime: STALE.browse,
    ...LIVE,
  });
}

function caseWeeksQuery(guildId: string, weeks: CaseWeeks) {
  return queryOptions({
    queryKey: queryKeys.view(guildId, 'cases', weeks),
    queryFn: async () => {
      const { searchCases } = await import('../../../server/modules.ts');

      const [current, before] = await Promise.all([
        searchCases({ data: { guildId, ...ONE_CASE, from: weeks.from, to: weeks.to } }),
        searchCases({ data: { guildId, ...ONE_CASE, from: weeks.priorFrom, to: weeks.priorTo } }),
      ]);

      return { current: current.total, before: before.total };
    },
    staleTime: STALE.browse,
    ...LIVE,
  });
}

function openTicketsQuery(guildId: string) {
  return queryOptions({
    queryKey: queryKeys.view(guildId, 'tickets', OPEN_TICKETS),
    queryFn: async () =>
      (await import('../../../server/modules.ts')).searchTickets({
        data: { guildId, ...OPEN_TICKETS },
      }),
    staleTime: STALE.browse,
    ...LIVE,
  });
}

function blockedMembersQuery(guildId: string) {
  return queryOptions({
    queryKey: queryKeys.view(guildId, 'blocked', LIVE_BLOCKS),
    queryFn: async () =>
      (await import('../../../server/modules.ts')).searchBlockedMembers({
        data: { guildId, ...LIVE_BLOCKS },
      }),
    staleTime: STALE.browse,
    ...LIVE,
  });
}

function utcStamp(iso: string): string {
  return `${iso.replace('T', ' ').slice(0, 16)} UTC`;
}

function dayLabel(iso: string): string {
  const at = Date.parse(iso);

  return Number.isNaN(at) ? iso.slice(0, 10) : SHORT_DATE.format(at);
}

function agoLabel(iso: string, now: number): string {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return iso.slice(0, 10);

  const ago = now - at;

  if (ago < MINUTE_MS) return 'just now';
  if (ago < HOUR_MS) return `${Math.floor(ago / MINUTE_MS)}m ago`;
  if (ago < DAY_MS) return `${Math.floor(ago / HOUR_MS)}h ago`;
  if (ago < 7 * DAY_MS) return `${Math.floor(ago / DAY_MS)}d ago`;

  return SHORT_DATE.format(at);
}

function inLabel(ms: number): string {
  if (ms < HOUR_MS) return `${Math.max(1, Math.round(ms / MINUTE_MS))}m`;
  if (ms < DAY_MS) return `${Math.round(ms / HOUR_MS)}h`;

  return `${Math.round(ms / DAY_MS)}d`;
}

function isStalled(state: ModuleState): boolean {
  return state === 'blocked' || state === 'degraded';
}

function reasonOf(module: ModuleSummary): string {
  return shortReason(module.status?.disabledReason?.code);
}

function categoryOf(module: ModuleSummary): string {
  return isCategory(module.category) ? CATEGORY_LABELS[module.category] : module.category;
}

function matches(module: ModuleSummary, needle: string): boolean {
  const words = `${module.name} ${categoryOf(module)} ${module.commands.join(' ')} ${moduleBlurb(
    module.id,
    module.category,
  )}`;

  return words.toLowerCase().includes(needle);
}

function modulesLede(on: number, total: number): string {
  if (on === 0)
    return 'Nothing is on yet. Switch one on and Proton starts doing it in this server; everything else stays off.';

  if (on === total)
    return 'Every module is on. Switching one off stops it acting, and keeps its settings.';

  return `${on} of ${total} modules on. The rest are off: they keep their settings and do nothing until you switch them on.`;
}

const CHECKED =
  'Proton reads that from the privileged intents Discord granted it and the modules it loaded.';

function runningLine(on: number, stalled: number): string {
  if (on === 0) return 'Nothing is switched on yet, so nothing is running.';
  if (stalled > 0) return `${stalled} of the ${on} switched-on modules cannot run. ${CHECKED}`;

  return `All ${on} switched-on modules are running. ${CHECKED}`;
}

function healthTone(on: number, stalled: number): 'warn' | 'ok' | undefined {
  if (stalled > 0) return 'warn';

  return on === 0 ? undefined : 'ok';
}

const STATE_FILTERS = ['all', 'on', 'off', 'stalled'] as const;

type StateFilter = (typeof STATE_FILTERS)[number];

const FILTER_LABELS: Record<StateFilter, string> = {
  all: 'All',
  on: 'On',
  off: 'Off',
  stalled: 'Not running',
};

// Said as the state rather than as the filter: "No module is not running" is the sentence a label
// substituted into the empty state produces, and it means the opposite of what it says.
const EMPTY_TITLES: Record<StateFilter, string> = {
  all: 'This server has no modules to list.',
  on: 'No module is switched on.',
  off: 'Every module is switched on.',
  stalled: 'Every switched-on module is running.',
};

function inState(module: ModuleSummary, filter: StateFilter): boolean {
  if (filter === 'on') return module.enabled;
  if (filter === 'off') return !module.enabled;
  if (filter === 'stalled') return isStalled(moduleState(module));

  return true;
}

function CopyId({ id }: { id: string }): ReactElement {
  const [copied, setCopied] = useState(false);

  function copy(): void {
    // Same judgement the member chip makes: a clipboard the browser refuses is not worth a panel,
    // because the id is on the title and selectable beside the button.
    void navigator.clipboard?.writeText(id).then(
      () => setCopied(true),
      () => setCopied(false),
    );
  }

  return (
    <button
      type="button"
      className="icon-button"
      aria-label={copied ? 'Copied the server id' : `Copy the server id ${id}`}
      onBlur={() => setCopied(false)}
      onClick={copy}
    >
      <Icon name={copied ? 'check-circle' : 'copy'} />
    </button>
  );
}

function ModuleSwitch({ module }: { module: ModuleSummary }): ReactElement {
  const toggle = useToggleModule();

  return (
    <span className="module-switch" data-state={moduleState(module)}>
      <input
        type="checkbox"
        role="switch"
        checked={module.enabled}
        aria-checked={module.enabled}
        // The module names the switch; role="switch" is what says on or off. Naming it "Switch
        // off Automod" renamed the control every time it was used, and said the state twice.
        aria-label={module.name}
        onChange={(event) => toggle(module, event.target.checked)}
      />
    </span>
  );
}

function ModuleRow({
  guildId,
  module,
}: {
  guildId: string;
  module: ModuleSummary;
}): ReactElement | null {
  const to = modulePath(module.id);
  if (!to) return null;

  const state = moduleState(module);

  return (
    <li className={`module-row${module.enabled ? ' module-row-on' : ''}`} data-state={state}>
      <span className="shelf-tile" aria-hidden="true">
        <Icon name={moduleIcon(module.dashboard?.icon)} />
      </span>
      <Link to={to} params={{ guildId }} search={{}} className="module-open module-row-name">
        {module.name}
      </Link>
      <span className="module-row-blurb">{moduleBlurb(module.id, module.category)}</span>
      {isStalled(state) ? (
        <span className="module-state" data-state={state}>
          {reasonOf(module)}
        </span>
      ) : null}
      <ModuleSwitch module={module} />
    </li>
  );
}

// Not a ModuleRow: this is how Proton itself is set up in this server, not a feature to switch on,
// so it carries no toggle and sits outside the categories. The switch that does exist lives on its
// own page, where the sentence beside it can say what it actually governs.
function ServerRow({
  guildId,
  module,
}: {
  guildId: string;
  module: ModuleSummary;
}): ReactElement | null {
  const to = modulePath(module.id);
  if (!to) return null;

  return (
    <li>
      <Link
        to={to}
        params={{ guildId }}
        search={{}}
        className={`module-row shelf-link${module.enabled ? ' module-row-on' : ''}`}
      >
        <span className="shelf-tile" aria-hidden="true">
          <Icon name={moduleIcon(module.dashboard?.icon)} />
        </span>
        <span className="module-row-name">{module.name}</span>
        <span className="module-row-blurb">{moduleBlurb(module.id, module.category)}</span>
        <span className="module-state" data-state={module.enabled ? 'running' : 'off'}>
          {module.enabled ? 'On' : 'Off'}
        </span>
        <Icon name="caret-right" />
      </Link>
    </li>
  );
}

function NotRunning({
  guildId,
  modules,
}: {
  guildId: string;
  modules: readonly ModuleSummary[];
}): ReactElement {
  const [only] = modules;

  if (modules.length === 1 && only) {
    const to = modulePath(only.id);
    const where = whereToFix(only.status?.disabledReason?.code);
    const detail = only.status?.disabledReason?.humanReason;

    return (
      <div className="home-alert">
        <span className="home-alert-tile" aria-hidden="true">
          <Icon name="warning" weight="fill" />
        </span>
        <div className="home-alert-body">
          <p className="home-alert-text">
            {only.name} is on but not running:{' '}
            <span className="home-alert-reason">{reasonOf(only).toLowerCase()}</span>.
          </p>
          {detail ? <p className="home-alert-detail">{detail}</p> : null}
          {where ? <p className="home-alert-where">{where}</p> : null}
        </div>
        {to ? (
          <Link to={to} params={{ guildId }} search={{}} className="button button-quiet">
            Open {only.name}
          </Link>
        ) : null}
      </div>
    );
  }

  return (
    <div className="home-alert">
      <span className="home-alert-tile" aria-hidden="true">
        <Icon name="warning" weight="fill" />
      </span>
      <div className="home-alert-body">
        <p className="home-alert-text">{modules.length} modules are on but not running.</p>
        <ul className="home-alert-list">
          {modules.map((module) => {
            const to = modulePath(module.id);
            const where = whereToFix(module.status?.disabledReason?.code);

            return (
              <li key={module.id}>
                <span className="home-alert-text">
                  {to ? (
                    <Link to={to} params={{ guildId }} search={{}}>
                      {module.name}
                    </Link>
                  ) : (
                    module.name
                  )}
                  : <span className="home-alert-reason">{reasonOf(module).toLowerCase()}</span>.
                </span>
                {where ? <span className="home-alert-where">{where}</span> : null}
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}

/**
 * What Proton can and cannot answer about this server, said out loud. The api reports every Discord
 * permission as granted, so a missing one never reaches this page — and the absence of a warning
 * would otherwise read as a clean bill of health on a server where Proton cannot ban anybody.
 */
function Health({ on, stalled }: { on: number; stalled: number }): ReactElement {
  const tone = healthTone(on, stalled);

  return (
    <section className="home-panel home-health">
      <div className="home-panel-head">
        <h2 className="home-panel-title">Health</h2>
      </div>

      <div className="home-health-body">
        <p className="home-health-line" data-tone={tone}>
          <Icon
            name={tone === 'warn' ? 'warning' : tone === 'ok' ? 'check-circle' : 'info'}
            weight="fill"
          />
          <span>{runningLine(on, stalled)}</span>
        </p>

        <p className="home-health-line">
          <Icon name="info" weight="fill" />
          <span>
            Channel and role permissions are not checked here. Discord reveals those only when an
            action runs: if Proton is missing one, the action fails and names the permission and the
            channel it needed.
          </span>
        </p>

        {PERMISSION_PATH ? (
          <span className="where">
            <Icon name="arrow-elbow-down-right" />
            Check them at {PERMISSION_PATH}.
          </span>
        ) : null}
      </div>
    </section>
  );
}

function Reading({
  label,
  value,
  failed,
  note,
}: {
  label: string;
  value: number | undefined;
  failed: boolean;
  note?: ReactNode;
}): ReactElement {
  return (
    <>
      <span className="home-read-label">{label}</span>
      <span className="home-read-num" aria-busy={value === undefined && !failed}>
        {failed ? '—' : null}
        {failed || value !== undefined ? null : (
          <span className="home-read-skeleton" aria-hidden="true" />
        )}
        {failed || value === undefined ? null : value.toLocaleString('en-US')}
      </span>
      <span className="home-read-note">{failed ? 'Proton could not read this.' : note}</span>
    </>
  );
}

const recentColumn = dataColumnHelper<CaseRecord>();

function CaseState({ record }: { record: CaseRecord }): ReactElement {
  if (record.dryRun) return <span className="chip chip-warn">Rehearsal</span>;

  if (record.revertedAt)
    return (
      <span className="chip chip-ok" title={utcStamp(record.revertedAt)}>
        Reverted
      </span>
    );

  if (record.expiresAt) {
    const at = Date.parse(record.expiresAt);
    const left = at - Date.now();

    return (
      <span className="chip" title={utcStamp(record.expiresAt)}>
        {left <= 0 ? 'Expired' : `Expires in ${inLabel(left)}`}
      </span>
    );
  }

  return <span className="chip">Active</span>;
}

function recentColumnsFor(guildId: string, caseLog: ReturnType<typeof modulePath>) {
  return recentColumn.columns([
    recentColumn.accessor('caseNumber', {
      id: 'caseNumber',
      header: 'Case',
      cell: (c) =>
        caseLog ? (
          <Link
            to={caseLog}
            params={{ guildId }}
            search={{ view: 'cases', caseId: c.row.original.id }}
            className="home-case-open"
            aria-label={`Case ${c.getValue()} in the case log`}
          >
            #{c.getValue()}
          </Link>
        ) : (
          `#${c.getValue()}`
        ),
    }),
    recentColumn.accessor('type', {
      id: 'type',
      header: 'Action',
      cell: (c) => {
        const look = actionLook(c.getValue());

        return (
          <span className="recent-badge" data-tone={look.tone}>
            {look.verb}
          </span>
        );
      },
    }),
    recentColumn.accessor('targetId', {
      id: 'targetId',
      header: 'Target',
      cell: (c) => {
        const id = c.getValue();

        return id ? <UserChip id={id} as="target" /> : '—';
      },
    }),
    recentColumn.accessor('actorId', {
      id: 'actorId',
      header: 'Moderator',
      cell: (c) => {
        const id = c.getValue();

        return id ? (
          <UserChip id={id} as="moderator" />
        ) : (
          <span className="chip chip-system">
            <Icon name="lightning" weight="fill" />
            Proton
          </span>
        );
      },
    }),
    recentColumn.accessor('reason', {
      id: 'reason',
      header: 'Reason',
      cell: (c) => {
        const reason = c.getValue();

        return reason ? (
          <span className="recent-reason" title={reason}>
            {reason}
          </span>
        ) : (
          '—'
        );
      },
    }),
    recentColumn.display({
      id: 'state',
      header: 'State',
      cell: ({ row }) => <CaseState record={row.original} />,
    }),
    recentColumn.accessor('createdAt', {
      id: 'createdAt',
      header: 'When',
      cell: (c) => (
        <time dateTime={c.getValue()} title={utcStamp(c.getValue())}>
          {agoLabel(c.getValue(), Date.now())}
        </time>
      ),
    }),
  ]);
}

function RecentCases({
  guildId,
  recent,
}: {
  guildId: string;
  recent: UseQueryResult<CaseSearchResult>;
}): ReactElement {
  const caseLog = modulePath('cases');
  const columns = useMemo(() => recentColumnsFor(guildId, caseLog), [guildId, caseLog]);

  return (
    <section className="home-panel home-cases">
      <div className="home-panel-head">
        <h2 className="home-panel-title">Recent cases</h2>
        <span className="home-panel-aside">Newest first</span>
      </div>

      {recent.error ? (
        <p className="recent-note">
          Recent cases did not load: {recent.error.message.replace(/\.$/, '')}. Reload the page to
          try again — nothing else on this page depends on it.
        </p>
      ) : (
        <div className="home-cases-scroll">
          <DataTable
            className="table home-cases-table"
            columns={columns}
            data={recent.data?.cases ?? []}
            loading={recent.data === undefined}
            rowAttributes={(row) => ({ 'data-case-number': row.caseNumber })}
            empty={
              <p className="recent-note">
                No cases yet. Proton opens one every time it bans, kicks, times out or warns
                somebody, and lists the newest ten here.
              </p>
            }
          />
        </div>
      )}

      {caseLog ? (
        <div className="home-panel-foot">
          <Link
            to={caseLog}
            params={{ guildId }}
            search={{ view: 'cases' }}
            className="home-panel-link"
          >
            Open the case log
            <Icon name="arrow-right" />
          </Link>
        </div>
      ) : null}
    </section>
  );
}

function GuildOverview(): ReactElement {
  const { guildId } = Route.useParams();
  const overview = useSuspenseQuery(guildQuery(guildId)).data;
  const { modules } = useSuspenseQuery(modulesQuery(guildId)).data;

  const weeks = caseWeeks(Date.now());

  const recent = useQuery(recentCasesQuery(guildId));
  const fortnight = useQuery(caseWeeksQuery(guildId, weeks));
  const tickets = useQuery(openTicketsQuery(guildId));
  const blocked = useQuery(blockedMembersQuery(guildId));

  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<StateFilter>('all');
  const searchBox = useRef<HTMLInputElement>(null);
  const listHead = useRef<HTMLHeadingElement>(null);

  const shown = modules.filter((module) => modulePath(module.id) !== undefined);
  const on = shown.filter((module) => module.enabled).length;
  const stalled = shown.filter((module) => isStalled(moduleState(module)));

  const needle = query.trim().toLowerCase();
  const searched = needle ? shown.filter((module) => matches(module, needle)) : shown;

  const counts: Record<StateFilter, number> = {
    all: searched.length,
    on: searched.filter((module) => module.enabled).length,
    off: searched.filter((module) => !module.enabled).length,
    stalled: searched.filter((module) => isStalled(moduleState(module))).length,
  };

  const visible = searched.filter((module) => inState(module, filter));
  const serverLevel = visible.filter((module) => isServerLevel(module.id));
  const groups = CATEGORY_ORDER.map((category) => ({
    category,
    listed: visible.filter((module) => module.category === category && !isServerLevel(module.id)),
  })).filter((group) => group.listed.length > 0);

  const caseLog = modulePath('cases');
  const ticketQueue = modulePath('tickets');
  const blockList = modulePath('moderation');

  function clearSearch(): void {
    setQuery('');
    searchBox.current?.focus();
  }

  function showStalled(): void {
    setFilter('stalled');
    setQuery('');
    listHead.current?.scrollIntoView({ block: 'start' });
  }

  return (
    <div className="home panel-wide">
      <div aria-live="polite">
        {stalled.length > 0 ? <NotRunning guildId={guildId} modules={stalled} /> : null}
      </div>

      <PageHead
        title={overview.name}
        aside={
          <span className="home-idline">
            <span className="home-idline-joined">Proton joined {dayLabel(overview.joinedAt)}</span>
            <span className="home-idline-id id" title={overview.id}>
              {overview.id}
            </span>
            <CopyId id={overview.id} />
          </span>
        }
      />

      <div className="home-body">
        <Health on={on} stalled={stalled.length} />

        <section className="home-panel home-attention">
          <div className="home-panel-head">
            <h2 className="home-panel-title">Needs attention</h2>
          </div>

          <div className="home-reads">
            {caseLog ? (
              <Link
                className="home-read"
                to={caseLog}
                params={{ guildId }}
                search={{ view: 'cases', from: weeks.from, to: weeks.to }}
              >
                <Reading
                  label="Cases, last 7 days"
                  value={fortnight.data?.current}
                  failed={Boolean(fortnight.error)}
                  note={
                    fortnight.data ? `${fortnight.data.before} in the 7 days before` : undefined
                  }
                />
              </Link>
            ) : null}

            {ticketQueue ? (
              <Link
                className="home-read"
                to={ticketQueue}
                params={{ guildId }}
                search={{ view: 'tickets', status: 'open' }}
              >
                <Reading
                  label="Open tickets"
                  value={tickets.data?.total}
                  failed={Boolean(tickets.error)}
                />
              </Link>
            ) : null}

            {blockList ? (
              <Link
                className="home-read"
                to={blockList}
                params={{ guildId }}
                search={{ view: 'blocked', state: 'live' }}
              >
                <Reading
                  label="Members blocked"
                  value={blocked.data?.total}
                  failed={Boolean(blocked.error)}
                  note="Cannot pass verification until lifted"
                />
              </Link>
            ) : null}

            <button type="button" className="home-read" onClick={showStalled}>
              <Reading
                label="Modules not running"
                value={stalled.length}
                failed={false}
                note={`of ${on} switched on`}
              />
            </button>
          </div>
        </section>

        <RecentCases guildId={guildId} recent={recent} />

        <section className="home-panel home-modules">
          <div className="home-panel-head">
            <h2 className="home-panel-title" ref={listHead}>
              Modules
            </h2>

            <div className="home-tools">
              {/* biome-ignore lint/a11y/useSemanticElements: a fieldset groups form controls; this groups buttons */}
              <div className="home-seg" role="group" aria-label="Show modules by state">
                {STATE_FILTERS.map((id) => (
                  <button
                    key={id}
                    type="button"
                    className="home-seg-button"
                    aria-pressed={filter === id}
                    onClick={() => setFilter(id)}
                  >
                    {FILTER_LABELS[id]}
                    <span className="home-seg-count">{counts[id]}</span>
                  </button>
                ))}
              </div>

              <label className="home-search">
                <Icon name="magnifying-glass" />
                <span className="sr-only">Search modules</span>
                <input
                  ref={searchBox}
                  type="search"
                  placeholder="Search modules"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Escape') setQuery('');
                  }}
                />
                {needle ? (
                  <button
                    type="button"
                    className="home-search-clear"
                    aria-label="Clear the search"
                    onClick={clearSearch}
                  >
                    <Icon name="x" />
                  </button>
                ) : null}
              </label>
            </div>
          </div>

          <p className="home-modules-lede">{modulesLede(on, shown.length)}</p>

          <span className="sr-only" aria-live="polite">
            {needle ? `${counts.all} ${counts.all === 1 ? 'module matches' : 'modules match'}` : ''}
          </span>

          {serverLevel.length > 0 ? (
            <div className="shelf-group">
              <div className="shelf-group-head">
                <h3 className="shelf-group-title">Server</h3>
              </div>
              <ul className="module-rows module-grid">
                {serverLevel.map((module) => (
                  <ServerRow key={module.id} guildId={guildId} module={module} />
                ))}
              </ul>
            </div>
          ) : null}

          {groups.map(({ category, listed }) => (
            <div className="shelf-group" key={category}>
              <div className="shelf-group-head">
                <h3 className="shelf-group-title">{CATEGORY_LABELS[category]}</h3>
                <span className="shelf-group-count">
                  {listed.filter((module) => module.enabled).length} of {listed.length} on
                </span>
              </div>
              <ul className="module-rows module-grid">
                {listed.map((module) => (
                  <ModuleRow key={module.id} guildId={guildId} module={module} />
                ))}
              </ul>
            </div>
          ))}

          {visible.length === 0 ? (
            <div className="empty-state">
              <span className="tile">
                <Icon name="funnel-x" />
              </span>
              <span className="empty-state-title">
                {counts.all === 0 ? `No module matches “${query.trim()}”.` : EMPTY_TITLES[filter]}
              </span>
              <p className="status">
                {counts.all === 0
                  ? `Search reads module names, categories, commands and what each one does. Try “spam”, “roles” or “logs”, or clear the search to see all ${shown.length} modules.`
                  : `${counts.all} of this server’s ${shown.length} modules are listed under the other filters.`}
              </p>
              <button
                type="button"
                className="button button-quiet"
                onClick={() => {
                  setFilter('all');
                  clearSearch();
                }}
              >
                Show all {shown.length} modules
              </button>
            </div>
          ) : null}
        </section>
      </div>
    </div>
  );
}

function GuildOverviewError({ error }: { error: Error }): ReactElement {
  return (
    <>
      <PageHead title="Modules" />
      <div className="gap-card">
        <div className="gap-body">
          <span className="gap-head">
            <Icon name="warning-circle" weight="fill" className="state-blocked" />
            <span className="gap-name">Proton has no record of this server</span>
          </span>
          <p className="gap-text" role="alert">
            {error.message}
          </p>
          <span className="where">
            <Icon name="arrow-elbow-down-right" />
            Proton writes this record when it joins a server, and reads it on every page here. If it
            cannot be read, this server’s modules cannot be configured until it can.
          </span>
        </div>
        <Link to="/dashboard" className="button button-quiet">
          Back to your servers
        </Link>
      </div>
    </>
  );
}
