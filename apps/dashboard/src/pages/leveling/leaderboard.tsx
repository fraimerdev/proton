import type { LeaderboardRow } from '@proton/core';
import { useQuery } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { MemberCell, MemberProvider } from '../../components/discord/member.tsx';
import { useModuleNavigate, useModuleSearch } from '../../components/module/route.tsx';
import { CollectionHeader } from '../../components/ui/collection.tsx';
import { StatusBanner } from '../../components/ui/feedback.tsx';
import { type Column, DataTable, Pagination } from '../../components/ui/table.tsx';
import { readFailure } from '../../lib/errors.ts';
import { LEADERBOARD_PAGE_SIZE, leaderboardQuery } from './queries.ts';

const NOBODY_YET = 'Members appear here once they earn XP.';

const DERIVED_LEVEL = 'Levels are worked out from current XP, so they are always up to date.';

// No sortField on any column and no onSortChange: the api orders xp DESC, userId and takes no
// sort parameter, so a header that looked sortable would silently do nothing.
const COLUMNS: readonly Column<LeaderboardRow>[] = [
  { id: 'rank', header: '#', align: 'right', width: 64, cell: (row) => row.rank },
  {
    id: 'member',
    header: 'Member',
    primary: true,
    cell: (row) => <MemberCell userId={row.userId} />,
  },
  { id: 'level', header: 'Level', align: 'right', width: 96, cell: (row) => row.level },
  {
    id: 'xp',
    header: 'XP',
    align: 'right',
    width: 128,
    cell: (row) => row.xp.toLocaleString('en-US'),
  },
];

export function LeaderboardArea({ guildId }: { guildId: string }): ReactElement {
  const search = useModuleSearch();
  const go = useModuleNavigate(guildId, 'leveling');

  const page = search.page ?? 1;
  const query = useQuery(leaderboardQuery(guildId, page));

  const entries = query.data?.entries ?? [];
  const total = query.data?.total ?? 0;

  return (
    <MemberProvider guildId={guildId} userIds={entries.map((entry) => entry.userId)}>
      {/* biome-ignore lint/complexity/noUselessFragments: MemberProvider takes one child, not a list that may hold nulls */}
      <>
        <CollectionHeader title="Leaderboard" />

        {query.isError ? (
          <StatusBanner tone="danger" live="polite">
            {readFailure(query.error, 'this server’s leaderboard')}
          </StatusBanner>
        ) : (
          <DataTable
            columns={COLUMNS}
            rows={entries}
            rowKey={(row) => row.userId}
            loading={query.isPending}
            loadingLabel="Loading leaderboard"
            empty={{ icon: 'trend-up', title: 'No members with XP', body: NOBODY_YET }}
            footer={
              <Pagination
                page={page}
                pageSize={LEADERBOARD_PAGE_SIZE}
                total={total}
                noun="members"
                onPageChange={(next) => {
                  go({ page: next });
                }}
              />
            }
          />
        )}

        <p className="leveling-note">{DERIVED_LEVEL}</p>
      </>
    </MemberProvider>
  );
}
