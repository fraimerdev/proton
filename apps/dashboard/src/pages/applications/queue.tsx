import type { QueueItem } from '@proton/module-applications/view';
import { useQuery } from '@tanstack/react-query';
import type { Dispatch, ReactElement, SetStateAction } from 'react';
import { useEffect, useMemo, useState } from 'react';
import { MemberCell, MemberProvider, type MemberSource } from '../../components/discord/member.tsx';
import { MetaSeparator } from '../../components/ui/collection.tsx';
import { Badge, Button, Field, SearchField, Select } from '../../components/ui/controls.tsx';
import { EmptyState, StatusBanner } from '../../components/ui/feedback.tsx';
import { type Column, DataTable, Pagination } from '../../components/ui/table.tsx';
import { SegmentedTabs } from '../../components/ui/tabs.tsx';
import { useNow, When } from '../moderation/reports/when.tsx';
import { ExportDialog, type Outcome } from './dialogs.tsx';
import {
  accessRefusal,
  applicationsReadFailure,
  EMPTY_VIEWS,
  isMemberId,
  PAGE_SIZES,
  problemLabels,
  type QueueLocal,
  type QueueSort,
  queueRequest,
  REVIEW_MEMBERS_MAX,
  SEARCH_MAX,
  type SubmissionsSearch,
  statusLabel,
  statusTone,
  viewOf,
  viewTabs,
  voteLine,
} from './labels.ts';
import { applicationQueueQuery, applicationSummaryQuery } from './queries.ts';
import { ApplicantCell } from './timeline.tsx';

export interface FormOption {
  id: string;
  name: string;
}

const SORT_FIELDS: readonly QueueSort[] = ['submitted', 'number', 'updated'];

const ASSIGNEE_OPTIONS = [
  { value: '', label: 'Anyone' },
  { value: 'me', label: 'Me' },
  { value: 'none', label: 'Unassigned' },
] as const;

function memberIdsOf(rows: readonly QueueItem[]): string[] {
  const ids = new Set<string>();
  for (const row of rows) if (isMemberId(row.assigneeId)) ids.add(row.assigneeId);
  for (const row of rows) if (isMemberId(row.applicantId)) ids.add(row.applicantId);

  // Assignees first: an applicant still shows the name they applied with when theirs is dropped.
  return [...ids].slice(0, REVIEW_MEMBERS_MAX);
}

export function AccessRefused({ message }: { message: string }): ReactElement {
  return (
    <EmptyState icon="lock" title="You can’t review applications here" inset>
      {message}
    </EmptyState>
  );
}

function StatusCell({ row }: { row: QueueItem }): ReactElement {
  return (
    <span className="applications-review-cell-status">
      <Badge tone={statusTone(row.status)}>{statusLabel(row.status)}</Badge>
      {row.archived ? <Badge>Archived</Badge> : null}
      {problemLabels(row.problems).map((label) => (
        <Badge key={label} tone="warning">
          {label}
        </Badge>
      ))}
    </span>
  );
}

export function ApplicationQueue({
  guildId,
  search,
  onSearch,
  local,
  setLocal,
  forms,
  onSeen,
  source,
}: {
  guildId: string;
  search: SubmissionsSearch;
  onSearch: (patch: Partial<SubmissionsSearch>, options?: { replace?: boolean }) => void;
  local: QueueLocal;
  setLocal: Dispatch<SetStateAction<QueueLocal>>;
  forms: readonly FormOption[];
  onSeen: (rows: readonly QueueItem[]) => void;
  source: MemberSource | undefined;
}): ReactElement {
  const request = queueRequest(search, local);
  const view = viewOf(search.view);
  const query = useQuery(applicationQueueQuery(guildId, request));
  const summary = useQuery(applicationSummaryQuery(guildId));
  const now = useNow(query.dataUpdatedAt);

  const term = search.q ?? '';
  const [draft, setDraft] = useState(term);
  const [exporting, setExporting] = useState(false);
  const [notice, setNotice] = useState<Outcome | null>(null);

  useEffect(() => setDraft(term), [term]);

  useEffect(() => {
    const next = draft.trim().slice(0, SEARCH_MAX);
    if (next === term) return;

    const timer = window.setTimeout(
      () => onSearch({ q: next === '' ? undefined : next, page: undefined }, { replace: true }),
      250,
    );
    return () => window.clearTimeout(timer);
  }, [draft, term, onSearch]);

  const rows = useMemo(() => query.data?.items ?? [], [query.data]);
  const total = query.data?.total ?? 0;
  const memberIds = useMemo(() => memberIdsOf(rows), [rows]);

  useEffect(() => onSeen(rows), [rows, onSeen]);

  const filtered = term !== '' || local.formId !== undefined || local.assignee !== undefined;

  const setFilter = (patch: Partial<QueueLocal>): void => {
    setLocal((current) => ({ ...current, ...patch }));
    if (search.page !== undefined) onSearch({ page: undefined });
  };

  const clearAll = (): void => {
    setLocal((current) => ({ pageSize: current.pageSize, sort: current.sort, dir: current.dir }));
    setDraft('');
    onSearch({ q: undefined, page: undefined });
  };

  const formName = forms.find((form) => form.id === local.formId)?.name;
  const refused =
    (query.isError ? accessRefusal(query.error) : null) ??
    (summary.isError ? accessRefusal(summary.error) : null);

  if (refused !== null) return <AccessRefused message={refused} />;

  const columns: Column<QueueItem>[] = [
    {
      id: 'reference',
      header: 'Reference',
      sortField: 'number',
      width: 96,
      cell: (row) => <span className="mono">{row.number === null ? '' : `#${row.number}`}</span>,
    },
    {
      id: 'applicant',
      header: 'Applicant',
      primary: true,
      width: 200,
      cell: (row) => <ApplicantCell id={row.applicantId} name={row.applicantName} />,
    },
    {
      id: 'form',
      header: 'Form',
      cell: (row) => <span className="applications-review-form-name">{row.formName}</span>,
    },
    {
      id: 'status',
      header: 'Status',
      width: 150,
      cell: (row) => <StatusCell row={row} />,
    },
    {
      id: 'submitted',
      header: 'Submitted',
      sortField: 'submitted',
      width: 96,
      cell: (row) => <When at={row.submittedAt} now={now} />,
    },
    {
      id: 'assignee',
      header: 'Assigned to',
      width: 160,
      cell: (row) => <MemberCell userId={row.assigneeId} fallback="Nobody" />,
    },
    {
      id: 'votes',
      header: 'Votes',
      width: 130,
      cell: (row) => {
        const line = voteLine(row.votes);
        return line === null ? <span className="text-muted">None</span> : line;
      },
    },
  ];

  const empty = filtered
    ? {
        icon: 'magnifying-glass' as const,
        title: 'No applications match these filters',
        body: (
          <Button size="sm" onClick={clearAll}>
            Clear filters
          </Button>
        ),
      }
    : { icon: 'identification-card' as const, ...EMPTY_VIEWS[view] };

  const waiting = summary.data;

  return (
    <MemberProvider guildId={guildId} userIds={memberIds} source={source}>
      <div className="applications-review-queue">
        <SegmentedTabs
          label="Application status"
          className="applications-review-tabs"
          items={viewTabs(waiting)}
          value={view}
          onChange={(next) =>
            onSearch({ view: next === 'awaiting' ? undefined : next, page: undefined })
          }
        />

        {waiting !== undefined && waiting.awaiting > 0 ? (
          <p className="applications-review-summary">
            <span>{waiting.unassigned} unassigned</span>
            {waiting.oldestAwaitingAt !== null ? (
              <>
                <MetaSeparator />
                <When at={waiting.oldestAwaitingAt} now={now} prefix="Oldest submitted " />
              </>
            ) : null}
            {waiting.problems > 0 ? (
              <>
                <MetaSeparator />
                <span className="text-warning">{waiting.problems} with failed actions</span>
              </>
            ) : null}
          </p>
        ) : null}

        <div className="table-toolbar applications-review-toolbar">
          <SearchField
            value={draft}
            onChange={setDraft}
            label="Search applications"
            placeholder="#number, member ID or name"
          />

          <Field label="Form">
            {(props) => (
              <Select
                {...props}
                width="md"
                value={local.formId ?? ''}
                options={[
                  { value: '', label: 'Any form' },
                  ...forms.map((form) => ({ value: form.id, label: form.name })),
                ]}
                onChange={(value) => setFilter({ formId: value === '' ? undefined : value })}
              />
            )}
          </Field>

          <Field label="Assigned to">
            {(props) => (
              <Select
                {...props}
                width="sm"
                value={local.assignee ?? ''}
                options={ASSIGNEE_OPTIONS}
                onChange={(value) =>
                  setFilter({ assignee: value === 'me' || value === 'none' ? value : undefined })
                }
              />
            )}
          </Field>

          {filtered ? (
            <Button tone="ghost" size="sm" onClick={clearAll}>
              Clear filters
            </Button>
          ) : null}

          <Button
            size="sm"
            icon="clipboard-text"
            className="push-right"
            onClick={() => {
              setNotice(null);
              setExporting(true);
            }}
          >
            Export…
          </Button>
        </div>

        {notice !== null ? (
          <StatusBanner
            tone={notice.tone}
            live={notice.tone === 'danger' ? 'assertive' : 'polite'}
            onDismiss={() => setNotice(null)}
          >
            {notice.message}
          </StatusBanner>
        ) : null}

        {query.isError ? (
          <StatusBanner tone="danger" live="polite">
            {applicationsReadFailure(query.error, 'the applications')}
          </StatusBanner>
        ) : (
          <DataTable
            columns={columns}
            rows={rows}
            rowKey={(row) => row.id}
            loading={query.isPending}
            loadingLabel="Loading applications"
            onRowClick={(row) => onSearch({ id: row.id })}
            sort={{ field: request.sort, direction: request.dir }}
            onSortChange={(next) => {
              const field = SORT_FIELDS.find((candidate) => candidate === next.field);
              setFilter({ sort: field ?? 'submitted', dir: next.direction });
            }}
            empty={empty}
            footer={
              <>
                <Pagination
                  page={request.page}
                  pageSize={request.pageSize}
                  total={total}
                  noun="applications"
                  onPageChange={(next) => onSearch({ page: next })}
                />
                <Select
                  aria-label="Applications per page"
                  width="sm"
                  value={String(request.pageSize)}
                  options={PAGE_SIZES.map((size) => ({
                    value: String(size),
                    label: `${size} per page`,
                  }))}
                  onChange={(value) => setFilter({ pageSize: Number(value) })}
                />
              </>
            }
          />
        )}
      </div>

      <ExportDialog
        guildId={guildId}
        choice={{ view, formId: local.formId, formName }}
        open={exporting}
        onClose={() => setExporting(false)}
        onDone={setNotice}
      />
    </MemberProvider>
  );
}
