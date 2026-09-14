import type { QueryClient } from '@tanstack/react-query';
import { moduleSearchSchema } from '../../components/module/route.tsx';
import { caseLinkFilter, casesQuery, DEFAULT_PAGE_SIZE } from '../../pages/cases/queries.ts';
import { leaderboardQuery } from '../../pages/leveling/queries.ts';
import { blockedFilter, blockedQuery } from '../../pages/moderation/queries.ts';
import {
  libraryFilter,
  TAG_SEARCH_MAX,
  tagCountQuery,
  tagsQuery,
} from '../../pages/tags/queries.ts';
import { QUEUE_FILTERS, queueQuery } from '../../pages/tickets/queries.ts';
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
    await queryClient.prefetchQuery(
      casesQuery(guildId, {
        ...caseLinkFilter(search),
        moderatorId: undefined,
        targetId: undefined,
        from: undefined,
        to: undefined,
        pageSize: DEFAULT_PAGE_SIZE,
      }),
    );
    return;
  }

  if (moduleId === 'moderation' && area === 'blocked') {
    await queryClient.prefetchQuery(blockedQuery(guildId, blockedFilter(search)));
    return;
  }

  if (moduleId === 'leveling' && area === 'leaderboard') {
    await queryClient.prefetchQuery(leaderboardQuery(guildId, search.page ?? 1));
  }
}
