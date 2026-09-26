import type { ApplicationDetail, QueueQuery } from '@proton/module-applications/view';
import {
  keepPreviousData,
  mutationOptions,
  type QueryClient,
  queryOptions,
} from '@tanstack/react-query';
import type { MemberQuery } from '../../components/discord/member.tsx';
import { LIVE, queryKeys, STALE } from '../../lib/query-keys.ts';
import {
  type ApplicationActionRequest,
  actOnApplication,
  applicationMembers,
  applicationsSummary,
  deleteApplicantData,
  getApplication,
  searchApplications,
} from '../../server/applications.ts';
import { isMemberId, isWorking, REVIEW_MEMBERS_MAX } from './labels.ts';

export const SUMMARY_POLL_MS = 30_000;
export const WORKING_POLL_MS = 5_000;

export interface ApplicationActionVariables {
  applicationId: string;
  requestId: string;
  request: ApplicationActionRequest;
}

export interface DeleteApplicantVariables {
  applicantId: string;
  requestId: string;
}

export function newRequestId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
}

export function applicationsKey(guildId: string): readonly unknown[] {
  return [...queryKeys.guild(guildId), 'applications'];
}

export function applicationQueueQuery(guildId: string, request: QueueQuery) {
  return queryOptions({
    queryKey: [...applicationsKey(guildId), 'queue', request] as const,
    queryFn: () => searchApplications({ data: { guildId, ...request } }),
    staleTime: STALE.browse,
    placeholderData: keepPreviousData,
    ...LIVE,
  });
}

export function applicationSummaryQuery(guildId: string) {
  return queryOptions({
    queryKey: [...applicationsKey(guildId), 'summary'] as const,
    queryFn: () => applicationsSummary({ data: { guildId } }),
    staleTime: STALE.browse,
    refetchInterval: SUMMARY_POLL_MS,
    ...LIVE,
  });
}

export function applicationQuery(guildId: string, applicationId: string) {
  return queryOptions({
    queryKey: [...applicationsKey(guildId), 'detail', applicationId] as const,
    queryFn: () => getApplication({ data: { guildId, applicationId } }),
    staleTime: STALE.browse,
    refetchInterval: (query) => {
      const data: ApplicationDetail | undefined = query.state.data;
      return data !== undefined && isWorking(data.effects) ? WORKING_POLL_MS : false;
    },
    ...LIVE,
  });
}

export function applicationMembersQuery(guildId: string, userIds: readonly string[]): MemberQuery {
  const ids = [...new Set(userIds)].filter(isMemberId).sort().slice(0, REVIEW_MEMBERS_MAX);

  return {
    queryKey: [...applicationsKey(guildId), 'members', ids],
    queryFn: async () => (await applicationMembers({ data: { guildId, userIds: ids } })).members,
    staleTime: STALE.guildShape,
    enabled: ids.length > 0,
    ...LIVE,
  };
}

// onSettled, not onSuccess: a refusal can still mean the application moved underneath.
export function actOnApplicationMutation(queryClient: QueryClient, guildId: string) {
  return mutationOptions({
    mutationFn: (variables: ApplicationActionVariables) =>
      actOnApplication({ data: { guildId, ...variables } }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: applicationsKey(guildId) }),
  });
}

export function deleteApplicantMutation(queryClient: QueryClient, guildId: string) {
  return mutationOptions({
    mutationFn: (variables: DeleteApplicantVariables) =>
      deleteApplicantData({ data: { guildId, ...variables } }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: applicationsKey(guildId) }),
  });
}
