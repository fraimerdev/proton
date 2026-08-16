import {
  ACTION_KINDS,
  CASE_PAGE_SIZE_MAX,
  type CaseQuery,
  type CaseQueryInput,
  type CaseRecord,
  caseQuerySchema,
} from '@proton/core';
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { createColumnHelper, tableFeatures, useTable } from '@tanstack/react-table';
import { useVirtualizer } from '@tanstack/react-virtual';
import { zodValidator } from '@tanstack/zod-adapter';
import { type ReactElement, useRef } from 'react';
import { searchCases } from '../../../server/modules.ts';

export const Route = createFileRoute('/dashboard/$guildId/cases')({
  validateSearch: zodValidator(caseQuerySchema),

  loaderDeps: ({ search }) => search,
  loader: ({ params, deps }) => searchCases({ data: { guildId: params.guildId, ...deps } }),
  component: CaseBrowser,
  errorComponent: SearchError,
});

const features = tableFeatures({});
const column = createColumnHelper<typeof features, CaseRecord>();

function formatInstant(iso: string): string {
  return iso.replace('T', ' ').slice(0, 16);
}

const columns = column.columns([
  column.accessor('caseNumber', { id: 'caseNumber', header: '#', cell: (c) => `#${c.getValue()}` }),
  column.accessor('type', { id: 'type', header: 'Action' }),
  column.accessor('targetId', {
    id: 'targetId',
    header: 'Target',
    cell: (c) => c.getValue() ?? '—',
  }),
  column.accessor('actorId', {
    id: 'actorId',
    header: 'Moderator',
    cell: (c) => c.getValue() ?? '—',
  }),
  column.accessor('reason', { id: 'reason', header: 'Reason', cell: (c) => c.getValue() ?? '—' }),
  column.accessor('createdAt', {
    id: 'createdAt',
    header: 'When (UTC)',
    cell: (c) => formatInstant(c.getValue()),
  }),
  column.display({
    id: 'state',
    header: 'State',

    cell: ({ row }) => {
      if (row.original.dryRun) return 'dry run';
      if (row.original.revertedAt) return `reverted ${formatInstant(row.original.revertedAt)}`;
      if (row.original.expiresAt) return `expires ${formatInstant(row.original.expiresAt)}`;
      return 'active';
    },
  }),
]);

const ROW_HEIGHT = 38;

function CaseBrowser(): ReactElement {
  const { guildId } = Route.useParams();
  const search = Route.useSearch();
  const result = Route.useLoaderData();
  const navigate = useNavigate({ from: Route.fullPath });

  const table = useTable({ features, columns, data: result.cases });

  const scrollRef = useRef<HTMLDivElement>(null);
  const rows = table.getRowModel().rows;

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,

    initialRect: { width: 0, height: 640 },
  });

  function setFilters(patch: Partial<CaseQueryInput>): void {
    void navigate({
      search: (prev) => ({
        ...prev,
        ...patch,

        page: patch.page ?? 1,
      }),
      replace: true,
    });
  }

  const lastPage = Math.max(1, Math.ceil(result.total / result.pageSize));
  const firstShown = result.total === 0 ? 0 : (result.page - 1) * result.pageSize + 1;

  return (
    <section className="panel panel-wide">
      <h1>Cases</h1>
      <p>
        <Link to="/guilds/$guildId/modules" params={{ guildId }}>
          Module settings
        </Link>
      </p>

      <div className="filters">
        <label className="filter">
          <span>Action</span>
          <select
            value={search.type ?? ''}
            onChange={(e) =>
              setFilters({
                type: e.target.value === '' ? undefined : (e.target.value as CaseQuery['type']),
              })
            }
          >
            <option value="">Any</option>
            {ACTION_KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {kind}
              </option>
            ))}
          </select>
        </label>

        <IdFilter
          label="Moderator ID"
          value={search.moderatorId}
          onCommit={(moderatorId) => setFilters({ moderatorId })}
        />
        <IdFilter
          label="Target ID"
          value={search.targetId}
          onCommit={(targetId) => setFilters({ targetId })}
        />

        <label className="filter">
          <span>From</span>
          <input
            type="date"
            value={search.from ?? ''}
            onChange={(e) =>
              setFilters({ from: e.target.value === '' ? undefined : e.target.value })
            }
          />
        </label>
        <label className="filter">
          <span>To</span>
          <input
            type="date"
            value={search.to ?? ''}
            onChange={(e) => setFilters({ to: e.target.value === '' ? undefined : e.target.value })}
          />
        </label>

        <label className="filter">
          <span>Per page</span>
          <input
            type="number"
            min={1}
            max={CASE_PAGE_SIZE_MAX}
            value={search.pageSize}
            onChange={(e) =>
              setFilters({ pageSize: e.target.value === '' ? undefined : e.target.valueAsNumber })
            }
          />
        </label>
      </div>

      <div className="table-scroll" ref={scrollRef}>
        <table className="cases-table">
          <thead>
            {table.getHeaderGroups().map((group) => (
              <tr key={group.id}>
                {group.headers.map((header) => (
                  <th
                    key={header.id}
                    scope="col"
                    data-column={header.id}
                    aria-sort={ariaSort(header.id, search)}
                  >
                    <SortableHeader
                      id={header.id}
                      label={String(header.column.columnDef.header ?? header.id)}
                      search={search}
                      onSort={setFilters}
                    />
                  </th>
                ))}
              </tr>
            ))}
          </thead>
          <tbody style={{ height: `${virtualizer.getTotalSize()}px` }}>
            {virtualizer.getVirtualItems().map((virtualRow) => {
              const row = rows[virtualRow.index];
              if (!row) return null;

              return (
                <tr
                  key={row.id}
                  data-case-number={row.original.caseNumber}
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '100%',
                    height: `${virtualRow.size}px`,
                    transform: `translateY(${virtualRow.start}px)`,
                  }}
                >
                  {row.getAllCells().map((cell) => (
                    <td key={cell.id} data-column={cell.column.id}>
                      <table.FlexRender cell={cell} />
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>

        {result.total === 0 ? (
          <p className="status">
            No cases match these filters. Proton records a case for every action it takes, so an
            empty list here means nothing matched — not that moderation is not being logged.
          </p>
        ) : null}

        {result.total > 0 && result.cases.length === 0 ? (
          <p className="status">
            Page {result.page} is past the end of {result.total} matching{' '}
            {result.total === 1 ? 'case' : 'cases'}.{' '}
            <button
              type="button"
              className="sort-button"
              onClick={() => setFilters({ page: lastPage })}
            >
              Go to the last page
            </button>
            .
          </p>
        ) : null}
      </div>

      <div className="pager">
        <button
          type="button"
          className="button button-quiet"
          disabled={result.page <= 1}
          onClick={() => setFilters({ page: result.page - 1 })}
        >
          Previous
        </button>
        <span className="status">
          {firstShown}–{firstShown + Math.max(result.cases.length - 1, 0)} of {result.total}
        </span>
        <button
          type="button"
          className="button button-quiet"
          disabled={result.page >= lastPage}
          onClick={() => setFilters({ page: result.page + 1 })}
        >
          Next
        </button>
      </div>
    </section>
  );
}

const SORTABLE: Record<string, 'createdAt' | 'caseNumber'> = {
  createdAt: 'createdAt',
  caseNumber: 'caseNumber',
};

function ariaSort(id: string, search: CaseQuery): 'ascending' | 'descending' | 'none' | undefined {
  const sortField = SORTABLE[id];

  if (!sortField) return undefined;
  if (search.sort !== sortField) return 'none';
  return search.direction === 'asc' ? 'ascending' : 'descending';
}

function SortableHeader({
  id,
  label,
  search,
  onSort,
}: {
  id: string;
  label: string;
  search: CaseQuery;
  onSort: (patch: Partial<CaseQueryInput>) => void;
}): ReactElement {
  const sortField = SORTABLE[id];
  if (!sortField) return <span>{label}</span>;

  const active = search.sort === sortField;
  const direction = active && search.direction === 'asc' ? 'desc' : 'asc';

  return (
    <button
      type="button"
      className="sort-button"
      onClick={() => onSort({ sort: sortField, direction })}
    >
      {label}
      {active ? (search.direction === 'asc' ? ' ▲' : ' ▼') : ''}
    </button>
  );
}

function IdFilter({
  label,
  value,
  onCommit,
}: {
  label: string;
  value: string | undefined;
  onCommit: (value: string | undefined) => void;
}): ReactElement {
  return (
    <label className="filter">
      <span>{label}</span>
      <input
        type="text"
        inputMode="numeric"
        defaultValue={value ?? ''}
        placeholder="Any"
        onBlur={(e) => onCommit(e.target.value.trim() === '' ? undefined : e.target.value.trim())}
      />
    </label>
  );
}

function SearchError({ error }: { error: Error }): ReactElement {
  return (
    <section className="panel">
      <h1>That case filter is not valid</h1>
      <p className="field-unsupported">{error.message}</p>
      <p>Remove the query string from the address bar to start from an unfiltered list.</p>
    </section>
  );
}
