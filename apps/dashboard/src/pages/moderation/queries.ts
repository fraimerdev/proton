import { BLOCKED_STATES, type BlockedState } from '@proton/core';
import { keepPreviousData, queryOptions } from '@tanstack/react-query';
import type { ModuleSearch } from '../../components/module/route.tsx';
import { LIVE, queryKeys, STALE } from '../../lib/query-keys.ts';
import { searchBlockedMembers, searchCases } from '../../server/modules.ts';

export const BLOCKED_PAGE_SIZE = 25;

export const MEMBER_ID = /^\d{17,20}$/;

export interface BlockedFilter {
  state: BlockedState;
  userId: string | undefined;
  page: number;
  order: 'asc' | 'desc';
}

export function blockedState(value: string | undefined): BlockedState {
  return BLOCKED_STATES.find((candidate) => candidate === value) ?? 'live';
}

export function blockedFilter(search: ModuleSearch): BlockedFilter {
  const term = search.q ?? '';

  return {
    state: blockedState(search.status),
    userId: MEMBER_ID.test(term) ? term : undefined,
    page: search.page ?? 1,
    order: search.dir === 'asc' ? 'asc' : 'desc',
  };
}

export function blockedKey(guildId: string): readonly unknown[] {
  return [...queryKeys.guild(guildId), 'blocked'];
}

export function blockedQuery(guildId: string, filter: BlockedFilter) {
  return queryOptions({
    queryKey: [...blockedKey(guildId), 'list', filter] as const,
    queryFn: () =>
      searchBlockedMembers({
        data: {
          guildId,
          state: filter.state,
          userId: filter.userId,
          page: filter.page,
          pageSize: BLOCKED_PAGE_SIZE,
          order: filter.order,
        },
      }),
    staleTime: STALE.browse,
    // Paging blanks the table otherwise, under the admin who is mid-read of it.
    placeholderData: keepPreviousData,
    ...LIVE,
  });
}

export function blockedCountQuery(guildId: string) {
  return queryOptions({
    queryKey: [...blockedKey(guildId), 'count'] as const,
    queryFn: () =>
      searchBlockedMembers({
        data: { guildId, state: 'live', page: 1, pageSize: 1, order: 'desc' },
      }),
    staleTime: STALE.browse,
    ...LIVE,
  });
}

export function caseCountQuery(guildId: string) {
  return queryOptions({
    queryKey: [...queryKeys.guild(guildId), 'cases', 'count'] as const,
    queryFn: () =>
      searchCases({
        data: { guildId, page: 1, pageSize: 1, sort: 'createdAt', direction: 'desc' },
      }),
    staleTime: STALE.browse,
    ...LIVE,
  });
}
