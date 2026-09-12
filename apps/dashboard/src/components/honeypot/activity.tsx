import type { CaseRecord, CaseSearchResult } from '@proton/core';
import { useQuery } from '@tanstack/react-query';
import { type ReactElement, useMemo } from 'react';
import { isAccessError } from '../../lib/errors.ts';
import { LIVE, queryKeys, STALE } from '../../lib/query-keys.ts';
import { Icon } from '../shell/icon.tsx';
import { actionLook, toneClass } from '../shell/module-meta.ts';
import { UserChip } from '../shell/user-chip.tsx';
import { DataTable, dataColumnHelper } from '../table/data-table.tsx';

// The case log is the only record of a catch the dashboard can read, and it cannot be filtered by
// module — so one page of the most recent cases is read and honeypot's own are picked out of it.
const WINDOW = 200;

export interface HoneypotActivityProps {
  guildId: string;
  armed: number;
  waitSeconds: number;
}

function instant(iso: string): string {
  return iso.replace('T', ' ').slice(0, 16);
}

function CaughtAction({ kind }: { kind: string }): ReactElement {
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

const column = dataColumnHelper<CaseRecord>();

const columns = column.columns([
  column.accessor('caseNumber', {
    id: 'caseNumber',
    header: 'Case',
    cell: (c) => <span className="mono">#{c.getValue()}</span>,
  }),
  column.accessor('targetId', {
    id: 'targetId',
    header: 'Account',
    cell: (c) => {
      const id = c.getValue();
      return id ? <UserChip id={id} as="account" /> : '—';
    },
  }),
  column.accessor('type', {
    id: 'type',
    header: 'What Proton did',
    cell: (c) => <CaughtAction kind={c.getValue()} />,
  }),
  column.display({
    id: 'state',
    header: 'State',
    cell: ({ row }) => {
      if (row.original.revertedAt)
        return (
          <span className="catch-state" data-reverted="true">
            Reverted {instant(row.original.revertedAt)}
          </span>
        );
      if (row.original.expiresAt)
        return <span className="catch-state">Expires {instant(row.original.expiresAt)}</span>;

      return <span className="catch-state">Stands</span>;
    },
  }),
  column.accessor('createdAt', {
    id: 'createdAt',
    header: 'When (UTC)',
    cell: (c) => <span className="stamp">{instant(c.getValue())}</span>,
  }),
]);

/**
 * What the trap has actually caught. The number the notice's own button shows is counted in Proton's
 * trap store, which only the worker can reach, so this counts the catches in the window it read and
 * says so rather than printing a total it cannot check.
 */
export function HoneypotActivity({
  guildId,
  armed,
  waitSeconds,
}: HoneypotActivityProps): ReactElement {
  const query = useQuery({
    queryKey: queryKeys.view(guildId, 'honeypot-catches', { pageSize: WINDOW }),

    // Imported inside the function: server/modules.ts opens better-auth's database at module scope.
    queryFn: async (): Promise<CaseSearchResult> =>
      (await import('../../server/modules.ts')).searchCases({
        data: { guildId, pageSize: WINDOW },
      }),
    staleTime: STALE.browse,
    ...LIVE,
  });

  const caught = useMemo(
    () => (query.data?.cases ?? []).filter((record) => record.moduleId === 'honeypot'),
    [query.data],
  );

  const failure = query.error
    ? {
        message: isAccessError(query.error)
          ? 'Your Discord sign-in has expired, or your access to this server was revoked. Sign in ' +
            'again in another tab.'
          : query.error.message,
        onRetry: () => void query.refetch(),
      }
    : undefined;

  return (
    <div className="catch-feed">
      <div className="catch-tally">
        <span className="catch-tally-count">{query.isPending ? '—' : caught.length}</span>
        <span className="catch-tally-label">
          {caught.length === 1 ? 'catch' : 'catches'} recorded, from{' '}
          {armed === 1 ? '1 armed bait channel' : `${armed} armed bait channels`}
        </span>
      </div>

      <p className="field-description">
        Read from the case log: honeypot’s own cases out of the most recent {WINDOW} in this server.
        A case does not record which bait channel sprang, or whether the account appealed, so
        neither is here.
        {waitSeconds > 0
          ? ` Catches wait ${waitSeconds}s before Proton acts, and that queue is not readable from here.`
          : ''}
      </p>

      <div className="catch-table">
        <DataTable
          className="table"
          columns={columns}
          data={caught}
          loading={query.isPending}
          error={failure}
          empty={
            <p className="field-empty">
              {armed === 0
                ? 'Nothing is armed, so nothing has been caught. Arm a bait channel below.'
                : 'Nothing caught in that window. An armed trap that catches nobody is the normal state.'}
            </p>
          }
        />
      </div>
    </div>
  );
}
