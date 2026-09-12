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
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  type InputHTMLAttributes,
  type ReactElement,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { failureDetail, readFailure, saveFailure } from '../../lib/errors.ts';
import { MEMBER_LOOKUP_MAX, membersQuery } from '../../lib/queries.ts';
import { ConfirmDialog } from '../shell/confirm.tsx';
import { Icon } from '../shell/icon.tsx';
import { actionLook, toneClass } from '../shell/module-meta.ts';
import { type ChipMember, memberIndex, UserChip } from '../shell/user-chip.tsx';
import {
  DATA_ROW_HEIGHT,
  DataTable,
  dataColumnHelper,
  lastPageOf,
  Pager,
} from '../table/data-table.tsx';
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

const GUILD_IN_PATH = /^\/dashboard\/(\d{17,20})(?:\/|$)/;

// These five views are rendered by a lazy route component and also on their own, outside any
// router, so a router hook here throws rather than degrading. The open server is in the path.
function openGuildId(): string | null {
  if (typeof window === 'undefined') return null;

  return GUILD_IN_PATH.exec(window.location.pathname)?.[1] ?? null;
}

interface Directory {
  of: (id: string | null | undefined) => ChipMember | null;

  // Asked for and not answered. A member who has left the server is the ordinary reason, and no
  // name is invented for them — the chip falls back to the id, which is then the whole answer.
  unresolved: number;
  overCap: number;
  failure: string | null;
  detail: string | undefined;
  retry: () => void;
}

/**
 * The people behind a page of snowflakes. Every surface here used to print the raw id and then
 * apologise for it in a lede — "Targets and moderators are listed by ID, not by name" — which is
 * the interface telling you it knows it is wrong.
 */
function useMembers(ids: readonly (string | null)[]): Directory {
  const guildId = openGuildId();
  const wanted = useMemo(() => [...new Set(ids.filter((id): id is string => !!id))], [ids]);

  const answer = useQuery({
    ...membersQuery(guildId ?? '', wanted),
    enabled: guildId !== null && wanted.length > 0,
  });

  const index = useMemo(() => memberIndex(answer.data ?? []), [answer.data]);
  const { data, error, refetch } = answer;

  return useMemo(() => {
    // Sorted before slicing because membersQuery sorts before slicing: the hundred actually asked
    // for are not the first hundred in page order, and counting the other set reports the wrong
    // number of accounts as missing.
    const asked = [...wanted].sort().slice(0, MEMBER_LOOKUP_MAX);

    return {
      of: (id) => (id ? (index.get(id) ?? null) : null),
      unresolved: data === undefined ? 0 : asked.filter((id) => !index.has(id)).length,
      overCap: wanted.length - asked.length,
      failure: error === null ? null : readFailure(error, 'this server’s members'),
      detail: failureDetail(error),
      retry: () => void refetch(),
    };
  }, [wanted, index, data, error, refetch]);
}

function MemberNotice({ directory }: { directory: Directory }): ReactElement | null {
  if (directory.failure !== null) {
    return (
      <p className="view-notice" role="alert" title={directory.detail}>
        <Icon name="warning-circle" weight="fill" />
        <span>
          {directory.failure} Every account below is listed by its id.
          <button type="button" className="button button-quiet" onClick={directory.retry}>
            Try again
          </button>
        </span>
      </p>
    );
  }

  if (directory.overCap > 0) {
    return (
      <p className="view-notice">
        <span>
          Names are looked up for the first {MEMBER_LOOKUP_MAX} accounts on a page, and this one
          shows {directory.overCap} more. Those are listed by id; a smaller page size resolves them.
        </span>
      </p>
    );
  }

  if (directory.unresolved > 0) {
    return (
      <p className="view-notice">
        <span>
          {directory.unresolved === 1
            ? 'One account here could not be looked up'
            : `${directory.unresolved} accounts here could not be looked up`}{' '}
          — a member who has left the server is the usual reason. They keep their id.
        </span>
      </p>
    );
  }

  return null;
}

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

function relativeTime(iso: string, now: number): string {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return iso;

  const delta = now - at;
  const away = Math.abs(delta);

  if (away >= DAY_MS) return iso.slice(0, 10);
  if (away < MINUTE_MS) return 'just now';

  const amount =
    away < HOUR_MS ? `${Math.floor(away / MINUTE_MS)}m` : `${Math.floor(away / HOUR_MS)}h`;

  return delta >= 0 ? `${amount} ago` : `in ${amount}`;
}

function absoluteUtc(iso: string): string {
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

// suppressHydrationWarning because the text is a function of the clock: the server renders "4m ago"
// and the browser re-renders it a second later, which is the one mismatch React cannot patch
// quietly. The absolute instant on the title is identical in both.
function Stamp({ iso }: { iso: string }): ReactElement {
  return (
    <time className="stamp" dateTime={iso} title={absoluteUtc(iso)} suppressHydrationWarning>
      {relativeTime(iso, Date.now())}
    </time>
  );
}

interface FilterBarProps {
  applied: number;
  onClear: () => void;
  children: ReactNode;
  more?: { applied: number; children: ReactNode } | undefined;
}

/**
 * Four controls and the way out of them. Seven filters could be applied here and only cleared one
 * at a time, because the only reset in the product lived inside the empty state — so the moment the
 * filters returned rows, which is the normal case, the reset disappeared.
 */
function FilterBar({ applied, onClear, children, more }: FilterBarProps): ReactElement {
  const [open, setOpen] = useState(false);

  return (
    <div className="filters">
      <div className="filter-row">
        {children}

        <div className="filter-actions">
          {more ? (
            <button
              type="button"
              className="button button-ghost"
              aria-expanded={open}
              onClick={() => setOpen((was) => !was)}
            >
              {more.applied > 0 ? `More filters (${more.applied})` : 'More filters'}
              <Icon name={open ? 'caret-up' : 'caret-down'} />
            </button>
          ) : null}

          {applied > 0 ? (
            <button type="button" className="button button-quiet" onClick={onClear}>
              Clear all ({applied})
            </button>
          ) : null}
        </div>
      </div>

      {more && open ? <div className="filter-row filter-row-more">{more.children}</div> : null}
    </div>
  );
}

function countSet(values: readonly unknown[]): number {
  return values.filter((value) => value !== undefined && value !== '').length;
}

const caseColumn = dataColumnHelper<CaseRecord>();

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

function caseColumnsFor(directory: Directory, onTarget: (targetId: string) => void) {
  return caseColumn.columns([
    caseColumn.accessor('caseNumber', {
      id: 'caseNumber',
      // "#" alone is a glyph, and this header is a sort button whose whole name it becomes.
      header: 'Case',
      // The opaque case id had a column of its own that nobody reads and that Reason needed the
      // width of. It stays on the row, where a moderator quoting it into /case can still find it.
      cell: (c) => (
        <span className="case-number" title={`Case id ${c.row.original.id}`}>
          #{c.getValue()}
        </span>
      ),
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
        return id ? <UserChip id={id} member={directory.of(id)} as="target" /> : '—';
      },
    }),
    caseColumn.accessor('actorId', {
      id: 'actorId',
      header: 'Moderator',
      cell: (c) => {
        const id = c.getValue();
        return id ? (
          <UserChip id={id} member={directory.of(id)} as="moderator" />
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
      header: 'When',
      cell: (c) => <Stamp iso={c.getValue()} />,
    }),
    caseColumn.display({
      id: 'state',
      header: 'State',

      cell: ({ row }) => {
        if (row.original.dryRun) return <span className="chip chip-warn">rehearsal</span>;
        if (row.original.revertedAt)
          return (
            <span className="chip chip-ok">
              reverted <Stamp iso={row.original.revertedAt} />
            </span>
          );
        if (row.original.expiresAt)
          return (
            <span className="chip">
              expires <Stamp iso={row.original.expiresAt} />
            </span>
          );

        return <span className="chip">active</span>;
      },
    }),
    caseColumn.display({
      id: 'actions',
      header: '',
      cell: ({ row }) => {
        const id = row.original.targetId;
        if (id === null) return null;

        return (
          <button
            type="button"
            className="icon-button"
            aria-label={`Show every case against ${directory.of(id)?.displayName ?? id}`}
            onClick={() => onTarget(id)}
          >
            <Icon name="magnifying-glass" />
          </button>
        );
      },
    }),
  ]);
}

interface TargetGroup {
  targetId: string;
  cases: number;
  kinds: string[];
  first: string;
  last: string;
  open: number;
}

// Grouped over the page, because that is the honest extent of it: the ledger is paged and the
// dashboard cannot ask for every case an account has ever collected in one answer. Filtering to the
// account is what does that, and the row's own button is the way there.
function groupByTarget(cases: readonly CaseRecord[]): TargetGroup[] {
  const groups = new Map<string, TargetGroup>();

  for (const record of cases) {
    if (record.targetId === null) continue;

    const held = groups.get(record.targetId);
    const group =
      held ??
      ({
        targetId: record.targetId,
        cases: 0,
        kinds: [],
        first: record.createdAt,
        last: record.createdAt,
        open: 0,
      } satisfies TargetGroup);

    group.cases += 1;
    if (!group.kinds.includes(record.type)) group.kinds.push(record.type);
    if (record.createdAt < group.first) group.first = record.createdAt;
    if (record.createdAt > group.last) group.last = record.createdAt;
    if (record.revertedAt === null && !record.dryRun) group.open += 1;

    groups.set(record.targetId, group);
  }

  return [...groups.values()].sort((a, b) => b.cases - a.cases || b.last.localeCompare(a.last));
}

const groupColumn = dataColumnHelper<TargetGroup>();

function groupColumnsFor(directory: Directory, onTarget: (targetId: string) => void) {
  return groupColumn.columns([
    groupColumn.accessor('targetId', {
      id: 'targetId',
      header: 'Account',
      cell: (c) => <UserChip id={c.getValue()} member={directory.of(c.getValue())} as="target" />,
    }),
    groupColumn.accessor('cases', {
      id: 'cases',
      header: 'Cases',
      cell: (c) => <span className="num mono">{c.getValue()}</span>,
    }),
    groupColumn.accessor('open', {
      id: 'open',
      header: 'Not reverted',
      cell: (c) => <span className="num mono">{c.getValue()}</span>,
    }),
    groupColumn.accessor('kinds', {
      id: 'kinds',
      header: 'What was done',
      cell: (c) => (
        <span className="group-kinds">
          {c.getValue().map((kind) => (
            <ActionCell key={kind} kind={kind} />
          ))}
        </span>
      ),
    }),
    groupColumn.accessor('first', {
      id: 'first',
      header: 'First',
      cell: (c) => <Stamp iso={c.getValue()} />,
    }),
    groupColumn.accessor('last', {
      id: 'last',
      header: 'Latest',
      cell: (c) => <Stamp iso={c.getValue()} />,
    }),
    groupColumn.display({
      id: 'actions',
      header: '',
      cell: ({ row }) => (
        <button
          type="button"
          className="button button-quiet"
          onClick={() => onTarget(row.original.targetId)}
        >
          Only this account
        </button>
      ),
    }),
  ]);
}

// The column prints actionLook(kind).verb; the filter that searches it offered add_role and
// delete_message. Same source, sorted by what the admin reads, minus the kinds the ledger never
// records — offering a filter that can only ever return nothing is worse than omitting it.
const ACTION_OPTIONS: readonly { kind: string; label: string }[] = ACTION_KINDS.filter(
  (kind) => !NEVER_RECORDED_KINDS.has(kind),
)
  .map((kind) => ({ kind, label: actionLook(kind).verb }))
  .sort((a, b) => a.label.localeCompare(b.label));

const SORTABLE: Record<string, CaseSortField> = {
  createdAt: 'createdAt',
  caseNumber: 'caseNumber',
};

const NO_CASE_FILTERS: Partial<CaseQueryInput> = {
  type: undefined,
  caseId: undefined,
  moderatorId: undefined,
  targetId: undefined,
  from: undefined,
  to: undefined,
};

export function CaseBrowserView({
  search,
  data: result,
  onSearch,
}: CaseBrowserProps): ReactElement {
  const [grouped, setGrouped] = useState(false);

  function setFilters(patch: Partial<CaseQueryInput>): void {
    onSearch({ ...patch, page: patch.page ?? 1 });
  }

  const lastPage = lastPageOf(result.total, result.pageSize);
  const firstShown = result.total === 0 ? 0 : (result.page - 1) * result.pageSize + 1;

  const ids = useMemo(
    () => result.cases.flatMap((record) => [record.targetId, record.actorId]),
    [result.cases],
  );
  const directory = useMembers(ids);

  // Through a ref: the route hands a fresh onSearch down on every render, and a callback that
  // changed with it would rebuild the column definitions — and with them the whole virtualised
  // table model — once per keystroke in a filter box.
  const navigate = useRef(onSearch);
  navigate.current = onSearch;

  const onTarget = useCallback((targetId: string): void => {
    setGrouped(false);
    navigate.current({ targetId, page: 1 });
  }, []);

  const columns = useMemo(() => caseColumnsFor(directory, onTarget), [directory, onTarget]);
  const groups = useMemo(() => groupByTarget(result.cases), [result.cases]);
  const groupColumns = useMemo(() => groupColumnsFor(directory, onTarget), [directory, onTarget]);

  const applied = countSet([
    search.type,
    search.caseId,
    search.moderatorId,
    search.targetId,
    search.from,
    search.to,
  ]);

  return (
    <div className="panel-wide">
      <FilterBar
        applied={applied}
        onClear={() => setFilters(NO_CASE_FILTERS)}
        more={{
          applied: countSet([search.caseId]),
          children: (
            <IdFilter
              label="Case ID"
              inputMode="text"
              value={search.caseId}
              onCommit={(caseId) => setFilters({ caseId })}
            />
          ),
        }}
      >
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
          label="Target ID"
          value={search.targetId}
          onCommit={(targetId) => setFilters({ targetId })}
        />
        <IdFilter
          label="Moderator ID"
          value={search.moderatorId}
          onCommit={(moderatorId) => setFilters({ moderatorId })}
        />

        {/* One filter, two ends. Two separate rows read as two independent narrowings, and the
            schema refuses them as a pair anyway — a reversed range is one error, not two. */}
        <span className="filter filter-range">
          <span className="filter-range-label">Between</span>
          <span className="filter-range-pair">
            <input
              type="date"
              aria-label="Earliest date"
              value={search.from ?? ''}
              onChange={(e) =>
                setFilters({ from: e.target.value === '' ? undefined : e.target.value })
              }
            />
            <span aria-hidden="true">–</span>
            <input
              type="date"
              aria-label="Latest date"
              value={search.to ?? ''}
              onChange={(e) =>
                setFilters({ to: e.target.value === '' ? undefined : e.target.value })
              }
            />
          </span>
        </span>
      </FilterBar>

      <fieldset className="view-switch">
        <legend className="sr-only">How the ledger is grouped</legend>
        <button
          type="button"
          className="view-switch-button"
          aria-pressed={!grouped}
          onClick={() => setGrouped(false)}
        >
          By case
        </button>
        <button
          type="button"
          className="view-switch-button"
          aria-pressed={grouped}
          onClick={() => setGrouped(true)}
        >
          By account
        </button>
      </fieldset>

      <MemberNotice directory={directory} />

      {grouped ? (
        <>
          <p className="view-notice">
            <span>
              {groups.length === 1 ? '1 account' : `${groups.length} accounts`} across the{' '}
              {result.cases.length} cases on this page. Proton cannot group a whole ledger in one
              answer, so “Only this account” is what reads the rest of an account’s record.
            </span>
          </p>

          <div className="table-card">
            <DataTable
              className="table groups-table"
              columns={groupColumns}
              data={groups}
              rowAttributes={(row) => ({ 'data-target-id': row.targetId })}
              empty={
                <div className="empty-state">
                  <span className="tile">
                    <Icon name="funnel-x" />
                  </span>
                  <span className="empty-state-title">No case on this page names an account.</span>
                  <p className="status">
                    A case Proton recorded against the server itself — a channel deletion, a role
                    change — has no target to group under.
                  </p>
                </div>
              }
            />
          </div>
        </>
      ) : (
        <div className="table-card">
          <DataTable
            className="cases-table"
            columns={columns}
            data={result.cases}
            virtual={{ rowHeight: DATA_ROW_HEIGHT }}
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
                    onClick={() => setFilters(NO_CASE_FILTERS)}
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
      )}

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

      <div className="pager-size">
        <DebouncedFilter
          label="Rows per page"
          type="number"
          min={1}
          max={CASE_PAGE_SIZE_MAX}
          value={String(search.pageSize)}
          // Clamped here, not left to the search schema: an out-of-range number fails validateSearch
          // in the loader, and typing 500 in a filter box replaced the ledger with an error card.
          onCommit={(next) => setFilters({ pageSize: pageSizeOf(next) })}
        />
      </div>
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

/**
 * No bar. It was 6px of gradient scaled to the top score on the current page, so page two's bars
 * were drawn against page two's leader and meant something different from page one's — and no
 * guild-wide maximum is available to scale them against instead. The numbers are the answer.
 */
function leaderboardColumnsFor(directory: Directory) {
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
    levelColumn.accessor('userId', {
      id: 'userId',
      header: 'Member',
      cell: (c) => <UserChip id={c.getValue()} member={directory.of(c.getValue())} />,
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

  const ids = useMemo(() => result.entries.map((entry) => entry.userId), [result.entries]);
  const directory = useMembers(ids);

  const leaderboardColumns = useMemo(() => leaderboardColumnsFor(directory), [directory]);

  return (
    <div className="panel-wide">
      <MemberNotice directory={directory} />

      <div className="table-card">
        <DataTable
          className="table leaderboard-table"
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

function tagColumnsFor(directory: Directory) {
  return tagColumn.columns([
    tagColumn.accessor('name', {
      id: 'name',
      header: 'Tag',
      cell: (c) => <span className="tag-name">/{c.getValue()}</span>,
    }),
    // The body, not an 80-character stub of it. A tag is the thing it posts, and the list existed
    // to answer "what does this one say" — which an ellipsis at column three cannot.
    tagColumn.accessor('content', {
      id: 'content',
      header: 'What it posts',
      cell: (c) => (
        <span className="tag-body" title={c.getValue()}>
          {c.getValue()}
        </span>
      ),
    }),
    tagColumn.accessor('uses', {
      id: 'uses',
      header: 'Used',
      cell: (c) => <span className="num mono">{c.getValue().toLocaleString()}</span>,
    }),
    tagColumn.accessor('createdBy', {
      id: 'createdBy',
      header: 'Written by',
      cell: (c) => <UserChip id={c.getValue()} member={directory.of(c.getValue())} />,
    }),
    tagColumn.accessor('updatedAt', {
      id: 'updatedAt',
      header: 'Changed',
      cell: (c) => <Stamp iso={c.getValue()} />,
    }),
  ]);
}

export function TagBrowserView({ search, data: result, onSearch }: TagBrowserProps): ReactElement {
  const lastPage = lastPageOf(result.total, result.pageSize);

  const ids = useMemo(
    () => result.tags.flatMap((tag) => [tag.createdBy, tag.updatedBy]),
    [result.tags],
  );
  const directory = useMembers(ids);
  const tagColumns = useMemo(() => tagColumnsFor(directory), [directory]);

  return (
    <div className="panel-wide">
      <FilterBar
        applied={countSet([search.search])}
        onClear={() => onSearch({ search: undefined, page: 1 })}
      >
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
      </FilterBar>

      <MemberNotice directory={directory} />

      <div className="table-card">
        <DataTable
          className="table tags-table"
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

function ticketColumnsFor(selected: string | null, onSelect: (id: string) => void) {
  return ticketColumn.columns([
    ticketColumn.accessor('number', {
      id: 'number',
      header: 'Ticket',
      // The row's own way in. A queue whose rows open nothing is a report about tickets rather than
      // a queue, which is what nine read-only columns made this.
      cell: (c) => (
        <button
          type="button"
          className="row-open"
          aria-pressed={c.row.original.id === selected}
          onClick={() => onSelect(c.row.original.id)}
        >
          #{c.getValue()}
        </button>
      ),
    }),
    ticketColumn.accessor('subject', {
      id: 'subject',
      header: 'Subject',
      cell: (c) => {
        const subject = c.getValue();
        if (!subject) return '—';

        return <span title={subject}>{subject}</span>;
      },
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
    ticketColumn.accessor('openedAt', {
      id: 'openedAt',
      header: 'Opened',
      cell: (c) => <Stamp iso={c.getValue()} />,
    }),
    ticketColumn.accessor('closedAt', {
      id: 'closedAt',
      header: 'Closed',
      cell: (c) => {
        const at = c.getValue();
        return at ? <Stamp iso={at} /> : '—';
      },
    }),
  ]);
}

const TICKET_SORTABLE: Record<string, TicketSortField> = {
  number: 'number',
  openedAt: 'openedAt',
  closedAt: 'closedAt',
};

const NO_TICKET_FILTERS: Partial<TicketQueryInput> = {
  search: undefined,
  status: undefined,
  priority: undefined,
  typeId: undefined,
  ownerId: undefined,
};

function TicketPane({
  ticket,
  directory,
}: {
  ticket: TicketSummary | undefined;
  directory: Directory;
}): ReactElement {
  const guildId = openGuildId();

  if (!ticket) {
    return (
      <div className="surface ticket-pane">
        <div className="empty-state">
          <span className="tile">
            <Icon name="ticket" />
          </span>
          <span className="empty-state-title">Pick a ticket to read it.</span>
          <p className="status">
            Everything Proton recorded about a ticket is here — who opened it, who took it, and what
            closed it.
          </p>
        </div>
      </div>
    );
  }

  return (
    <section className="surface ticket-pane" aria-labelledby="ticket-pane-head">
      <div className="ticket-pane-head">
        <span className="ticket-pane-number">#{ticket.number}</span>
        <h3 className="ticket-pane-title" id="ticket-pane-head">
          {ticket.subject ?? 'No subject'}
        </h3>
        <span className={statusChip(ticket.status)}>{ticket.status}</span>
        <span className={ticket.priority === 'urgent' ? 'chip chip-warn' : 'chip'}>
          {PRIORITY_LABELS[ticket.priority]}
        </span>
      </div>

      <dl className="ticket-facts">
        <div>
          <dt>Opened by</dt>
          <dd>
            <UserChip id={ticket.openerId} member={directory.of(ticket.openerId)} as="opener" />
          </dd>
        </div>
        <div>
          <dt>Owner</dt>
          <dd>
            <UserChip id={ticket.ownerId} member={directory.of(ticket.ownerId)} as="owner" />
          </dd>
        </div>
        <div>
          <dt>Claimed by</dt>
          <dd>
            {ticket.claimedById ? (
              <UserChip
                id={ticket.claimedById}
                member={directory.of(ticket.claimedById)}
                as="claimer"
              />
            ) : (
              'Nobody yet'
            )}
          </dd>
        </div>
        <div>
          <dt>Assigned to</dt>
          <dd>
            {ticket.assignedToId ? (
              <UserChip
                id={ticket.assignedToId}
                member={directory.of(ticket.assignedToId)}
                as="assignee"
              />
            ) : (
              'Nobody'
            )}
          </dd>
        </div>
        <div>
          <dt>Type</dt>
          <dd className="mono">{ticket.typeId}</dd>
        </div>
        <div>
          <dt>Panel</dt>
          <dd className="mono">{ticket.panelId}</dd>
        </div>
        <div>
          <dt>Messages</dt>
          <dd className="num mono">{ticket.messageCount.toLocaleString()}</dd>
        </div>
        <div>
          <dt>Opened</dt>
          <dd>
            <Stamp iso={ticket.openedAt} />
          </dd>
        </div>
        <div>
          <dt>Last activity</dt>
          <dd>
            <Stamp iso={ticket.lastActivityAt} />
          </dd>
        </div>
        {ticket.closedAt ? (
          <div>
            <dt>Closed</dt>
            <dd>
              <Stamp iso={ticket.closedAt} />
            </dd>
          </div>
        ) : null}
        {ticket.closedBy ? (
          <div>
            <dt>Closed by</dt>
            <dd>
              <UserChip id={ticket.closedBy} member={directory.of(ticket.closedBy)} as="closer" />
            </dd>
          </div>
        ) : null}
        {ticket.closeReason ? (
          <div className="ticket-facts-wide">
            <dt>Close reason</dt>
            <dd>{ticket.closeReason}</dd>
          </div>
        ) : null}
      </dl>

      <div className="ticket-pane-actions">
        {guildId === null ? null : (
          <a
            className="button button-quiet"
            href={`https://discord.com/channels/${guildId}/${ticket.channelId}`}
            target="_blank"
            rel="noreferrer"
          >
            <Icon name="hash" />
            Open the ticket channel
          </a>
        )}
        {ticket.transcriptUrl ? (
          <a
            className="button button-quiet"
            href={ticket.transcriptUrl}
            target="_blank"
            rel="noreferrer"
          >
            <Icon name="chat-teardrop-text" />
            Read the transcript
          </a>
        ) : null}
      </div>

      <p className="field-description">
        Claiming, replying and closing happen in the ticket’s own channel. Proton’s API has no route
        for any of them, so this pane reads tickets and does not change them.
      </p>
    </section>
  );
}

export function TicketBrowserView({
  search,
  data: result,
  onSearch,
}: TicketBrowserProps): ReactElement {
  const [picked, setPicked] = useState<string | null>(null);

  function setFilters(patch: Partial<TicketQueryInput>): void {
    onSearch({ ...patch, page: patch.page ?? 1 });
  }

  const lastPage = lastPageOf(result.total, result.pageSize);

  const applied = countSet([
    search.search,
    search.status,
    search.priority,
    search.typeId,
    search.ownerId,
  ]);

  const ids = useMemo(
    () =>
      result.tickets.flatMap((ticket) => [
        ticket.openerId,
        ticket.ownerId,
        ticket.claimedById,
        ticket.assignedToId,
        ticket.closedBy,
      ]),
    [result.tickets],
  );
  const directory = useMembers(ids);

  // The first row, until somebody picks another: a pane that opens empty beside a full list is one
  // more click before the queue says anything. A page change drops a pick that is no longer here.
  const shown =
    result.tickets.find((ticket) => ticket.id === picked) ?? result.tickets[0] ?? undefined;

  const selected = shown?.id ?? null;
  const columns = useMemo(() => ticketColumnsFor(selected, setPicked), [selected]);

  return (
    <div className="panel-wide">
      <FilterBar
        applied={applied}
        onClear={() => setFilters(NO_TICKET_FILTERS)}
        more={{
          applied: countSet([search.typeId]),
          children: (
            <IdFilter
              label="Type"
              inputMode="text"
              value={search.typeId}
              onCommit={(typeId) => setFilters({ typeId })}
            />
          ),
        }}
      >
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
      </FilterBar>

      <MemberNotice directory={directory} />

      <div className="queue">
        <div className="queue-list">
          <div className="table-card">
            <DataTable
              className="table queue-table"
              columns={columns}
              data={result.tickets}
              rowAttributes={(row) => ({
                'data-ticket-number': row.number,
                ...(row.id === shown?.id ? { 'data-selected': 'true' } : {}),
              })}
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
                ) : applied > 0 ? (
                  <div className="empty-state">
                    <span className="tile">
                      <Icon name="funnel-x" />
                    </span>
                    <span className="empty-state-title">No ticket matches these filters.</span>
                    <p className="status">
                      Every ticket this server has opened is kept, the closed and deleted ones
                      included, so an empty list here means nothing matched.
                    </p>
                    <button
                      type="button"
                      className="button button-quiet"
                      onClick={() => setFilters(NO_TICKET_FILTERS)}
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
                      Tickets appear here once the module is switched on and a member opens one from
                      a panel.
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

        <TicketPane ticket={shown} directory={directory} />
      </div>
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

function LiftCell({
  row,
  member,
}: {
  row: BlockedMember;
  member: ChipMember | null;
}): ReactElement {
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
        data-busy={lift.isPending || undefined}
      >
        Lift
      </button>

      {/* The only mutation in the product that used to fail in silence: the row stayed blocked, the
          button came back, and a moderator could not tell a refusal from a slow network. */}
      {lift.error ? (
        <span className="save-bar-failed" role="alert" title={failureDetail(lift.error)}>
          <Icon name="warning-circle" weight="fill" />
          {saveFailure(lift.error, 'Could not lift this block')}
        </span>
      ) : null}

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
          {member ? `${member.displayName} (${row.userId})` : row.userId} will be able to verify in
          this server again. This does not unban them — if they were also banned, that is a separate
          lift in Discord.
        </ConfirmDialog>
      ) : null}
    </>
  );
}

function blockedColumnsFor(directory: Directory) {
  return blockedColumn.columns([
    blockedColumn.accessor('userId', {
      id: 'userId',
      header: 'Member',
      cell: (c) => <UserChip id={c.getValue()} member={directory.of(c.getValue())} />,
    }),
    blockedColumn.accessor('reason', {
      id: 'reason',
      header: 'Why',
      cell: (c) => {
        const reason = c.getValue();
        return (
          <span className="blocklist-reason" title={reason}>
            {reason}
          </span>
        );
      },
    }),
    blockedColumn.accessor('moduleId', { id: 'moduleId', header: 'Added by' }),
    blockedColumn.accessor('createdAt', {
      id: 'createdAt',
      header: 'When',
      cell: (c) => <Stamp iso={c.getValue()} />,
    }),
    blockedColumn.display({
      id: 'actions',
      header: '',
      cell: (c) => <LiftCell row={c.row.original} member={directory.of(c.row.original.userId)} />,
    }),
  ]);
}

export function BlockedMembersView({
  search,
  data: result,
  onSearch,
}: BlockedMembersProps): ReactElement {
  const lastPage = lastPageOf(result.total, search.pageSize);

  const ids = useMemo(() => result.rows.map((row) => row.userId), [result.rows]);
  const directory = useMembers(ids);
  const blockedColumns = useMemo(() => blockedColumnsFor(directory), [directory]);

  return (
    <div className="panel-wide">
      <FilterBar
        applied={countSet([search.userId, search.moduleId])}
        onClear={() => onSearch({ userId: undefined, moduleId: undefined, page: 1 })}
      >
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
      </FilterBar>

      <MemberNotice directory={directory} />

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
