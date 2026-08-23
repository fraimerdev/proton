import {
  ACTION_KINDS,
  CASE_PAGE_SIZE_MAX,
  type CaseQuery,
  type CaseQueryInput,
  type CaseRecord,
  type CaseSortField,
  type LeaderboardRow,
} from '@proton/core';
import type { TagSummary } from '@proton/module-tags/query';
import {
  type InputHTMLAttributes,
  type ReactElement,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Icon } from '../shell/icon.tsx';
import { actionLook, toneClass } from '../shell/module-meta.ts';
import { DataTable, dataColumnHelper, lastPageOf, Pager } from '../table/data-table.tsx';
import type { CaseBrowserProps, LeaderboardProps, TagBrowserProps } from './registry.ts';

type DebouncedProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'> & {
  label: string;
  value: string;
  onCommit: (next: string) => void;
};

const COMMIT_DELAY_MS = 250;

/**
 * A filter that navigates. Held locally and committed on a pause, because every commit rewrites the
 * query string and re-runs the loader: typing ten characters into a controlled input costs ten
 * round trips, and the box cannot show a character until its own round trip returns.
 */
function DebouncedFilter({ label, value, onCommit, ...rest }: DebouncedProps): ReactElement {
  const [draft, setDraft] = useState(value);
  const committed = useRef(value);

  const commit = useRef(onCommit);
  commit.current = onCommit;

  useEffect(() => {
    if (draft === committed.current) return;

    const timer = setTimeout(() => {
      committed.current = draft;
      commit.current(draft);
    }, COMMIT_DELAY_MS);

    return () => clearTimeout(timer);
  }, [draft]);

  // The address bar is the source of truth, and Back, the pager and a cleared filter all move it
  // without going through this input.
  useEffect(() => {
    committed.current = value;
    setDraft(value);
  }, [value]);

  return (
    <label className="filter">
      <span>{label}</span>
      <input {...rest} value={draft} onChange={(event) => setDraft(event.target.value)} />
    </label>
  );
}

const caseColumn = dataColumnHelper<CaseRecord>();

function formatInstant(iso: string): string {
  return iso.replace('T', ' ').slice(0, 16);
}

function ActionCell({ kind }: { kind: string }): ReactElement {
  const look = actionLook(kind);

  return (
    <span className="case-kind">
      <span className={`tile tile-sm ${toneClass(look.tone)}`}>
        <Icon name={look.icon} weight="fill" />
      </span>
      <span className="case-kind-name">{look.verb}</span>
    </span>
  );
}

const caseColumns = caseColumn.columns([
  caseColumn.accessor('caseNumber', {
    id: 'caseNumber',
    header: '#',
    cell: (c) => `#${c.getValue()}`,
  }),
  caseColumn.accessor('id', {
    id: 'id',
    header: 'Case ID',
    cell: (c) => <span className="id">{c.getValue()}</span>,
  }),
  caseColumn.accessor('type', {
    id: 'type',
    header: 'Action',
    cell: (c) => <ActionCell kind={c.getValue()} />,
  }),
  caseColumn.accessor('targetId', {
    id: 'targetId',
    header: 'Target',
    cell: (c) => {
      const id = c.getValue();
      return id ? <span className="id">{id}</span> : '—';
    },
  }),
  caseColumn.accessor('actorId', {
    id: 'actorId',
    header: 'Moderator',
    cell: (c) => {
      const id = c.getValue();
      return id ? (
        <span className="id">{id}</span>
      ) : (
        <span className="chip chip-system">
          <Icon name="lightning" weight="fill" />
          Proton
        </span>
      );
    },
  }),
  caseColumn.accessor('reason', {
    id: 'reason',
    header: 'Reason',
    cell: (c) => c.getValue() ?? '—',
  }),
  caseColumn.accessor('createdAt', {
    id: 'createdAt',
    header: 'When (UTC)',
    cell: (c) => <span className="stamp">{formatInstant(c.getValue())}</span>,
  }),
  caseColumn.display({
    id: 'state',
    header: 'State',

    cell: ({ row }) => {
      if (row.original.dryRun) return <span className="chip chip-warn">Rehearsal</span>;
      if (row.original.revertedAt)
        return (
          <span className="chip chip-ok">
            reverted <span className="mono">{formatInstant(row.original.revertedAt)}</span>
          </span>
        );
      if (row.original.expiresAt)
        return (
          <span className="chip">
            expires <span className="mono">{formatInstant(row.original.expiresAt)}</span>
          </span>
        );

      return <span className="chip">active</span>;
    },
  }),
]);

const ROW_HEIGHT = 56;

const SORTABLE: Record<string, CaseSortField> = {
  createdAt: 'createdAt',
  caseNumber: 'caseNumber',
};

export function CaseBrowserView({
  search,
  data: result,
  onSearch,
}: CaseBrowserProps): ReactElement {
  function setFilters(patch: Partial<CaseQueryInput>): void {
    onSearch({ ...patch, page: patch.page ?? 1 });
  }

  const lastPage = lastPageOf(result.total, result.pageSize);
  const firstShown = result.total === 0 ? 0 : (result.page - 1) * result.pageSize + 1;

  return (
    <div className="panel-wide">
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
          label="Case ID"
          inputMode="text"
          value={search.caseId}
          onCommit={(caseId) => setFilters({ caseId })}
        />
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

        <DebouncedFilter
          label="Per page"
          type="number"
          min={1}
          max={CASE_PAGE_SIZE_MAX}
          value={String(search.pageSize)}
          onCommit={(next) => setFilters({ pageSize: next === '' ? undefined : Number(next) })}
        />
      </div>

      <div className="table-card">
        <DataTable
          className="cases-table"
          columns={caseColumns}
          data={result.cases}
          virtual={{ rowHeight: ROW_HEIGHT }}
          rowAttributes={(row) => ({ 'data-case-number': row.caseNumber })}
          sort={{
            fields: SORTABLE,
            field: search.sort,
            direction: search.direction,
            onSort: setFilters,
          }}
          empty={
            result.total === 0 ? (
              <div className="empty-state">
                <span className="tile">
                  <Icon name="funnel-x" />
                </span>
                <span className="empty-state-title">No cases match these filters.</span>
                <p className="status">
                  Proton records a case for every action it takes, so an empty list here means
                  nothing matched — not that moderation is not being logged.
                </p>
                <button
                  type="button"
                  className="button button-quiet"
                  onClick={() =>
                    setFilters({
                      type: undefined,
                      moderatorId: undefined,
                      targetId: undefined,
                      from: undefined,
                      to: undefined,
                    })
                  }
                >
                  Clear filters
                </button>
              </div>
            ) : (
              <div className="empty-state">
                <span className="tile">
                  <Icon name="arrow-u-down-left" />
                </span>
                <p className="status">
                  Page {result.page} is past the end of {result.total} matching{' '}
                  {result.total === 1 ? 'case' : 'cases'}.
                </p>
                <button
                  type="button"
                  className="button button-quiet"
                  onClick={() => setFilters({ page: lastPage })}
                >
                  Go to the last page
                </button>
              </div>
            )
          }
        />
      </div>

      <Pager
        className="pager"
        page={result.page}
        lastPage={lastPage}
        onPage={(page) => setFilters({ page })}
      >
        <span className="status">
          {firstShown}–{firstShown + Math.max(result.cases.length - 1, 0)} of {result.total}
        </span>
      </Pager>
    </div>
  );
}

function IdFilter({
  label,
  value,
  onCommit,
  inputMode = 'numeric',
}: {
  label: string;
  value: string | undefined;
  onCommit: (value: string | undefined) => void;
  inputMode?: 'numeric' | 'text';
}): ReactElement {
  return (
    <label className="filter">
      <span>{label}</span>
      <input
        type="text"
        inputMode={inputMode}
        defaultValue={value ?? ''}
        placeholder="Any"
        onBlur={(e) => onCommit(e.target.value.trim() === '' ? undefined : e.target.value.trim())}
      />
    </label>
  );
}

const levelColumn = dataColumnHelper<LeaderboardRow>();

// The widest XP on the page, not the all-time top: a later page would otherwise draw every bar as
// a hairline and say nothing about the members standing on it.
function leaderboardColumnsFor(entries: readonly LeaderboardRow[]) {
  const top = entries.reduce((max, entry) => Math.max(max, entry.xp), 1);

  return levelColumn.columns([
    levelColumn.accessor('rank', {
      id: 'rank',
      header: '#',
      cell: (c) => (
        <span className={`rank-chip${c.getValue() <= 3 ? ' rank-chip-top' : ''}`}>
          {c.getValue()}
        </span>
      ),
    }),
    levelColumn.accessor('userId', { id: 'userId', header: 'Member' }),
    levelColumn.accessor('xp', {
      id: 'share',
      header: 'Share of the top score',
      cell: (c) => (
        <span className="xp-bar">
          <span
            className="xp-bar-fill"
            style={{ width: `${Math.max(2, Math.round((c.getValue() / top) * 100))}%` }}
          />
        </span>
      ),
    }),
    levelColumn.accessor('level', {
      id: 'level',
      header: 'Level',
      cell: (c) => `Level ${c.getValue()}`,
    }),
    levelColumn.accessor('xp', {
      id: 'xp',
      header: 'XP',
      cell: (c) => c.getValue().toLocaleString(),
    }),
  ]);
}

export function LeaderboardView({
  search,
  data: result,
  onSearch,
}: LeaderboardProps): ReactElement {
  const lastPage = lastPageOf(result.total, result.pageSize);
  const leaderboardColumns = useMemo(() => leaderboardColumnsFor(result.entries), [result.entries]);

  return (
    <div className="panel-wide">
      <p className="page-lede">
        Members are listed by ID. Proton does not resolve names, because Discord’s rate limits do
        not allow fetching a whole member list.
      </p>

      <div className="table-card">
        <DataTable
          className="table"
          columns={leaderboardColumns}
          data={result.entries}
          empty={
            <div className="empty-state">
              <span className="tile">
                <Icon name="chart-bar" />
              </span>
              <span className="empty-state-title">Nobody has earned XP yet.</span>
              <p className="status">
                Members appear here once Leveling is switched on and somebody talks.
              </p>
            </div>
          }
        />
      </div>

      <Pager
        className="pagination"
        page={search.page}
        lastPage={lastPage}
        onPage={(page) => onSearch({ page })}
      >
        <span className="status">
          Page {search.page} of {lastPage}
        </span>
      </Pager>
    </div>
  );
}

const tagColumn = dataColumnHelper<TagSummary>();

const tagColumns = tagColumn.columns([
  tagColumn.accessor('name', { id: 'name', header: 'Tag' }),
  tagColumn.accessor('content', {
    id: 'content',
    header: 'Posts',
    cell: (c) => c.getValue().slice(0, 80),
  }),
  tagColumn.accessor('uses', {
    id: 'uses',
    header: 'Used',
    cell: (c) => c.getValue().toLocaleString(),
  }),
  tagColumn.accessor('createdBy', { id: 'createdBy', header: 'Written by' }),
]);

export function TagBrowserView({ search, data: result, onSearch }: TagBrowserProps): ReactElement {
  const lastPage = lastPageOf(result.total, result.pageSize);

  return (
    <div className="panel-wide">
      <div className="filters">
        <DebouncedFilter
          label="Name contains"
          type="search"
          value={search.search ?? ''}
          onCommit={(next) => onSearch({ search: next || undefined, page: 1 })}
        />

        <label className="filter">
          <span>Sort by</span>
          <select
            value={search.sort}
            onChange={(e) => onSearch({ sort: e.target.value as typeof search.sort, page: 1 })}
          >
            <option value="name">Name</option>
            <option value="uses">Times used</option>
            <option value="createdAt">When it was written</option>
          </select>
        </label>

        <label className="filter">
          <span>Order</span>
          <select
            value={search.direction}
            onChange={(e) =>
              onSearch({ direction: e.target.value as typeof search.direction, page: 1 })
            }
          >
            <option value="asc">Ascending</option>
            <option value="desc">Descending</option>
          </select>
        </label>
      </div>

      <div className="table-card">
        <DataTable
          className="table"
          columns={tagColumns}
          data={result.tags}
          empty={
            <div className="empty-state">
              <span className="tile">
                <Icon name="tag" />
              </span>
              <span className="empty-state-title">
                {search.search ? 'No tag matches that name.' : 'This server has no tags yet.'}
              </span>
              <p className="status">
                {search.search
                  ? 'Try a shorter fragment — the filter matches anywhere in the name.'
                  : 'Anyone permitted can write one with /tags create.'}
              </p>
            </div>
          }
        />
      </div>

      <Pager
        className="pagination"
        page={search.page}
        lastPage={lastPage}
        onPage={(page) => onSearch({ page })}
      >
        <span className="status">
          Page {search.page} of {lastPage}
        </span>
      </Pager>
    </div>
  );
}
