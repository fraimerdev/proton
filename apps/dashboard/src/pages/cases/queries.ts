import {
  ACTION_KINDS,
  type ActionKind,
  CASE_SORT_FIELDS,
  type CaseSortDirection,
  type CaseSortField,
  caseIdSchema,
} from '@proton/core';
import { keepPreviousData, queryOptions } from '@tanstack/react-query';
import type { ModuleSearch } from '../../components/module/route.tsx';
import { LIVE, queryKeys, STALE } from '../../lib/query-keys.ts';
import { searchCases } from '../../server/modules.ts';

// 25 and 50 only: a row carries a target and a moderator, so fifty rows already reach the hundred
// ids getGuildMembers accepts. A hundred-row page would print half its names as raw ids.
export const PAGE_SIZES = [25, 50] as const;

export const DEFAULT_PAGE_SIZE: number = PAGE_SIZES[1];

export interface CaseFilter {
  caseId: string | undefined;
  type: ActionKind | undefined;
  moderatorId: string | undefined;
  targetId: string | undefined;
  from: string | undefined;
  to: string | undefined;
  sort: CaseSortField;
  direction: CaseSortDirection;
  page: number;
  pageSize: number;
}

export type CaseLinkFilter = Pick<CaseFilter, 'caseId' | 'type' | 'sort' | 'direction' | 'page'>;

export function caseLinkFilter(search: ModuleSearch): CaseLinkFilter {
  const term = search.q ?? '';

  return {
    caseId: term !== '' && caseIdSchema.safeParse(term).success ? term : undefined,
    type: ACTION_KINDS.find((kind) => kind === search.status),
    sort: CASE_SORT_FIELDS.find((field) => field === search.sort) ?? 'createdAt',
    direction: search.dir === 'asc' ? 'asc' : 'desc',
    page: search.page ?? 1,
  };
}

export function casesQuery(guildId: string, filter: CaseFilter) {
  return queryOptions({
    queryKey: [...queryKeys.guild(guildId), 'cases', 'list', filter] as const,
    queryFn: () => searchCases({ data: { guildId, ...filter } }),
    staleTime: STALE.browse,
    // Paging blanks the table otherwise, under the admin who is mid-read of it.
    placeholderData: keepPreviousData,
    ...LIVE,
  });
}
