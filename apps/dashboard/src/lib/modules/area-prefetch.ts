import type { QueryClient } from '@tanstack/react-query';
import { moduleSearchSchema } from '../../components/module/route.tsx';
import {
  achievementMemberQuery,
  achievementRewardsQuery,
  achievementUnlocksQuery,
  failedRewardsFilter,
  memberLookup,
  recentUnlocksFilter,
} from '../../pages/achievements/queries.ts';
import { CASE_LOCAL_DEFAULTS, caseFilter, casesQuery } from '../../pages/cases/queries.ts';
import { leaderboardQuery } from '../../pages/leveling/queries.ts';
import { blockedFilter, blockedQuery } from '../../pages/moderation/queries.ts';
import {
  reportFilter,
  reportQuery,
  reportSummaryQuery,
  reportsQuery,
} from '../../pages/moderation/reports/queries.ts';
import {
  libraryFilter,
  TAG_SEARCH_MAX,
  tagCountQuery,
  tagsQuery,
} from '../../pages/tags/queries.ts';
import { QUEUE_FILTERS, queueQuery } from '../../pages/tickets/queries.ts';
import { channelsQuery, rolesQuery } from '../queries.ts';
import { areaMeta, MODULE_BY_ID } from './catalogue.ts';

export async function prefetchArea(
  queryClient: QueryClient,
  guildId: string,
  moduleId: string,
  raw: unknown,
): Promise<void> {
  const meta = MODULE_BY_ID.get(moduleId);
  const parsed = moduleSearchSchema.safeParse(raw);
  if (!meta || !parsed.success) return;

  const search = parsed.data;
  const area = areaMeta(meta, search.area)?.id;

  if (moduleId === 'tickets' && area === 'queue') {
    await queryClient.prefetchQuery(queueQuery(guildId, search, QUEUE_FILTERS));
    return;
  }

  if (moduleId === 'tags' && area === 'library') {
    const tooLong = (search.q ?? '').trim().length > TAG_SEARCH_MAX;

    await Promise.all([
      queryClient.prefetchQuery(tagsQuery(guildId, libraryFilter(search, tooLong))),
      queryClient.prefetchQuery(tagCountQuery(guildId, true)),
    ]);
    return;
  }

  if (moduleId === 'cases' && area === 'log') {
    await queryClient.prefetchQuery(casesQuery(guildId, caseFilter(search, CASE_LOCAL_DEFAULTS)));
    return;
  }

  if (moduleId === 'moderation' && area === 'blocked') {
    await queryClient.prefetchQuery(blockedQuery(guildId, blockedFilter(search)));
    return;
  }

  if (moduleId === 'moderation' && area === 'reports-queue') {
    await Promise.all([
      queryClient.prefetchQuery(reportSummaryQuery(guildId)),
      ...(search.id === undefined
        ? [queryClient.prefetchQuery(reportsQuery(guildId, reportFilter(search)))]
        : [
            queryClient.prefetchQuery(reportQuery(guildId, search.id)),
            // Awaited, not left to warmGuildShape: the report detail prints these names during SSR.
            queryClient.prefetchQuery(channelsQuery(guildId)),
            queryClient.prefetchQuery(rolesQuery(guildId)),
          ]),
    ]);
    return;
  }

  if (moduleId === 'moderation' && area === 'reports') {
    await queryClient.prefetchQuery(reportSummaryQuery(guildId));
    return;
  }

  if (moduleId === 'leveling' && area === 'leaderboard') {
    await queryClient.prefetchQuery(leaderboardQuery(guildId, search.page ?? 1));
    return;
  }

  if (moduleId === 'achievements' && area === 'members') {
    const member = memberLookup(search);

    await Promise.all([
      queryClient.prefetchQuery(achievementRewardsQuery(guildId, failedRewardsFilter())),
      queryClient.prefetchQuery(achievementUnlocksQuery(guildId, recentUnlocksFilter(search))),
      ...(member === undefined
        ? []
        : [queryClient.prefetchQuery(achievementMemberQuery(guildId, member))]),
    ]);
  }
}
