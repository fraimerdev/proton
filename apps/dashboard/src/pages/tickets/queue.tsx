import { parseComponentEmoji, TICKET_PRIORITIES, type TicketPriority } from '@proton/core';
import {
  PRIORITY_LABELS,
  TICKET_STATUSES,
  type TicketStatusName,
  typeFor,
} from '@proton/module-tickets/config';
import {
  TICKET_SORT_FIELDS,
  type TicketSortField,
  type TicketSummary,
} from '@proton/module-tickets/query';
import { useQuery } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { EmojiGlyph } from '../../components/discord/emoji-picker.tsx';
import { MemberCell, MemberProvider } from '../../components/discord/member.tsx';
import { Badge, Button, Chip, SearchField, Select } from '../../components/ui/controls.tsx';
import { EmptyState, StatusBanner } from '../../components/ui/feedback.tsx';
import { Icon } from '../../components/ui/icon.tsx';
import { Pair, Pairs } from '../../components/ui/layout.tsx';
import { Dialog, MenuButton } from '../../components/ui/overlay.tsx';
import { type Column, DataTable, Pagination } from '../../components/ui/table.tsx';
import { readFailure } from '../../lib/errors.ts';
import { useTicketNav, useTicketSearch } from './nav.ts';
import { QUEUE_FILTERS, queueQuery, sortOf, statusOf } from './queries.ts';
import { priorityHex, STATUS_LABELS, type TicketsForm } from './shape.ts';

const PAGE_SIZES = [25, 50, 100] as const;

const SEARCH_HELP =
  'Search looks at the subject, which is the first answer to the ticket’s questions. Tickets with ' +
  'no answers have no subject and never match.';

const NO_TYPES = 'Create a ticket type so members can open tickets.';

const READ_ONLY =
  'Form answers, participants and messages are not shown here. Find them in the ticket channel or ' +
  'its transcript.';

const SORT_LABELS: Record<TicketSortField, string> = {
  number: 'Number',
  openedAt: 'Opened',
  closedAt: 'Closed',
};

const STATUS_TONE: Record<TicketStatusName, 'neutral' | 'info' | 'danger'> = {
  open: 'info',
  closed: 'neutral',
  archived: 'neutral',
  deleted: 'danger',
};

const unsubscribed = (): (() => void) => () => undefined;

function relative(iso: string, now: number): string {
  const seconds = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));

  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`;
  if (seconds < 31_536_000) return `${Math.floor(seconds / 86_400)}d ago`;

  return `${Math.floor(seconds / 31_536_000)}y ago`;
}

function When({ iso, now }: { iso: string | null; now: number }): ReactElement {
  // The server renders in its own time zone; the viewer's is only known once hydrated.
  const title = useSyncExternalStore(
    unsubscribed,
    () => (iso === null ? undefined : new Date(iso).toLocaleString()),
    () => undefined,
  );

  if (iso === null) return <span className="text-muted">—</span>;

  return (
    <time dateTime={iso} title={title} suppressHydrationWarning>
      {relative(iso, now)}
    </time>
  );
}

export function QueueArea({
  form,
  guildId,
  moduleId,
}: {
  form: TicketsForm;
  guildId: string;
  moduleId: string;
}): ReactElement {
  const config = form.value;
  const search = useTicketSearch();
  const go = useTicketNav(guildId, moduleId);

  const [priority, setPriority] = useState<TicketPriority | ''>(QUEUE_FILTERS.priority);
  const [typeId, setTypeId] = useState(QUEUE_FILTERS.typeId);
  const [ownerId, setOwnerId] = useState<string | undefined>(QUEUE_FILTERS.ownerId);
  const [pageSize, setPageSize] = useState<number>(QUEUE_FILTERS.pageSize);
  const [draft, setDraft] = useState(search.q ?? '');

  const term = search.q ?? '';
  const status = statusOf(search.status);
  const sort = sortOf(search.sort);
  const direction = search.dir === 'asc' ? 'asc' : 'desc';
  const page = search.page ?? 1;

  useEffect(() => setDraft(term), [term]);

  useEffect(() => {
    const next = draft.trim();
    if (next === term) return;

    const timer = window.setTimeout(
      () => go({ q: next === '' ? undefined : next, page: undefined }),
      250,
    );
    return () => window.clearTimeout(timer);
  }, [draft, term, go]);

  const query = useQuery(queueQuery(guildId, search, { priority, typeId, ownerId, pageSize }));

  const rows = query.data?.tickets ?? [];
  const total = query.data?.total ?? 0;
  const now = Date.now();

  const memberIds = useMemo(() => {
    const ids = new Set<string>();

    if (ownerId !== undefined) ids.add(ownerId);

    for (const row of rows) {
      ids.add(row.ownerId);
      ids.add(row.openerId);
      if (row.claimedById !== null) ids.add(row.claimedById);
      if (row.assignedToId !== null) ids.add(row.assignedToId);
      if (row.closedBy !== null) ids.add(row.closedBy);
    }

    return [...ids];
  }, [rows, ownerId]);

  const selected = rows.find((row) => row.id === search.id);

  const filtered =
    term !== '' ||
    status !== undefined ||
    priority !== '' ||
    typeId !== '' ||
    ownerId !== undefined;

  const clearFilters = (): void => {
    setPriority('');
    setTypeId('');
    setOwnerId(undefined);
    go({ q: undefined, status: undefined, page: undefined });
  };

  const columns: Column<TicketSummary>[] = [
    {
      id: 'number',
      header: '#',
      sortField: 'number',
      width: 76,
      cell: (row) => <span className="mono">#{row.number}</span>,
    },
    {
      id: 'subject',
      header: 'Subject',
      primary: true,
      cell: (row) =>
        row.subject === null ? (
          <span className="text-muted">—</span>
        ) : (
          <span className="truncate" title={row.subject}>
            {row.subject}
          </span>
        ),
    },
    {
      id: 'type',
      header: 'Type',
      width: 168,
      cell: (row) => {
        const type = typeFor(config, row.typeId);
        if (type === undefined) return <span className="mono text-muted">{row.typeId}</span>;

        const emoji = parseComponentEmoji(type.emoji);

        return (
          <span className="inline inline-6 truncate">
            {emoji ? <EmojiGlyph emoji={emoji} size={15} /> : null}
            <span className="truncate">{type.name}</span>
          </span>
        );
      },
    },
    {
      id: 'status',
      header: 'Status',
      width: 104,
      cell: (row) => <Badge tone={STATUS_TONE[row.status]}>{STATUS_LABELS[row.status]}</Badge>,
    },
    {
      id: 'priority',
      header: 'Priority',
      width: 104,
      cell: (row) => (
        <Chip colour={priorityHex(row.priority)}>{PRIORITY_LABELS[row.priority]}</Chip>
      ),
    },
    {
      id: 'owner',
      header: 'Owner',
      width: 176,
      cell: (row) => (
        <span className="inline inline-6">
          <MemberCell userId={row.ownerId} />
          {row.openerId !== row.ownerId ? (
            <Icon
              name="user-plus"
              size={13}
              className="text-muted"
              label="Transferred from the member who raised it"
            />
          ) : null}
        </span>
      ),
    },
    {
      id: 'claimed',
      header: 'Claimed by',
      width: 176,
      cell: (row) => <MemberCell userId={row.claimedById} fallback="—" />,
    },
    {
      id: 'messages',
      header: 'Messages',
      align: 'right',
      width: 96,
      cell: (row) => row.messageCount,
    },
    {
      id: 'openedAt',
      header: 'Opened',
      sortField: 'openedAt',
      width: 112,
      cell: (row) => <When iso={row.openedAt} now={now} />,
    },
    {
      id: 'closedAt',
      header: 'Closed',
      sortField: 'closedAt',
      width: 112,
      cell: (row) => <When iso={row.closedAt} now={now} />,
    },
    {
      id: 'actions',
      header: '',
      width: 56,
      align: 'right',
      cell: (row) => (
        <MenuButton
          label={`Actions for ticket #${row.number}`}
          actions={[
            {
              id: 'discord',
              label: 'Open in Discord',
              icon: 'arrow-square-out',
              onSelect: () =>
                window.open(
                  `https://discord.com/channels/${guildId}/${row.channelId}`,
                  '_blank',
                  'noreferrer',
                ),
            },
            ...(row.transcriptUrl === null
              ? []
              : [
                  {
                    id: 'transcript',
                    label: 'Open transcript',
                    icon: 'scroll' as const,
                    onSelect: () => window.open(row.transcriptUrl ?? '', '_blank', 'noreferrer'),
                  },
                ]),
            {
              id: 'filter-type',
              label: 'Filter to this ticket type',
              icon: 'ticket',
              onSelect: () => {
                setTypeId(row.typeId);
                go({ page: undefined });
              },
            },
            {
              id: 'filter-member',
              label: 'Filter to this owner',
              icon: 'users-three',
              onSelect: () => {
                setOwnerId(row.ownerId);
                go({ page: undefined });
              },
            },
          ]}
        />
      ),
    },
  ];

  // Filtered emptiness gets its own state below, because that one carries a Clear filters action
  // and DataTable's built-in empty takes no actions.
  const empty = filtered
    ? undefined
    : config.types.length === 0
      ? { icon: 'ticket' as const, title: 'No tickets', body: NO_TYPES }
      : { icon: 'ticket' as const, title: 'No tickets' };

  return (
    <MemberProvider guildId={guildId} userIds={memberIds}>
      <div className="table-toolbar tickets-toolbar">
        <SearchField
          value={draft}
          onChange={setDraft}
          label="Search ticket subjects"
          placeholder="Search subjects…"
        />

        <Select
          width="sm"
          aria-label="Status"
          value={search.status ?? ''}
          options={[
            { value: '', label: 'Any status' },
            ...TICKET_STATUSES.map((name) => ({ value: name, label: STATUS_LABELS[name] })),
          ]}
          onChange={(event) =>
            go({
              status: event.currentTarget.value === '' ? undefined : event.currentTarget.value,
              page: undefined,
            })
          }
        />

        <Select
          width="sm"
          aria-label="Priority"
          value={priority}
          options={[
            { value: '', label: 'Any priority' },
            ...TICKET_PRIORITIES.map((name) => ({ value: name, label: PRIORITY_LABELS[name] })),
          ]}
          onChange={(event) => {
            setPriority(event.currentTarget.value as TicketPriority | '');
            go({ page: undefined });
          }}
        />

        <Select
          width="md"
          aria-label="Ticket type"
          value={typeId}
          options={[
            { value: '', label: 'Any ticket type' },
            ...config.types.map((type) => ({ value: type.id, label: `${type.name} (${type.id})` })),
          ]}
          onChange={(event) => {
            setTypeId(event.currentTarget.value);
            go({ page: undefined });
          }}
        />

        <Select
          width="sm"
          aria-label="Sort by"
          value={sort}
          options={TICKET_SORT_FIELDS.map((field) => ({
            value: field,
            label: SORT_LABELS[field],
          }))}
          onChange={(event) => go({ sort: event.currentTarget.value, page: undefined })}
        />

        <Button
          size="sm"
          icon={direction === 'asc' ? 'sort-ascending' : 'sort-descending'}
          onClick={() => go({ dir: direction === 'asc' ? 'desc' : 'asc', page: undefined })}
        >
          {direction === 'asc' ? 'Oldest first' : 'Newest first'}
        </Button>

        <Select
          width="xs"
          aria-label="Tickets per page"
          value={String(pageSize)}
          options={PAGE_SIZES.map((size) => ({ value: String(size), label: `${size}` }))}
          onChange={(event) => {
            setPageSize(Number(event.currentTarget.value));
            go({ page: undefined });
          }}
        />
      </div>

      <p className="tickets-search-help">{SEARCH_HELP}</p>

      {ownerId !== undefined ? (
        <div className="tickets-filter-chips">
          <Chip onRemove={() => setOwnerId(undefined)} removeLabel="Clear owner filter">
            Owned by <MemberCell userId={ownerId} />
          </Chip>
        </div>
      ) : null}

      {query.isError ? (
        <StatusBanner tone="danger" live="polite">
          {readFailure(query.error, 'tickets')}
        </StatusBanner>
      ) : (
        <DataTable
          columns={columns}
          rows={rows}
          rowKey={(row) => row.id}
          loading={query.isPending}
          loadingLabel="Loading tickets"
          onRowClick={(row) => go({ id: row.id })}
          sort={{ field: sort, direction }}
          onSortChange={(next) => go({ sort: next.field, dir: next.direction, page: undefined })}
          empty={empty}
          footer={
            <Pagination
              page={page}
              pageSize={pageSize}
              total={total}
              noun="tickets"
              onPageChange={(next) => go({ page: next })}
            />
          }
        />
      )}

      {rows.length === 0 && filtered && !query.isPending && !query.isError ? (
        <EmptyState
          icon="magnifying-glass"
          title="No tickets match these filters"
          inset
          actions={
            <Button size="sm" onClick={clearFilters}>
              Clear filters
            </Button>
          }
        />
      ) : null}

      <TicketDetail
        guildId={guildId}
        ticket={selected}
        config={config}
        now={now}
        onClose={() => go({ id: undefined })}
      />
    </MemberProvider>
  );
}

function TicketDetail({
  guildId,
  ticket,
  config,
  now,
  onClose,
}: {
  guildId: string;
  ticket: TicketSummary | undefined;
  config: TicketsForm['value'];
  now: number;
  onClose: () => void;
}): ReactElement | null {
  if (!ticket) return null;

  const type = typeFor(config, ticket.typeId);

  return (
    <Dialog
      open
      onClose={onClose}
      size="wide"
      title={`Ticket #${ticket.number}`}
      description={ticket.subject ?? 'No subject.'}
      footer={
        <>
          <a
            className="button button-secondary"
            href={`https://discord.com/channels/${guildId}/${ticket.channelId}`}
            target="_blank"
            rel="noreferrer"
          >
            Open in Discord
          </a>
          {ticket.transcriptUrl !== null ? (
            <a
              className="button button-secondary"
              href={ticket.transcriptUrl}
              target="_blank"
              rel="noreferrer"
            >
              Open transcript
            </a>
          ) : null}
        </>
      }
      footerNote={READ_ONLY}
    >
      <Pairs>
        <Pair label="Status">{STATUS_LABELS[ticket.status]}</Pair>
        <Pair label="Priority">{PRIORITY_LABELS[ticket.priority]}</Pair>
        <Pair label="Type">{type?.name ?? <span className="mono">{ticket.typeId}</span>}</Pair>
        <Pair label="Panel">
          <span className="mono">{ticket.panelId === '' ? '—' : ticket.panelId}</span>
        </Pair>
        <Pair label="Owner">
          <MemberCell userId={ticket.ownerId} />
        </Pair>
        {ticket.openerId !== ticket.ownerId ? (
          <Pair label="Raised by">
            <MemberCell userId={ticket.openerId} />
          </Pair>
        ) : null}
        <Pair label="Claimed by">
          <MemberCell userId={ticket.claimedById} fallback="None" />
        </Pair>
        <Pair label="Assigned to">
          <MemberCell userId={ticket.assignedToId} fallback="None" />
        </Pair>
        <Pair label="Messages">{ticket.messageCount}</Pair>
        <Pair label="Opened">
          <When iso={ticket.openedAt} now={now} />
        </Pair>
        <Pair label="Last activity">
          <When iso={ticket.lastActivityAt} now={now} />
        </Pair>
        <Pair label="Closed">
          <When iso={ticket.closedAt} now={now} />
        </Pair>
        {ticket.closedBy !== null ? (
          <Pair label="Closed by">
            <MemberCell userId={ticket.closedBy} />
          </Pair>
        ) : null}
        {ticket.closeReason !== null ? (
          <Pair label="Close reason">{ticket.closeReason}</Pair>
        ) : null}
        <Pair label="Ticket ID">
          <span className="mono">{ticket.id}</span>
        </Pair>
      </Pairs>
    </Dialog>
  );
}
