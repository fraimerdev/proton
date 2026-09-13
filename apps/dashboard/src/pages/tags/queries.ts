import {
  TAG_PAGE_SIZE_DEFAULT,
  TAG_SORT_FIELDS,
  type TagSortDirection,
  type TagSortField,
} from '@proton/module-tags/query';
import { keepPreviousData, queryOptions } from '@tanstack/react-query';
import type { ModuleSearch } from '../../components/module/route.tsx';
import { LIVE, queryKeys, STALE } from '../../lib/query-keys.ts';
import { searchTags } from '../../server/modules.ts';

export const TAG_SEARCH_MAX = 64;

export interface TagFilter {
  q: string | undefined;
  page: number;
  pageSize: number;
  sort: TagSortField;
  direction: TagSortDirection;
}

export function libraryFilter(search: ModuleSearch, tooLong: boolean): TagFilter {
  const term = search.q ?? '';
  const sort: TagSortField = TAG_SORT_FIELDS.find((field) => field === search.sort) ?? 'name';

  return {
    q: term === '' || tooLong ? undefined : term,
    page: search.page ?? 1,
    pageSize: TAG_PAGE_SIZE_DEFAULT,
    sort,
    direction: search.dir ?? (sort === 'name' ? 'asc' : 'desc'),
  };
}

export function tagsQuery(guildId: string, filter: TagFilter) {
  return queryOptions({
    queryKey: queryKeys.view(guildId, 'tags', filter),
    queryFn: () =>
      searchTags({
        data: {
          guildId,
          page: filter.page,
          pageSize: filter.pageSize,
          sort: filter.sort,
          direction: filter.direction,
          ...(filter.q === undefined ? {} : { search: filter.q }),
        },
      }),
    staleTime: STALE.browse,
    placeholderData: keepPreviousData,
    ...LIVE,
  });
}

/**
 * The tier counter has to count every tag, and a search-filtered total would read "3 / 25" with a
 * search box open. One row is asked for because only `total` is wanted.
 */
export function tagCountQuery(guildId: string, enabled: boolean) {
  return queryOptions({
    queryKey: queryKeys.view(guildId, 'tags-count', null),
    queryFn: () => searchTags({ data: { guildId, page: 1, pageSize: 1 } }),
    staleTime: STALE.browse,
    enabled,
    ...LIVE,
  });
}
