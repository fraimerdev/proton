import type {
  ReportGroup,
  ReportQuery,
  ReportSummary,
} from '@proton/module-moderation/reports-view';
import { useQuery } from '@tanstack/react-query';
import type { Dispatch, ReactElement, SetStateAction } from 'react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { MemberCell, MemberProvider, useMember } from '../../../components/discord/member.tsx';
import { MemberPicker } from '../../../components/discord/member-picker.tsx';
import {
  ModuleLink,
  type ModuleSearch,
  useModuleNavigate,
  useModuleSearch,
} from '../../../components/module/route.tsx';
import {
  Badge,
  Button,
  Chip,
  Field,
  SearchField,
  SegmentedControl,
  Select,
  Switch,
  TextInput,
} from '../../../components/ui/controls.tsx';
import { EmptyState, LoadingArea, StatusBanner } from '../../../components/ui/feedback.tsx';
import { Icon } from '../../../components/ui/icon.tsx';
import { Dialog, MenuButton } from '../../../components/ui/overlay.tsx';
import { type Column, DataTable, Pagination } from '../../../components/ui/table.tsx';
import { SegmentedTabs } from '../../../components/ui/tabs.tsx';
import { readFailure } from '../../../lib/errors.ts';
import { MEMBER_LOOKUP_MAX } from '../../../lib/queries.ts';
import { ReportDetailView } from './detail.tsx';
import { type LocalFilters, reportFilter, reportsQuery } from './queries.ts';
import {
  cardProblem,
  closeFailed,
  groupLine,
  isMemberId,
  STATUS_LABELS,
  statusTone,
} from './queue-labels.ts';
import { useNow, When } from './when.tsx';

type StatusTab = 'active' | 'open' | 'in_review' | 'resolved' | 'all';

const STATUS_TABS: readonly { id: StatusTab; label: string }[] = [
  { id: 'active', label: 'Active' },
  { id: 'open', label: 'Open' },
  { id: 'in_review', label: 'In review' },
  { id: 'resolved', label: 'Resolved' },
  { id: 'all', label: 'All' },
];

const PAGE_SIZES = [10, 25] as const;

const SEARCH_MAX = 100;

type MemberFilter = 'target' | 'reporter' | 'assignee';

const MEMBER_FILTERS: readonly { value: MemberFilter; label: string }[] = [
  { value: 'target', label: 'About' },
  { value: 'reporter', label: 'Filed by' },
  { value: 'assignee', label: 'Assigned to' },
];

const EMPTY: Record<ReportQuery['status'], { title: string; body?: string }> = {
  active: {
    title: 'No open reports',
    body: 'Reports stay here until someone accepts or dismisses them.',
  },
  open: { title: 'No reports waiting for a claim' },
  in_review: { title: 'No reports in review' },
  accepted: { title: 'No accepted reports' },
  dismissed: { title: 'No dismissed reports' },
  resolved: { title: 'No resolved reports' },
  all: {
    title: 'No reports yet',
    body: 'Members file reports with /report, the Apps menu or a reaction, whichever are on in Settings.',
  },
};

const RANGE_BACKWARDS = 'The start date is after the end date.';

const PROBLEM_LINKS: ReadonlyMap<string | undefined, LocalFilters> = new Map([
  ['problem', { delivery: true }],
  ['close-problem', { close: true }],
]);

type SetLocal = Dispatch<SetStateAction<LocalFilters>>;

export function ReportQueueArea({
  guildId,
  moduleId,
}: {
  guildId: string;
  moduleId: string;
}): ReactElement {
  const search = useModuleSearch();
  const go = useModuleNavigate(guildId, moduleId);
  const [local, setLocal] = useState<LocalFilters>({});

  // The overview links here with status=problem or close-problem, which are not report statuses: they become local filters.
  const problem = PROBLEM_LINKS.get(search.status);

  useEffect(() => {
    if (problem === undefined) return;
    setLocal((current) => ({ ...current, ...problem }));
    go({ status: 'all', page: undefined }, { replace: true });
  }, [problem, go]);

  const filterMember = useCallback(
    (targetId: string) => {
      setLocal((current) => ({ ...current, targetId, group: false }));
      go({
        id: undefined,
        page: undefined,
        status: 'all',
        sort: search.sort === 'volume' ? undefined : search.sort,
      });
    },
    [go, search.sort],
  );

  if (search.id !== undefined) {
    return (
      <ReportDetailView
        key={search.id}
        guildId={guildId}
        moduleId={moduleId}
        reportId={search.id}
        onFilterMember={filterMember}
      />
    );
  }

  return (
    <QueueView
      guildId={guildId}
      moduleId={moduleId}
      search={problem !== undefined ? { ...search, status: 'all' } : search}
      local={problem !== undefined ? { ...local, ...problem } : local}
      setLocal={setLocal}
      onFilterMember={filterMember}
    />
  );
}

function StatusBadges({ report }: { report: ReportSummary }): ReactElement {
  const problem = cardProblem(report.card.state);

  return (
    <>
      <Badge tone={statusTone(report.status)}>{STATUS_LABELS[report.status]}</Badge>
      {problem !== null ? <Badge tone="warning">{problem}</Badge> : null}
      {closeFailed(report.close) ? <Badge tone="warning">Close failed</Badge> : null}
    </>
  );
}

function priorityIds(
  groups: readonly ReportGroup[] | undefined,
  rows: readonly ReportSummary[],
  local: LocalFilters,
): string[] {
  const ids = new Set<string>();
  const add = (id: string | null | undefined): void => {
    if (isMemberId(id)) ids.add(id);
  };

  add(local.targetId);
  add(local.reporterId);
  add(local.assigneeId);

  for (const group of groups ?? []) add(group.targetId);
  for (const group of groups ?? []) for (const report of group.reports) add(report.reporterId);

  for (const row of rows) add(row.targetId);
  for (const row of rows) add(row.reporterId);
  for (const row of rows) add(row.assigneeId);

  // membersQuery keeps an arbitrary hundred of a longer list; this keeps the ones shown first.
  return [...ids].slice(0, MEMBER_LOOKUP_MAX);
}

function QueueView({
  guildId,
  moduleId,
  search,
  local,
  setLocal,
  onFilterMember,
}: {
  guildId: string;
  moduleId: string;
  search: ModuleSearch;
  local: LocalFilters;
  setLocal: SetLocal;
  onFilterMember: (targetId: string) => void;
}): ReactElement {
  const go = useModuleNavigate(guildId, moduleId);
  const filter = reportFilter(search, local);
  const grouped = filter.group === 'member';

  const term = search.q ?? '';
  const [draft, setDraft] = useState(term);
  useEffect(() => setDraft(term), [term]);

  useEffect(() => {
    const next = draft.trim().slice(0, SEARCH_MAX);
    if (next === term) return;

    const timer = window.setTimeout(
      () => go({ q: next === '' ? undefined : next, page: undefined }),
      250,
    );
    return () => window.clearTimeout(timer);
  }, [draft, term, go]);

  const query = useQuery(reportsQuery(guildId, filter));
  const result = query.data;
  const rows = result?.grouped === false ? result.reports : [];
  const groups = result?.grouped === true ? result.groups : undefined;
  const total = result?.total ?? 0;
  const now = useNow(query.dataUpdatedAt);

  const [picking, setPicking] = useState<MemberFilter | null>(null);

  const setFilter = (patch: Partial<LocalFilters>): void => {
    setLocal((current) => ({ ...current, ...patch }));
    if (search.page !== undefined) go({ page: undefined });
  };

  const memberIds = useMemo(() => priorityIds(groups, rows, local), [groups, rows, local]);

  const backwards =
    local.from !== undefined &&
    local.to !== undefined &&
    local.from !== '' &&
    local.to !== '' &&
    local.from > local.to;

  const filtered =
    term !== '' ||
    local.targetId !== undefined ||
    local.reporterId !== undefined ||
    local.assigneeId !== undefined ||
    (local.from ?? '') !== '' ||
    (local.to ?? '') !== '' ||
    local.delivery === true ||
    local.close === true;

  const clearAll = (): void => {
    setLocal((current) => ({ group: current.group, pageSize: current.pageSize }));
    setDraft('');
    go({ q: undefined, page: undefined });
  };

  const sortValue =
    filter.sort === 'volume' ? 'volume' : filter.dir === 'asc' ? 'oldest' : 'newest';

  const columns: Column<ReportSummary>[] = [
    {
      id: 'report',
      header: 'Report',
      primary: true,
      width: 112,
      cell: (row) => (
        <span className="moderation-report-cell-id">
          <span className="mono text-xs">{row.id}</span>
          <span className="text-muted text-xs">#{row.number}</span>
        </span>
      ),
    },
    {
      id: 'member',
      header: 'Member',
      width: 150,
      cell: (row) => <MemberCell userId={row.targetId} />,
    },
    {
      id: 'reporter',
      header: 'Reporter',
      width: 150,
      cell: (row) => <MemberCell userId={row.reporterId} />,
    },
    {
      id: 'reason',
      header: 'Reason',
      cell: (row) => {
        const reason = row.reason ?? row.customReason;
        return reason === null ? (
          <span className="text-muted">None</span>
        ) : (
          <span className="moderation-report-reason" title={reason}>
            {reason}
          </span>
        );
      },
    },
    {
      id: 'status',
      header: 'Status',
      width: 124,
      cell: (row) => (
        <span className="moderation-report-cell-status">
          <StatusBadges report={row} />
        </span>
      ),
    },
    {
      id: 'assignee',
      header: 'Assignee',
      width: 140,
      cell: (row) => <MemberCell userId={row.assigneeId} fallback="Nobody" />,
    },
    {
      id: 'age',
      header: 'Age',
      sortField: 'created',
      width: 76,
      cell: (row) => <When at={row.createdAt} now={now} />,
    },
    {
      id: 'actions',
      header: '',
      width: 48,
      align: 'right',
      cell: (row) => (
        <MenuButton
          label={`Actions for report ${row.id}`}
          actions={[
            {
              id: 'open',
              label: 'Open report',
              icon: 'eye',
              onSelect: () => go({ id: row.id }),
            },
            {
              id: 'about',
              label: 'Reports about this member',
              icon: 'flag',
              onSelect: () => setFilter({ targetId: row.targetId }),
            },
            {
              id: 'by',
              label: 'Reports filed by this reporter',
              icon: 'users-three',
              onSelect: () => setFilter({ reporterId: row.reporterId }),
            },
          ]}
        />
      ),
    },
  ];

  const empty = filtered
    ? {
        icon: 'magnifying-glass' as const,
        title: 'No reports match these filters',
        body: (
          <Button size="sm" onClick={clearAll}>
            Clear filters
          </Button>
        ),
      }
    : { icon: 'flag' as const, ...EMPTY[filter.status] };

  const pageSize = filter.pageSize;

  const footer = (
    <>
      <Pagination
        page={filter.page}
        pageSize={pageSize}
        total={total}
        noun={grouped ? 'members' : 'reports'}
        onPageChange={(next) => go({ page: next })}
      />
      <Select
        aria-label={grouped ? 'Members per page' : 'Reports per page'}
        width="sm"
        value={String(pageSize)}
        options={PAGE_SIZES.map((size) => ({ value: String(size), label: `${size} per page` }))}
        onChange={(value) => setFilter({ pageSize: Number(value) })}
      />
    </>
  );

  return (
    <MemberProvider guildId={guildId} userIds={memberIds}>
      <div className="moderation-report-queue">
        <div className="table-toolbar">
          <SegmentedTabs
            label="Report status"
            items={STATUS_TABS}
            value={filter.status as StatusTab}
            onChange={(next) =>
              go({ status: next === 'active' ? undefined : next, page: undefined })
            }
          />
          <SearchField
            value={draft}
            onChange={setDraft}
            label="Search reports"
            placeholder="Report ID, #number or member ID"
          />
        </div>

        <div className="moderation-report-filters">
          <span className="moderation-report-toggle">
            <Switch
              checked={grouped}
              label="Group by member"
              onChange={(on) => {
                setLocal((current) => ({ ...current, group: on }));
                go({
                  page: undefined,
                  ...(on || search.sort !== 'volume' ? {} : { sort: undefined }),
                });
              }}
            />
            Group by member
          </span>

          <Field label="Sort">
            {(props) => (
              <Select
                {...props}
                width="sm"
                value={sortValue}
                options={[
                  { value: 'newest', label: 'Newest first' },
                  { value: 'oldest', label: 'Oldest first' },
                  ...(grouped ? [{ value: 'volume', label: 'Most reported' }] : []),
                ]}
                onChange={(value) =>
                  go(
                    value === 'volume'
                      ? { sort: 'volume', dir: undefined, page: undefined }
                      : {
                          sort: undefined,
                          dir: value === 'oldest' ? 'asc' : undefined,
                          page: undefined,
                        },
                  )
                }
              />
            )}
          </Field>

          <AssigneeFilter
            value={local.assigneeId}
            onChange={(assigneeId) => setFilter({ assigneeId })}
            onPick={() => setPicking('assignee')}
          />

          <div className="moderation-report-dates">
            <Field label="From" error={backwards ? RANGE_BACKWARDS : undefined}>
              {(props) => (
                <TextInput
                  {...props}
                  type="date"
                  width="sm"
                  invalid={backwards}
                  value={local.from ?? ''}
                  onChange={(event) => setFilter({ from: event.currentTarget.value || undefined })}
                />
              )}
            </Field>

            <Field label="To">
              {(props) => (
                <TextInput
                  {...props}
                  type="date"
                  width="sm"
                  value={local.to ?? ''}
                  onChange={(event) => setFilter({ to: event.currentTarget.value || undefined })}
                />
              )}
            </Field>
          </div>

          <div className="field">
            <span className="field-label">Filters</span>
            <div className="chip-list moderation-report-chips">
              {local.targetId !== undefined ? (
                <Chip
                  onRemove={() => setFilter({ targetId: undefined })}
                  removeLabel="Clear the reported member filter"
                >
                  <span className="inline inline-6">
                    About <MemberCell userId={local.targetId} />
                  </span>
                </Chip>
              ) : null}
              {local.reporterId !== undefined ? (
                <Chip
                  onRemove={() => setFilter({ reporterId: undefined })}
                  removeLabel="Clear the reporter filter"
                >
                  <span className="inline inline-6">
                    Filed by <MemberCell userId={local.reporterId} />
                  </span>
                </Chip>
              ) : null}
              {local.delivery === true ? (
                <Chip
                  onRemove={() => setFilter({ delivery: undefined })}
                  removeLabel="Clear the delivery problems filter"
                >
                  Delivery problems
                </Chip>
              ) : null}
              {local.close === true ? (
                <Chip
                  onRemove={() => setFilter({ close: undefined })}
                  removeLabel="Clear the closing problems filter"
                >
                  Closing problems
                </Chip>
              ) : null}
              <button
                type="button"
                className="chip-add"
                aria-label="Filter by member"
                title="Filter by member"
                onClick={() => setPicking('target')}
              >
                <Icon name="plus" size={14} />
              </button>
            </div>
          </div>

          {filtered ? (
            <Button className="push-right" tone="ghost" size="sm" onClick={clearAll}>
              Clear filters
            </Button>
          ) : null}
        </div>

        {query.isError ? (
          <StatusBanner tone="danger" live="polite">
            {readFailure(query.error, 'this server’s report queue')}
          </StatusBanner>
        ) : groups !== undefined ? (
          <GroupedReports
            guildId={guildId}
            moduleId={moduleId}
            groups={groups}
            now={now}
            empty={empty}
            footer={footer}
            onFilterMember={onFilterMember}
          />
        ) : grouped && query.isPending ? (
          <LoadingArea label="Loading reports" minHeight={220} />
        ) : (
          <DataTable
            columns={columns}
            rows={rows}
            rowKey={(row) => row.id}
            loading={query.isPending}
            loadingLabel="Loading reports"
            onRowClick={(row) => go({ id: row.id })}
            sort={{ field: 'created', direction: filter.dir }}
            onSortChange={(next) =>
              go({
                sort: undefined,
                dir: next.direction === 'asc' ? 'asc' : undefined,
                page: undefined,
              })
            }
            empty={empty}
            footer={footer}
          />
        )}
      </div>

      <MemberFilterDialog
        guildId={guildId}
        mode={picking}
        onClose={() => setPicking(null)}
        onPick={(kind, id) => {
          setPicking(null);
          setFilter(
            kind === 'target'
              ? { targetId: id }
              : kind === 'reporter'
                ? { reporterId: id }
                : { assigneeId: id },
          );
        }}
      />
    </MemberProvider>
  );
}

function AssigneeFilter({
  value,
  onChange,
  onPick,
}: {
  value: string | undefined;
  onChange: (value: string | undefined) => void;
  onPick: () => void;
}): ReactElement {
  const member = useMember(isMemberId(value) ? value : null);
  const selected = value === undefined ? '' : value === 'none' ? 'none' : 'member';
  const name = member?.displayName ?? value;

  return (
    <Field label="Assignee">
      {(props) => (
        <Select
          {...props}
          width="md"
          value={selected}
          options={[
            { value: '', label: 'Anyone' },
            { value: 'none', label: 'Unassigned' },
            {
              value: 'member',
              label: selected === 'member' ? `Assigned to ${name}` : 'Assigned to a member…',
            },
          ]}
          onChange={(next) => {
            if (next === 'member') onPick();
            else onChange(next === '' ? undefined : next);
          }}
        />
      )}
    </Field>
  );
}

function GroupedReports({
  guildId,
  moduleId,
  groups,
  now,
  empty,
  footer,
  onFilterMember,
}: {
  guildId: string;
  moduleId: string;
  groups: readonly ReportGroup[];
  now: number;
  empty: { icon: 'flag' | 'magnifying-glass'; title: string; body?: ReactElement | string };
  footer: ReactElement;
  onFilterMember: (targetId: string) => void;
}): ReactElement {
  const search = useModuleSearch();

  return (
    <div className="table-wrap">
      {groups.length === 0 ? (
        <EmptyState icon={empty.icon} title={empty.title}>
          {empty.body}
        </EmptyState>
      ) : (
        <div className="matrix moderation-report-groups">
          {groups.map((group) => (
            <section className="matrix-group" key={group.targetId}>
              <div className="matrix-group-head moderation-report-group-head">
                <MemberCell userId={group.targetId} />
                <span className="matrix-group-count">{groupLine(group)}</span>
                <span className="matrix-group-aside text-xs">
                  <When at={group.lastAt} now={now} prefix="Latest " />
                </span>
              </div>

              {group.reports.map((report) => {
                const reason = report.reason ?? report.customReason;

                return (
                  <ModuleLink
                    key={report.id}
                    className="matrix-row moderation-report-group-row"
                    guildId={guildId}
                    moduleId={moduleId}
                    search={{ ...search, id: report.id }}
                  >
                    <span className="moderation-report-group-id">
                      <span className="mono text-xs">{report.id}</span>
                      <span className="text-muted">#{report.number}</span>
                    </span>
                    <span className="moderation-report-group-reason" title={reason ?? undefined}>
                      {reason ?? <span className="text-muted">No reason given</span>}
                    </span>
                    <span className="moderation-report-group-by">
                      <MemberCell userId={report.reporterId} />
                    </span>
                    <span className="moderation-report-group-status">
                      <StatusBadges report={report} />
                    </span>
                    <span className="moderation-report-group-age">
                      <When at={report.createdAt} now={now} />
                    </span>
                  </ModuleLink>
                );
              })}

              <div className="moderation-report-group-foot">
                <Button tone="ghost" size="sm" onClick={() => onFilterMember(group.targetId)}>
                  {group.total > group.reports.length
                    ? `Show all ${group.total} reports about this member`
                    : 'Show all reports about this member'}
                </Button>
              </div>
            </section>
          ))}
        </div>
      )}

      <div className="table-foot">{footer}</div>
    </div>
  );
}

function MemberFilterDialog({
  guildId,
  mode,
  onClose,
  onPick,
}: {
  guildId: string;
  mode: MemberFilter | null;
  onClose: () => void;
  onPick: (kind: MemberFilter, id: string) => void;
}): ReactElement {
  const [kind, setKind] = useState<MemberFilter>('target');

  useEffect(() => {
    if (mode !== null) setKind(mode);
  }, [mode]);

  return (
    <Dialog
      open={mode !== null}
      onClose={onClose}
      title="Filter by member"
      size="compact"
      footer={<Button onClick={onClose}>Cancel</Button>}
    >
      <div className="field">
        <span className="field-label">Show reports</span>
        <SegmentedControl
          label="Show reports"
          value={kind}
          options={MEMBER_FILTERS}
          onChange={setKind}
        />
      </div>
      <div className="field">
        <span className="field-label">Member</span>
        <MemberPicker
          guildId={guildId}
          value={null}
          onChange={(id) => {
            if (id !== null) onPick(kind, id);
          }}
          label="Member"
          placeholder="Search for a member"
          width="100%"
        />
      </div>
    </Dialog>
  );
}
