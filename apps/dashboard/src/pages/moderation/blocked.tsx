import { BLOCK_REASON_MAX, type BlockedMember, type BlockedState } from '@proton/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { MemberCell, MemberProvider } from '../../components/discord/member.tsx';
import { ModuleLink, useModuleNavigate, useModuleSearch } from '../../components/module/route.tsx';
import { Button, SearchField, TextArea } from '../../components/ui/controls.tsx';
import { StatusBanner } from '../../components/ui/feedback.tsx';
import { Icon } from '../../components/ui/icon.tsx';
import { Pair, Pairs } from '../../components/ui/layout.tsx';
import { Dialog } from '../../components/ui/overlay.tsx';
import { type Column, DataTable, Pagination } from '../../components/ui/table.tsx';
import { SegmentedTabs } from '../../components/ui/tabs.tsx';
import { readFailure, saveFailure } from '../../lib/errors.ts';
import { liftBlockedMember } from '../../server/modules.ts';
import {
  BLOCKED_PAGE_SIZE,
  blockedFilter,
  blockedKey,
  blockedQuery,
  MEMBER_ID,
} from './queries.ts';

const STATE_TABS: readonly { id: BlockedState; label: string }[] = [
  { id: 'live', label: 'Active' },
  { id: 'lifted', label: 'Lifted' },
  { id: 'all', label: 'All' },
];

const LIFT_CONSEQUENCE =
  'The member can pass verification again. This does not remove a ban or timeout.';

const NOBODY_BLOCKED = 'Only Honeypot adds members to this list.';

function relative(iso: string, now: number): string {
  const seconds = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));

  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`;
  if (seconds < 31_536_000) return `${Math.floor(seconds / 86_400)}d ago`;

  return `${Math.floor(seconds / 31_536_000)}y ago`;
}

function When({ iso, now }: { iso: string; now: number }): ReactElement {
  return (
    <time dateTime={iso} title={new Date(iso).toLocaleString()}>
      {relative(iso, now)}
    </time>
  );
}

function evidenceUrl(guildId: string, evidence: { channelId: string; messageId: string }): string {
  return `https://discord.com/channels/${guildId}/${evidence.channelId}/${evidence.messageId}`;
}

function TermNote({ show }: { show: boolean }): ReactElement | null {
  if (!show) return null;

  return (
    <p className="moderation-field-note text-warning text-sm">
      A member ID is 17 to 20 digits. Nothing is filtered until it is.
    </p>
  );
}

function CaseLink({ guildId, caseId }: { guildId: string; caseId: string }): ReactElement {
  return (
    <ModuleLink
      className="moderation-link mono text-xs"
      guildId={guildId}
      moduleId={'cases'}
      search={{ area: 'log', q: caseId }}
      onClick={(event) => event.stopPropagation()}
    >
      {caseId}
    </ModuleLink>
  );
}

export function BlockedArea({
  guildId,
  moduleId,
}: {
  guildId: string;
  moduleId: string;
}): ReactElement {
  const search = useModuleSearch();
  const go = useModuleNavigate(guildId, moduleId);

  const filter = blockedFilter(search);
  const { state, order, page, userId } = filter;
  const term = search.q ?? '';

  const [draft, setDraft] = useState(term);
  const badTerm = draft.trim() !== '' && !MEMBER_ID.test(draft.trim());

  useEffect(() => setDraft(term), [term]);

  useEffect(() => {
    const next = draft.trim();
    if (next === term || (next !== '' && !MEMBER_ID.test(next))) return;

    const timer = window.setTimeout(
      () => go({ q: next === '' ? undefined : next, page: undefined }),
      250,
    );
    return () => window.clearTimeout(timer);
  }, [draft, term, go]);

  const query = useQuery(blockedQuery(guildId, filter));

  const rows = query.data?.rows ?? [];
  const total = query.data?.total ?? 0;
  const now = Date.now();

  const memberIds = useMemo(() => {
    const ids = new Set<string>();
    for (const row of rows) {
      ids.add(row.userId);
      if (row.liftedBy !== null && MEMBER_ID.test(row.liftedBy)) ids.add(row.liftedBy);
    }
    return [...ids];
  }, [rows]);

  const selected = rows.find((row) => row.id === search.id);
  const [lifting, setLifting] = useState<BlockedMember | null>(null);

  const columns: Column<BlockedMember>[] = [
    {
      id: 'member',
      header: 'Member',
      primary: true,
      width: 200,
      cell: (row) => <MemberCell userId={row.userId} />,
    },
    {
      id: 'reason',
      header: 'Reason',
      cell: (row) => (
        <span className="moderation-reason" title={row.reason}>
          {row.reason}
        </span>
      ),
    },
    {
      id: 'blockedBy',
      header: 'Blocked by',
      width: 148,
      cell: (row) => (
        <span className="mono text-xs" title={`Added by ${row.moduleId}`}>
          {row.blockedBy}
        </span>
      ),
    },
    {
      id: 'case',
      header: 'Case',
      width: 104,
      cell: (row) =>
        row.caseId === null ? (
          <span className="text-muted">—</span>
        ) : (
          <CaseLink guildId={guildId} caseId={row.caseId} />
        ),
    },
    {
      id: 'evidence',
      header: 'Evidence',
      width: 96,
      cell: (row) =>
        row.evidence === null ? (
          <span className="text-muted">—</span>
        ) : (
          <a
            className="moderation-link text-xs"
            href={evidenceUrl(guildId, row.evidence)}
            target="_blank"
            rel="noreferrer"
            onClick={(event) => event.stopPropagation()}
          >
            Message
            <Icon name="arrow-square-out" size={12} />
          </a>
        ),
    },
    {
      id: 'createdAt',
      header: 'Blocked',
      sortField: 'createdAt',
      width: 116,
      cell: (row) => <When iso={row.createdAt} now={now} />,
    },
  ];

  if (state !== 'live') {
    columns.push({
      id: 'liftedAt',
      header: 'Lifted',
      width: 116,
      cell: (row) =>
        row.liftedAt === null ? (
          <span className="text-muted">—</span>
        ) : (
          <When iso={row.liftedAt} now={now} />
        ),
    });
  }

  columns.push({
    id: 'actions',
    header: '',
    width: 88,
    align: 'right',
    cell: (row) =>
      row.liftedAt === null ? (
        <Button
          size="sm"
          onClick={(event) => {
            event.stopPropagation();
            setLifting(row);
          }}
        >
          Lift
        </Button>
      ) : null,
  });

  const empty =
    userId !== undefined
      ? { icon: 'magnifying-glass' as const, title: 'No matching blocked members' }
      : state === 'lifted'
        ? { icon: 'prohibit' as const, title: 'No lifted blocks' }
        : {
            icon: 'prohibit' as const,
            title: 'No blocked members',
            body: NOBODY_BLOCKED,
          };

  return (
    <MemberProvider guildId={guildId} userIds={memberIds}>
      <div className="table-toolbar">
        <SegmentedTabs
          label="Block status"
          items={STATE_TABS}
          value={state}
          onChange={(next) => go({ status: next, page: undefined, id: undefined })}
        />
        <SearchField
          value={draft}
          onChange={setDraft}
          label="Search blocked members"
          placeholder="Member ID…"
        />
      </div>

      <TermNote show={badTerm} />

      {query.isError ? (
        <StatusBanner tone="danger" live="polite">
          {readFailure(query.error, 'this server’s blocked members')}
        </StatusBanner>
      ) : (
        <DataTable
          columns={columns}
          rows={rows}
          rowKey={(row) => row.id}
          loading={query.isPending}
          loadingLabel="Loading blocked members"
          onRowClick={(row) => go({ id: row.id })}
          sort={{ field: 'createdAt', direction: order }}
          onSortChange={(next) => go({ dir: next.direction, page: undefined })}
          empty={empty}
          footer={
            <Pagination
              page={page}
              pageSize={BLOCKED_PAGE_SIZE}
              total={total}
              noun={state === 'live' ? 'blocked members' : 'blocks'}
              onPageChange={(next) => go({ page: next })}
            />
          }
        />
      )}

      <DetailDialog
        guildId={guildId}
        row={selected}
        now={now}
        onClose={() => go({ id: undefined })}
        onLift={(row) => {
          go({ id: undefined });
          setLifting(row);
        }}
      />

      <LiftDialog guildId={guildId} row={lifting} onClose={() => setLifting(null)} />
    </MemberProvider>
  );
}

function DetailDialog({
  guildId,
  row,
  now,
  onClose,
  onLift,
}: {
  guildId: string;
  row: BlockedMember | undefined;
  now: number;
  onClose: () => void;
  onLift: (row: BlockedMember) => void;
}): ReactElement | null {
  if (!row) return null;

  return (
    <Dialog
      open
      onClose={onClose}
      title="Blocked member"
      size="wide"
      footer={
        row.liftedAt === null ? (
          <Button tone="primary" onClick={() => onLift(row)}>
            Lift block
          </Button>
        ) : (
          <Button onClick={onClose}>Close</Button>
        )
      }
    >
      <Pairs>
        <Pair label="Member">
          <MemberCell userId={row.userId} />
        </Pair>
        <Pair label="Member ID">
          <span className="mono text-xs">{row.userId}</span>
        </Pair>
        <Pair label="Reason">
          <span className="moderation-wrap">{row.reason}</span>
        </Pair>
        <Pair label="Blocked by">
          <span className="mono text-xs">{row.blockedBy}</span>
        </Pair>
        <Pair label="Module">{row.moduleId}</Pair>
        <Pair label="Blocked">
          <When iso={row.createdAt} now={now} />
        </Pair>
        <Pair label="Case">
          {row.caseId === null ? (
            <span className="text-muted">None</span>
          ) : (
            <CaseLink guildId={guildId} caseId={row.caseId} />
          )}
        </Pair>
        <Pair label="Evidence">
          {row.evidence === null ? (
            <span className="text-muted">None</span>
          ) : (
            <a
              className="moderation-link text-sm"
              href={evidenceUrl(guildId, row.evidence)}
              target="_blank"
              rel="noreferrer"
            >
              Open message
              <Icon name="arrow-square-out" size={12} />
            </a>
          )}
        </Pair>

        {row.liftedAt !== null ? (
          <>
            <Pair label="Lifted">
              <When iso={row.liftedAt} now={now} />
            </Pair>
            <Pair label="Lifted by">
              {row.liftedBy === null ? (
                <span className="text-muted">—</span>
              ) : MEMBER_ID.test(row.liftedBy) ? (
                <MemberCell userId={row.liftedBy} />
              ) : (
                <span className="mono text-xs">{row.liftedBy}</span>
              )}
            </Pair>
            <Pair label="Lift reason">
              <span className="moderation-wrap">{row.liftReason ?? '—'}</span>
            </Pair>
          </>
        ) : null}
      </Pairs>
    </Dialog>
  );
}

function LiftDialog({
  guildId,
  row,
  onClose,
}: {
  guildId: string;
  row: BlockedMember | null;
  onClose: () => void;
}): ReactElement | null {
  const queryClient = useQueryClient();
  const [reason, setReason] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const close = useCallback(() => {
    setReason('');
    setSubmitted(false);
    setFailure(null);
    onClose();
  }, [onClose]);

  const lift = useMutation({
    mutationFn: (input: { userId: string; liftReason: string }) =>
      liftBlockedMember({ data: { guildId, ...input } }),

    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: blockedKey(guildId) });
      close();
    },

    onError: (error: Error) => setFailure(saveFailure(error, 'The block was not lifted')),
  });

  if (!row) return null;

  const trimmed = reason.trim();
  const error =
    submitted && trimmed === ''
      ? 'A reason is required. It is saved with the block.'
      : trimmed.length > BLOCK_REASON_MAX
        ? `A reason can be at most ${BLOCK_REASON_MAX} characters.`
        : undefined;

  const submit = (): void => {
    setSubmitted(true);
    if (trimmed === '' || trimmed.length > BLOCK_REASON_MAX) return;

    setFailure(null);
    lift.mutate({ userId: row.userId, liftReason: trimmed });
  };

  return (
    <Dialog
      open
      onClose={close}
      title="Lift block?"
      description={LIFT_CONSEQUENCE}
      footerNote={`${trimmed.length} / ${BLOCK_REASON_MAX}`}
      footer={
        <>
          <Button onClick={close} disabled={lift.isPending}>
            Cancel
          </Button>
          <Button tone="primary" busy={lift.isPending} onClick={submit}>
            Lift
          </Button>
        </>
      }
    >
      <div className="stack stack-12">
        {failure !== null ? (
          <StatusBanner tone="danger" live="assertive">
            {failure}
          </StatusBanner>
        ) : null}

        <div className="field">
          <span className="field-label">Member</span>
          <MemberCell userId={row.userId} />
        </div>

        <div className="field">
          <label className="field-label" htmlFor="lift-reason">
            Reason
          </label>
          <TextArea
            id="lift-reason"
            rows={3}
            value={reason}
            maxLength={BLOCK_REASON_MAX}
            invalid={error !== undefined}
            onChange={(event) => setReason(event.currentTarget.value)}
          />
          {error !== undefined ? (
            <span className="field-error">{error}</span>
          ) : (
            <span className="field-hint">
              Kept with the block and shown to anyone who can see this list.
            </span>
          )}
        </div>
      </div>
    </Dialog>
  );
}
