import { keepPreviousData, queryOptions } from '@tanstack/react-query';
import { LIVE, queryKeys, STALE } from '../../lib/query-keys.ts';
import { searchLeaderboard } from '../../server/modules.ts';

// 25 and not offered as a choice: getGuildMembers is one upstream Discord call per id, so a
// hundred-row page is a hundred REST calls to print one screen of names.
export const LEADERBOARD_PAGE_SIZE = 25;

export function leaderboardQuery(guildId: string, page: number) {
  return queryOptions({
    queryKey: [...queryKeys.guild(guildId), 'leaderboard', page] as const,
    queryFn: () => searchLeaderboard({ data: { guildId, page, pageSize: LEADERBOARD_PAGE_SIZE } }),
    staleTime: STALE.browse,
    // Paging blanks the table otherwise, under the admin who is mid-read of it.
    placeholderData: keepPreviousData,
    ...LIVE,
  });
}
