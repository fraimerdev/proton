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
import { searchCases } from '../server/modules.ts';

/**
 * Case browsing (PLAN.md §12, Gate 1).
 *
 * Every filter lives in the URL, not in component state: §9 requires that a
 * filtered view be shareable, and a moderator pasting "every ban I issued last
 * week in this server" into a staff channel is the whole point. The schema is
 * the API's own (`caseQuerySchema` in core), so the URL cannot ask for something
 * the query cannot answer.
 */
export const Route = createFileRoute('/guilds/$guildId/cases')({
  validateSearch: zodValidator(caseQuerySchema),
  // Only the search params are loader inputs; without this the loader would not
  // re-run when a filter changes and the table would silently show stale rows.
  loaderDeps: ({ search }) => search,
  loader: ({ params, deps }) => searchCases({ data: { guildId: params.guildId, ...deps } }),
  component: CaseBrowser,
  errorComponent: SearchError,
});

const features = tableFeatures({});
const column = createColumnHelper<typeof features, CaseRecord>();

/** A UTC timestamp, rendered the same way for every viewer — moderation logs are compared across timezones. */
function formatInstant(iso: string): string {
  return iso.replace('T', ' ').slice(0, 16);
}

// `column.columns` rather than a bare array: it preserves each column's own
// value type instead of widening them all to `unknown`.
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
    // Three states an admin needs to tell apart at a glance: a dry run never
    // happened, a reverted action no longer applies, a temp action still will.
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
    // The server has no scroll element to measure. Without a starting rect the
    // first paint would be an empty table that fills in only after hydration.
    initialRect: { width: 0, height: 640 },
  });

  /**
   * Every control writes to the URL; the loader is what re-queries.
   *
   * The patch is typed against the schema's *input*, so clearing a control to
   * `undefined` is expressible — the schema then supplies the default on the
   * next parse, rather than the page having to know what the default is.
   */
  function setFilters(patch: Partial<CaseQueryInput>): void {
    void navigate({
      search: (prev) => ({
        ...prev,
        ...patch,
        // Any filter change invalidates the current offset — page 4 of the old
        // result set is not page 4 of the new one, and landing on an empty page
        // reads as "no cases match" when the truth is "not on this page".
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
                  // Column widths are driven by `data-column` in the stylesheet:
                  // the rows are absolutely positioned for virtualisation, so
                  // the browser's own table layout cannot size them.
                  <th
                    key={header.id}
                    scope="col"
                    data-column={header.id}
                    // `aria-sort` belongs on the column header itself, not on
                    // the button inside it — a screen reader announces the
                    // column's sort state, not the control's.
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

        {/* A page past the end is not "nothing matched", and saying so would
            send an admin hunting for a filter bug that does not exist. */}
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

/** Only these columns are sortable — the rest have no index behind them (§6). */
const SORTABLE: Record<string, 'createdAt' | 'caseNumber'> = {
  createdAt: 'createdAt',
  caseNumber: 'caseNumber',
};

function ariaSort(id: string, search: CaseQuery): 'ascending' | 'descending' | 'none' | undefined {
  const sortField = SORTABLE[id];
  // Undefined, not 'none': 'none' claims the column is sortable and simply
  // unsorted, which is a lie for a column that can never be sorted.
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

/**
 * A snowflake filter that only navigates once the field is left.
 *
 * `caseQuerySchema` refuses anything that is not a snowflake, so navigating on
 * every keystroke would put the route into its error state after the first
 * digit.
 */
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

/**
 * A URL is user input — someone edits one by hand, or an old link outlives a
 * schema change. Naming the offending filter beats a blank screen.
 */
function SearchError({ error }: { error: Error }): ReactElement {
  return (
    <section className="panel">
      <h1>That case filter is not valid</h1>
      <p className="field-unsupported">{error.message}</p>
      <p>Remove the query string from the address bar to start from an unfiltered list.</p>
    </section>
  );
}
