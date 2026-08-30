import {
  ACTION_KINDS,
  type BlockedMember,
  CASE_PAGE_SIZE_MAX,
  type CaseQuery,
  type CaseQueryInput,
  type CaseRecord,
  type CaseSortField,
  type LeaderboardRow,
  NEVER_RECORDED_KINDS,
  TICKET_PRIORITIES,
} from '@proton/core';
import type { TagSummary } from '@proton/module-tags/query';
import { PRIORITY_LABELS, TICKET_STATUSES } from '@proton/module-tickets/config';
import type {
  TicketQueryInput,
  TicketSortField,
  TicketSummary,
} from '@proton/module-tickets/query';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  type InputHTMLAttributes,
  type ReactElement,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { ConfirmDialog } from '../shell/confirm.tsx';
import { Icon } from '../shell/icon.tsx';
import { actionLook, toneClass } from '../shell/module-meta.ts';
import { DataTable, dataColumnHelper, lastPageOf, Pager } from '../table/data-table.tsx';
import type {
  BlockedMembersProps,
  CaseBrowserProps,
  LeaderboardProps,
  TagBrowserProps,
  TicketBrowserProps,
} from './props.ts';

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

export function pageSizeOf(raw: string): number | undefined {
  const parsed = Number(raw);
  if (raw.trim() === '' || !Number.isFinite(parsed)) return undefined;

  return Math.min(CASE_PAGE_SIZE_MAX, Math.max(1, Math.trunc(parsed)));
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
    // "#" alone is a glyph, and this header is a sort button whose whole name it becomes.
    header: 'Case',
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
    // The column ellipsises, and a reason is the one field of a case a moderator wrote by hand —
    // without the title there was nowhere in the product to read the rest of it.
    cell: (c) => {
      const reason = c.getValue();
      return reason ? <span title={reason}>{reason}</span> : '—';
    },
    header: 'Reason',
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
      if (row.original.dryRun) return <span className="chip chip-warn">rehearsal</span>;
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

// The column prints actionLook(kind).verb; the filter that searches it offered add_role and
// delete_message. Same source, sorted by what the admin reads, minus the kinds the ledger never
// records — offering a filter that can only ever return nothing is worse than omitting it.
const ACTION_OPTIONS: readonly { kind: string; label: string }[] = ACTION_KINDS.filter(
  (kind) => !NEVER_RECORDED_KINDS.has(kind),
)
  .map((kind) => ({ kind, label: actionLook(kind).verb }))
  .sort((a, b) => a.label.localeCompare(b.label));

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
      <p className="page-lede">Targets and moderators are listed by ID, not by name.</p>

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
            {ACTION_OPTIONS.map((option) => (
              <option key={option.kind} value={option.kind}>
                {option.label}
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
          // Clamped here, not left to the search schema: an out-of-range number fails validateSearch
          // in the loader, and typing 500 in a filter box replaced the ledger with an error card.
          onCommit={(next) => setFilters({ pageSize: pageSizeOf(next) })}
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
                      caseId: undefined,
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
                <span className="empty-state-title">There is no page {result.page}.</span>
                <p className="status">
                  {result.total} {result.total === 1 ? 'case matches' : 'cases match'} these
                  filters, which is fewer than this page would need.
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
  // Same reason DebouncedFilter resyncs: the address bar is the source of truth, and Back and
  // Clear filters both move it without going through this input. On defaultValue the box went on
  // showing a moderator id that was no longer filtering anything.
  const [seen, setSeen] = useState(value);
  const [draft, setDraft] = useState(value ?? '');

  if (seen !== value) {
    setSeen(value);
    setDraft(value ?? '');
  }

  function commit(): void {
    onCommit(draft.trim() === '' ? undefined : draft.trim());
  }

  return (
    <label className="filter">
      <span>{label}</span>
      <input
        type="text"
        inputMode={inputMode}
        value={draft}
        placeholder="Any"
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key !== 'Enter') return;
          e.preventDefault();
          commit();
        }}
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
      header: 'Rank',
      cell: (c) => (
        <span className={`rank-chip${c.getValue() <= 3 ? ' rank-chip-top' : ''}`}>
          {c.getValue()}
        </span>
      ),
    }),
    // Snowflakes and counts take the same mono the case ledger gives them: a column of ids set in
    // the prose face is a column nobody can scan down.
    levelColumn.accessor('userId', {
      id: 'userId',
      header: 'Member',
      cell: (c) => <span className="id">{c.getValue()}</span>,
    }),
    levelColumn.accessor('xp', {
      id: 'share',
      header: 'Share of the top score',
      cell: (c) => {
        const share = Math.round((c.getValue() / top) * 100);

        // The bar is the whole cell, so without a text alternative the column reads as empty.
        return (
          <span className="xp-bar" title={`${share}% of the top score on this page`}>
            <span className="xp-bar-fill" style={{ width: `${Math.max(2, share)}%` }} />
            <span className="sr-only">{share}% of the top score on this page</span>
          </span>
        );
      },
    }),
    levelColumn.accessor('level', {
      id: 'level',
      header: 'Level',
      cell: (c) => <span className="num mono">{c.getValue()}</span>,
    }),
    levelColumn.accessor('xp', {
      id: 'xp',
      header: 'XP',
      cell: (c) => <span className="num mono">{c.getValue().toLocaleString()}</span>,
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
      <p className="page-lede">Members are listed by ID, not by name.</p>

      <div className="table-card">
        <DataTable
          className="table"
          columns={leaderboardColumns}
          data={result.entries}
          empty={
            result.total > 0 ? (
              <div className="empty-state">
                <span className="tile">
                  <Icon name="arrow-u-down-left" />
                </span>
                <span className="empty-state-title">There is no page {search.page}.</span>
                <p className="status">
                  {result.total} {result.total === 1 ? 'member has' : 'members have'} earned XP,
                  which is fewer than this page would need.
                </p>
                <button
                  type="button"
                  className="button button-quiet"
                  onClick={() => onSearch({ page: lastPage })}
                >
                  Go to the last page
                </button>
              </div>
            ) : (
              <div className="empty-state">
                <span className="tile">
                  <Icon name="chart-bar" />
                </span>
                <span className="empty-state-title">Nobody has earned XP yet.</span>
                <p className="status">
                  Members appear here once Leveling is switched on and somebody talks.
                </p>
              </div>
            )
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
    // Cut with an ellipsis and the whole thing on the title, rather than stopping mid-word with no
    // sign there was more and no way to see it.
    cell: (c) => {
      const content = c.getValue();
      return (
        <span title={content}>{content.length > 80 ? `${content.slice(0, 80)}…` : content}</span>
      );
    },
  }),
  tagColumn.accessor('uses', {
    id: 'uses',
    header: 'Used',
    cell: (c) => <span className="num mono">{c.getValue().toLocaleString()}</span>,
  }),
  tagColumn.accessor('createdBy', {
    id: 'createdBy',
    header: 'Written by',
    cell: (c) => <span className="id">{c.getValue()}</span>,
  }),
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
            result.total > 0 ? (
              <div className="empty-state">
                <span className="tile">
                  <Icon name="arrow-u-down-left" />
                </span>
                <span className="empty-state-title">There is no page {search.page}.</span>
                <p className="status">
                  {result.total} {result.total === 1 ? 'tag matches' : 'tags match'} this filter,
                  which is fewer than this page would need.
                </p>
                <button
                  type="button"
                  className="button button-quiet"
                  onClick={() => onSearch({ page: lastPage })}
                >
                  Go to the last page
                </button>
              </div>
            ) : (
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
            )
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

const ticketColumn = dataColumnHelper<TicketSummary>();

function sentenceCase(word: string): string {
  return `${word.slice(0, 1).toUpperCase()}${word.slice(1)}`;
}

function statusChip(status: TicketSummary['status']): string {
  if (status === 'closed') return 'chip chip-ok';
  if (status === 'deleted') return 'chip chip-warn';

  return 'chip';
}

const ticketColumns = ticketColumn.columns([
  ticketColumn.accessor('number', {
    id: 'number',
    header: 'Ticket',
    cell: (c) => `#${c.getValue()}`,
  }),
  ticketColumn.accessor('subject', {
    id: 'subject',
    header: 'Subject',
    cell: (c) => {
      const subject = c.getValue();
      if (!subject) return '—';

      return (
        <span title={subject}>{subject.length > 60 ? `${subject.slice(0, 60)}…` : subject}</span>
      );
    },
  }),
  ticketColumn.accessor('typeId', {
    id: 'typeId',
    header: 'Type',
    cell: (c) => <span className="mono">{c.getValue()}</span>,
  }),
  ticketColumn.accessor('status', {
    id: 'status',
    header: 'Status',
    cell: (c) => <span className={statusChip(c.getValue())}>{c.getValue()}</span>,
  }),
  ticketColumn.accessor('priority', {
    id: 'priority',
    header: 'Priority',
    cell: (c) => (
      <span className={c.getValue() === 'urgent' ? 'chip chip-warn' : 'chip'}>
        {PRIORITY_LABELS[c.getValue()]}
      </span>
    ),
  }),
  ticketColumn.accessor('ownerId', {
    id: 'ownerId',
    header: 'Owner',
    cell: (c) => <span className="id">{c.getValue()}</span>,
  }),
  ticketColumn.accessor('claimedById', {
    id: 'claimedById',
    header: 'Claimed by',
    cell: (c) => {
      const id = c.getValue();
      return id ? <span className="id">{id}</span> : '—';
    },
  }),
  ticketColumn.accessor('openedAt', {
    id: 'openedAt',
    header: 'Opened (UTC)',
    cell: (c) => <span className="stamp">{formatInstant(c.getValue())}</span>,
  }),
  ticketColumn.accessor('closedAt', {
    id: 'closedAt',
    header: 'Closed (UTC)',
    cell: (c) => {
      const at = c.getValue();
      return at ? <span className="stamp">{formatInstant(at)}</span> : '—';
    },
  }),
]);

const TICKET_SORTABLE: Record<string, TicketSortField> = {
  number: 'number',
  openedAt: 'openedAt',
  closedAt: 'closedAt',
};

export function TicketBrowserView({
  search,
  data: result,
  onSearch,
}: TicketBrowserProps): ReactElement {
  function setFilters(patch: Partial<TicketQueryInput>): void {
    onSearch({ ...patch, page: patch.page ?? 1 });
  }

  const lastPage = lastPageOf(result.total, result.pageSize);

  const filtered =
    search.search !== undefined ||
    search.status !== undefined ||
    search.priority !== undefined ||
    search.typeId !== undefined ||
    search.ownerId !== undefined;

  return (
    <div className="panel-wide">
      <p className="page-lede">
        Members are listed by ID, not by name. A ticket stays here after its channel is gone.
      </p>

      <div className="filters">
        <label className="filter">
          <span>Status</span>
          <select
            value={search.status ?? ''}
            onChange={(e) =>
              setFilters({
                status:
                  e.target.value === '' ? undefined : (e.target.value as typeof search.status),
              })
            }
          >
            <option value="">Any</option>
            {TICKET_STATUSES.map((status) => (
              <option key={status} value={status}>
                {sentenceCase(status)}
              </option>
            ))}
          </select>
        </label>

        <label className="filter">
          <span>Priority</span>
          <select
            value={search.priority ?? ''}
            onChange={(e) =>
              setFilters({
                priority:
                  e.target.value === '' ? undefined : (e.target.value as typeof search.priority),
              })
            }
          >
            <option value="">Any</option>
            {TICKET_PRIORITIES.map((priority) => (
              <option key={priority} value={priority}>
                {PRIORITY_LABELS[priority]}
              </option>
            ))}
          </select>
        </label>

        <IdFilter
          label="Type"
          inputMode="text"
          value={search.typeId}
          onCommit={(typeId) => setFilters({ typeId })}
        />
        <IdFilter
          label="Owner ID"
          value={search.ownerId}
          onCommit={(ownerId) => setFilters({ ownerId })}
        />

        <DebouncedFilter
          label="Subject contains"
          type="search"
          value={search.search ?? ''}
          onCommit={(next) => setFilters({ search: next || undefined })}
        />
      </div>

      <div className="table-card">
        <DataTable
          className="table"
          columns={ticketColumns}
          data={result.tickets}
          rowAttributes={(row) => ({ 'data-ticket-number': row.number })}
          sort={{
            fields: TICKET_SORTABLE,
            field: search.sort,
            direction: search.direction,
            onSort: setFilters,
          }}
          empty={
            result.total > 0 ? (
              <div className="empty-state">
                <span className="tile">
                  <Icon name="arrow-u-down-left" />
                </span>
                <span className="empty-state-title">There is no page {search.page}.</span>
                <p className="status">
                  {result.total} {result.total === 1 ? 'ticket matches' : 'tickets match'} these
                  filters, which is fewer than this page would need.
                </p>
                <button
                  type="button"
                  className="button button-quiet"
                  onClick={() => setFilters({ page: lastPage })}
                >
                  Go to the last page
                </button>
              </div>
            ) : filtered ? (
              <div className="empty-state">
                <span className="tile">
                  <Icon name="funnel-x" />
                </span>
                <span className="empty-state-title">No ticket matches these filters.</span>
                <p className="status">
                  Every ticket this server has opened is kept, the closed and deleted ones included,
                  so an empty list here means nothing matched.
                </p>
                <button
                  type="button"
                  className="button button-quiet"
                  onClick={() =>
                    setFilters({
                      search: undefined,
                      status: undefined,
                      priority: undefined,
                      typeId: undefined,
                      ownerId: undefined,
                    })
                  }
                >
                  Clear filters
                </button>
              </div>
            ) : (
              <div className="empty-state">
                <span className="tile">
                  <Icon name="ticket" />
                </span>
                <span className="empty-state-title">Nobody has opened a ticket yet.</span>
                <p className="status">
                  Tickets appear here once the module is switched on and a member opens one from a
                  panel.
                </p>
              </div>
            )
          }
        />
      </div>

      <Pager
        className="pagination"
        page={search.page}
        lastPage={lastPage}
        onPage={(page) => setFilters({ page })}
      >
        <span className="status">
          Page {search.page} of {lastPage}
        </span>
      </Pager>
    </div>
  );
}

// The mutation lives beside the row rather than on the page: the table is what knows which member
// a press belongs to, and hoisting it would mean threading a callback through every column.
function useLiftBlockedMember(guildId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: { userId: string }) =>
      // Imported lazily: server/modules.ts opens better-auth's database at module scope.
      (await import('../../server/modules.ts')).liftBlockedMember({
        data: { guildId, userId: input.userId, liftReason: 'Lifted from the dashboard.' },
      }),

    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ['guild', guildId, 'view', 'blocked'] }),
  });
}

const blockedColumn = dataColumnHelper<BlockedMember>();

function LiftCell({ row }: { row: BlockedMember }): ReactElement {
  const [asking, setAsking] = useState(false);
  const lift = useLiftBlockedMember(row.guildId);

  if (row.liftedAt !== null) {
    return (
      <span className="chip" title={row.liftReason ?? undefined}>
        Lifted
      </span>
    );
  }

  return (
    <>
      <button
        type="button"
        className="button button-quiet"
        onClick={() => setAsking(true)}
        disabled={lift.isPending}
      >
        Lift
      </button>

      {asking ? (
        <ConfirmDialog
          title="Lift this block?"
          cancelLabel="Leave it in place"
          confirmLabel="Lift the block"
          tone="quiet"
          onCancel={() => setAsking(false)}
          onConfirm={() => {
            setAsking(false);
            lift.mutate({ userId: row.userId });
          }}
        >
          {row.userId} will be able to verify in this server again. This does not unban them — if
          they were also banned, that is a separate lift in Discord.
        </ConfirmDialog>
      ) : null}
    </>
  );
}

const blockedColumns = blockedColumn.columns([
  blockedColumn.accessor('userId', {
    id: 'userId',
    header: 'Member',
    cell: (c) => <span className="id">{c.getValue()}</span>,
  }),
  blockedColumn.accessor('reason', {
    id: 'reason',
    header: 'Why',
    cell: (c) => {
      const reason = c.getValue();
      return (
        <span className="blocklist-reason" title={reason}>
          {reason.length > 90 ? `${reason.slice(0, 90)}…` : reason}
        </span>
      );
    },
  }),
  blockedColumn.accessor('moduleId', { id: 'moduleId', header: 'Added by' }),
  blockedColumn.accessor('createdAt', {
    id: 'createdAt',
    header: 'When',
    cell: (c) => <span className="mono">{formatInstant(c.getValue())}</span>,
  }),
  blockedColumn.display({
    id: 'actions',
    header: '',
    cell: (c) => <LiftCell row={c.row.original} />,
  }),
]);

export function BlockedMembersView({
  search,
  data: result,
  onSearch,
}: BlockedMembersProps): ReactElement {
  const lastPage = lastPageOf(result.total, search.pageSize);

  return (
    <div className="panel-wide">
      <div className="filters">
        <DebouncedFilter
          label="Member id"
          type="search"
          inputMode="numeric"
          value={search.userId ?? ''}
          onCommit={(next) => onSearch({ userId: next || undefined, page: 1 })}
        />

        <label className="filter">
          <span>Showing</span>
          <select
            value={search.state}
            onChange={(e) => onSearch({ state: e.target.value as typeof search.state, page: 1 })}
          >
            <option value="live">Still blocked</option>
            <option value="lifted">Lifted</option>
            <option value="all">Both</option>
          </select>
        </label>

        <DebouncedFilter
          label="Added by"
          type="search"
          value={search.moduleId ?? ''}
          onCommit={(next) => onSearch({ moduleId: next || undefined, page: 1 })}
        />
      </div>

      <div className="table-card">
        <DataTable
          className="table blocklist-table"
          columns={blockedColumns}
          data={result.rows}
          empty={
            <div className="empty-state">
              <span className="tile">
                <Icon name="shield-slash" />
              </span>
              <span className="empty-state-title">
                {search.state === 'lifted'
                  ? 'No block has been lifted in this server.'
                  : 'Nobody is on this server’s blocked list.'}
              </span>
              <p className="status">
                Proton adds an account here when a security module is configured to, and a blocked
                account cannot pass verification until somebody lifts it.
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
