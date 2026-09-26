import type { ReportAction, ReportActionParams } from '@proton/core';
import {
  REPORT_PAGE_SIZE_DEFAULT,
  REPORT_PAGE_SIZE_MAX,
  REPORT_QUERY_STATUSES,
  REPORT_SORTS,
} from '@proton/module-moderation/reports-view';
import {
  keepPreviousData,
  mutationOptions,
  type QueryClient,
  queryOptions,
} from '@tanstack/react-query';
import { z } from 'zod';
import type { ModuleSearch } from '../../../components/module/route.tsx';
import type { AutomationRunListQuery, ReportListQuery } from '../../../lib/api-client.ts';
import { LIVE, queryKeys, STALE } from '../../../lib/query-keys.ts';
import {
  actOnReport,
  getCaseEvidence,
  getReport,
  getReportSummary,
  listReportAutomationRuns,
  searchReports,
} from '../../../server/reports.ts';

export const REPORT_SUMMARY_POLL_MS = 20_000;
export const REPORT_DECIDING_POLL_MS = 5_000;

const MEMBER_ID = /^\d{17,20}$/;
const SEARCH_MAX = 100;

const instantSchema = z.union([z.iso.date(), z.iso.datetime({ offset: true })]);

export interface LocalFilters {
  group?: boolean | undefined;
  targetId?: string | undefined;
  reporterId?: string | undefined;
  assigneeId?: string | undefined;
  from?: string | undefined;
  to?: string | undefined;
  delivery?: boolean | undefined;
  close?: boolean | undefined;
  pageSize?: number | undefined;
}

export const NO_LOCAL_FILTERS: LocalFilters = {};

export interface ReportActionVariables {
  reportId: string;
  action: ReportAction;
  params: ReportActionParams;
  requestId: string;
}

function member(value: string | undefined): string | undefined {
  const id = value?.trim();
  return id !== undefined && MEMBER_ID.test(id) ? id : undefined;
}

function instant(value: string | undefined): string | undefined {
  const text = value?.trim();
  return text !== undefined && instantSchema.safeParse(text).success ? text : undefined;
}

export function reportFilter(
  search: ModuleSearch,
  local: LocalFilters = NO_LOCAL_FILTERS,
): ReportListQuery {
  const group = local.group === true;
  const sort = REPORT_SORTS.find((candidate) => candidate === search.sort) ?? 'created';
  const term = (search.q ?? '').trim().slice(0, SEARCH_MAX).trim();
  const assignee = local.assigneeId === 'none' ? 'none' : member(local.assigneeId);
  const from = instant(local.from);
  const to = instant(local.to);
  const backwards = from !== undefined && to !== undefined && Date.parse(from) > Date.parse(to);
  const size = Math.trunc(local.pageSize ?? REPORT_PAGE_SIZE_DEFAULT);

  return {
    status: REPORT_QUERY_STATUSES.find((candidate) => candidate === search.status) ?? 'active',
    targetId: member(local.targetId),
    reporterId: member(local.reporterId),
    assigneeId: assignee,
    from: backwards ? undefined : from,
    to: backwards ? undefined : to,
    q: term === '' ? undefined : term,
    delivery: local.delivery === true ? 'problem' : undefined,
    close: local.close === true ? 'problem' : undefined,
    sort: sort === 'volume' && !group ? 'created' : sort,
    dir: search.dir === 'asc' ? 'asc' : 'desc',
    page: search.page ?? 1,
    pageSize: Number.isFinite(size)
      ? Math.min(REPORT_PAGE_SIZE_MAX, Math.max(1, size))
      : REPORT_PAGE_SIZE_DEFAULT,
    group: group ? 'member' : undefined,
  };
}

export function newRequestId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
}

export function reportsKey(guildId: string): readonly unknown[] {
  return [...queryKeys.guild(guildId), 'moderation', 'reports'];
}

export function reportsQuery(guildId: string, query: ReportListQuery) {
  return queryOptions({
    queryKey: [...reportsKey(guildId), 'list', query] as const,
    queryFn: () => searchReports({ data: { guildId, ...query } }),
    staleTime: STALE.browse,
    placeholderData: keepPreviousData,
    ...LIVE,
  });
}

export function reportSummaryQuery(guildId: string) {
  return queryOptions({
    queryKey: [...reportsKey(guildId), 'summary'] as const,
    queryFn: () => getReportSummary({ data: { guildId } }),
    staleTime: STALE.browse,
    refetchInterval: REPORT_SUMMARY_POLL_MS,
    ...LIVE,
  });
}

export function reportQuery(guildId: string, reportId: string) {
  return queryOptions({
    queryKey: [...reportsKey(guildId), 'detail', reportId] as const,
    queryFn: () => getReport({ data: { guildId, reportId } }),
    staleTime: STALE.browse,
    refetchInterval: (query) => (query.state.data?.deciding ? REPORT_DECIDING_POLL_MS : false),
    ...LIVE,
  });
}

export function automationRunsQuery(guildId: string, query: Partial<AutomationRunListQuery> = {}) {
  const filter = {
    status: query.status,
    page: query.page ?? 1,
    pageSize: query.pageSize ?? REPORT_PAGE_SIZE_DEFAULT,
  };

  return queryOptions({
    queryKey: [...reportsKey(guildId), 'automation-runs', filter] as const,
    queryFn: () => listReportAutomationRuns({ data: { guildId, ...filter } }),
    staleTime: STALE.browse,
    placeholderData: keepPreviousData,
    ...LIVE,
  });
}

export function caseEvidenceQuery(guildId: string, caseId: string) {
  return queryOptions({
    queryKey: [...queryKeys.guild(guildId), 'cases', 'evidence', caseId] as const,
    queryFn: () => getCaseEvidence({ data: { guildId, caseId } }),
    staleTime: STALE.browse,
    ...LIVE,
  });
}

// onSettled, not onSuccess: a refusal or a worker timeout can still have moved the report underneath.
export function actOnReportMutation(queryClient: QueryClient, guildId: string) {
  return mutationOptions({
    mutationFn: (variables: ReportActionVariables) =>
      actOnReport({ data: { guildId, ...variables } }),
    onSettled: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: reportsKey(guildId) }),
        queryClient.invalidateQueries({ queryKey: [...queryKeys.guild(guildId), 'cases'] }),
      ]),
  });
}
