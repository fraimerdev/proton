import {
  ACTION_KINDS,
  type ActionKind,
  CASE_SORT_FIELDS,
  type CaseScope,
  type CaseSortDirection,
  type CaseSortField,
  caseIdSchema,
  isModerationActionKind,
} from '@proton/core';
import { keepPreviousData, queryOptions } from '@tanstack/react-query';
import type { ModuleSearch } from '../../components/module/route.tsx';
import { LIVE, queryKeys, STALE } from '../../lib/query-keys.ts';
import { searchCases } from '../../server/modules.ts';

// No 100: fifty rows already reach the hundred member ids getGuildMembers accepts.
export const PAGE_SIZES = [25, 50] as const;

export const DEFAULT_PAGE_SIZE: number = PAGE_SIZES[1];

export interface CaseFilter {
  caseId: string | undefined;
  type: ActionKind | undefined;
  scope: CaseScope;
  moderatorId: string | undefined;
  targetId: string | undefined;
  from: string | undefined;
  to: string | undefined;
  sort: CaseSortField;
  direction: CaseSortDirection;
  page: number;
  pageSize: number;
}

export type CaseLinkFilter = Pick<
  CaseFilter,
  'caseId' | 'type' | 'scope' | 'sort' | 'direction' | 'page'
>;

export type CaseLocalFilter = Pick<
  CaseFilter,
  'moderatorId' | 'targetId' | 'from' | 'to' | 'pageSize'
>;

export const CASE_LOCAL_DEFAULTS: CaseLocalFilter = {
  moderatorId: undefined,
  targetId: undefined,
  from: undefined,
  to: undefined,
  pageSize: DEFAULT_PAGE_SIZE,
};

const ALL = 'all';
const ALL_PREFIX = 'all-';

export interface CaseView {
  scope: CaseScope;
  type: ActionKind | undefined;
}

export function caseView(status: string | undefined): CaseView {
  if (status === ALL) return { scope: 'all', type: undefined };

  const all = status?.startsWith(ALL_PREFIX) === true;
  const wanted = all ? status?.slice(ALL_PREFIX.length) : status;
  const type = ACTION_KINDS.find((kind) => kind === wanted);

  if (type === undefined) return { scope: all ? 'all' : 'moderation', type: undefined };

  return { scope: all || !isModerationActionKind(type) ? 'all' : 'moderation', type };
}

export function caseStatus({ scope, type }: CaseView): string | undefined {
  if (scope === 'all') return type === undefined ? ALL : `${ALL_PREFIX}${type}`;

  return type !== undefined && isModerationActionKind(type) ? type : undefined;
}

export function caseLinkFilter(search: ModuleSearch): CaseLinkFilter {
  const term = search.q ?? '';

  return {
    caseId: term !== '' && caseIdSchema.safeParse(term).success ? term : undefined,
    ...caseView(search.status),
    sort: CASE_SORT_FIELDS.find((field) => field === search.sort) ?? 'createdAt',
    direction: search.dir === 'asc' ? 'asc' : 'desc',
    page: search.page ?? 1,
  };
}

export function caseFilter(search: ModuleSearch, local: CaseLocalFilter): CaseFilter {
  const link = caseLinkFilter(search);

  // A case ID names one case, and the links that carry one don't know which tab it is under.
  return { ...link, scope: link.caseId === undefined ? link.scope : 'all', ...local };
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
