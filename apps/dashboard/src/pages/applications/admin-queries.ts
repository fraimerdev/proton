import { queryOptions } from '@tanstack/react-query';
import { LIVE, queryKeys, STALE } from '../../lib/query-keys.ts';
import {
  getApplicationForms,
  getApplicationFormVersion,
  getApplicationFormVersions,
  getReviewAudience,
  previewApplicationEligibility,
} from '../../server/applications-admin.ts';

export function applicationsAdminKey(guildId: string): readonly unknown[] {
  return [...queryKeys.guild(guildId), 'applications', 'admin'];
}

export function formsOverviewQuery(guildId: string) {
  return queryOptions({
    queryKey: [...applicationsAdminKey(guildId), 'forms'] as const,
    queryFn: () => getApplicationForms({ data: { guildId } }),
    staleTime: STALE.browse,
    ...LIVE,
  });
}

export function formVersionsQuery(guildId: string, formId: string) {
  return queryOptions({
    queryKey: [...applicationsAdminKey(guildId), 'versions', formId] as const,
    queryFn: () => getApplicationFormVersions({ data: { guildId, formId } }),
    staleTime: STALE.browse,
  });
}

export function formVersionQuery(guildId: string, formId: string, versionId: string | null) {
  return queryOptions({
    queryKey: [...applicationsAdminKey(guildId), 'version', formId, versionId] as const,
    queryFn: () =>
      getApplicationFormVersion({ data: { guildId, formId, versionId: versionId ?? '' } }),
    enabled: versionId !== null,
    staleTime: Number.POSITIVE_INFINITY,
  });
}

export function eligibilityPreviewQuery(guildId: string, formId: string, userId: string | null) {
  return queryOptions({
    queryKey: [...applicationsAdminKey(guildId), 'eligibility', formId, userId] as const,
    queryFn: () =>
      previewApplicationEligibility({ data: { guildId, formId, userId: userId ?? '' } }),
    enabled: userId !== null,
    staleTime: 0,
  });
}

export function reviewAudienceQuery(
  guildId: string,
  channelId: string | null,
  formId: string | undefined,
) {
  return queryOptions({
    queryKey: [...applicationsAdminKey(guildId), 'audience', channelId, formId ?? null] as const,
    queryFn: () =>
      getReviewAudience({
        data: {
          guildId,
          channelId: channelId ?? '',
          ...(formId === undefined ? {} : { formId }),
        },
      }),
    enabled: channelId !== null,
    staleTime: STALE.browse,
    ...LIVE,
  });
}
