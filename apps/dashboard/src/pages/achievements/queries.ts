import {
  BADGE_CONTENT_TYPES,
  BADGE_UPLOAD_MAX_BYTES,
  type BadgeUploadResult,
  badgeUploadResultSchema,
  type JobRequestInput,
  type OverviewAchievement,
  type ResetRequestInput,
  type RewardListQuery,
  type RewardRetryRequest,
  type UnlockListQuery,
} from '@proton/module-achievements/view';
import {
  keepPreviousData,
  mutationOptions,
  type QueryClient,
  queryOptions,
} from '@tanstack/react-query';
import type { ModuleSearch } from '../../components/module/route.tsx';
import { LIVE, queryKeys, STALE } from '../../lib/query-keys.ts';
import {
  getAchievementMember,
  getAchievementsOverview,
  getProtonRolePower,
  listAchievementRewards,
  listAchievementUnlocks,
  requestAchievementJob,
  resetAchievements,
  retryAchievementRewards,
} from '../../server/achievements.ts';

export const ACHIEVEMENT_JOB_POLL_MS = 5_000;

export const UNLOCK_PAGE_SIZE = 25;
export const FAILED_REWARD_PAGE_SIZE = 25;

const MEMBER_ID = /^\d{17,20}$/;

export function newRequestId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
}

// The api refuses a new job only while a queued one is younger than this, so a job stranded by a
// restart or by the module being switched off must stop disabling the buttons at the same moment.
const JOB_STALE_MS = 6 * 60 * 60_000;

export function waitingForStart(
  entry: Pick<OverviewAchievement, 'job' | 'startsAt'> | null | undefined,
  now: number = Date.now(),
): boolean {
  if (entry?.job?.status !== 'queued' || entry.job.kind !== 'recheck') return false;

  return entry.startsAt !== null && entry.startsAt > now;
}

export function jobInFlight(
  entry: Pick<OverviewAchievement, 'job' | 'startsAt'> | null | undefined,
  now: number = Date.now(),
): boolean {
  const job = entry?.job;
  if (job?.status !== 'queued' && job?.status !== 'running') return false;
  // Proton parks a re-check until the achievement starts, which can be days: that is waiting, not work.
  if (waitingForStart(entry, now)) return false;

  return job.requestedAt === null || now - job.requestedAt < JOB_STALE_MS;
}

export function memberLookup(search: ModuleSearch): string | undefined {
  const id = search.id?.trim();
  return id !== undefined && MEMBER_ID.test(id) ? id : undefined;
}

export function recentUnlocksFilter(search: ModuleSearch): UnlockListQuery {
  return { page: search.page ?? 1, pageSize: UNLOCK_PAGE_SIZE };
}

export function failedRewardsFilter(page = 1): RewardListQuery {
  return { status: 'failed', page, pageSize: FAILED_REWARD_PAGE_SIZE };
}

export function achievementsOverviewQuery(guildId: string) {
  return queryOptions({
    queryKey: queryKeys.achievementsOverview(guildId),
    queryFn: () => getAchievementsOverview({ data: { guildId } }),
    staleTime: STALE.browse,
    refetchInterval: (query) =>
      query.state.data?.achievements.some((achievement) => jobInFlight(achievement))
        ? ACHIEVEMENT_JOB_POLL_MS
        : false,
    ...LIVE,
  });
}

export function achievementMemberQuery(guildId: string, userId: string) {
  return queryOptions({
    queryKey: queryKeys.achievementMember(guildId, userId),
    queryFn: () => getAchievementMember({ data: { guildId, userId } }),
    staleTime: STALE.browse,
    enabled: MEMBER_ID.test(userId),
    ...LIVE,
  });
}

export function achievementUnlocksQuery(guildId: string, query: UnlockListQuery) {
  return queryOptions({
    queryKey: queryKeys.achievementUnlocks(guildId, query),
    queryFn: () => listAchievementUnlocks({ data: { guildId, ...query } }),
    staleTime: STALE.browse,
    placeholderData: keepPreviousData,
    ...LIVE,
  });
}

export function achievementRewardsQuery(guildId: string, query: RewardListQuery) {
  return queryOptions({
    queryKey: queryKeys.achievementRewards(guildId, query),
    queryFn: () => listAchievementRewards({ data: { guildId, ...query } }),
    staleTime: STALE.browse,
    placeholderData: keepPreviousData,
    ...LIVE,
  });
}

export function protonRolePowerQuery(guildId: string) {
  return queryOptions({
    queryKey: queryKeys.protonRolePower(guildId),
    queryFn: () => getProtonRolePower({ data: { guildId } }),
    staleTime: STALE.guildShape,
    retry: false,
    ...LIVE,
  });
}

// onSettled, not onSuccess: a refusal or a worker timeout can still have moved rewards underneath.
export function retryAchievementRewardsMutation(queryClient: QueryClient, guildId: string) {
  return mutationOptions({
    mutationFn: (variables: RewardRetryRequest) =>
      retryAchievementRewards({ data: { guildId, ...variables } }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: queryKeys.achievements(guildId) }),
  });
}

export function resetAchievementsMutation(queryClient: QueryClient, guildId: string) {
  return mutationOptions({
    mutationFn: (reset: ResetRequestInput) => resetAchievements({ data: { guildId, reset } }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: queryKeys.achievements(guildId) }),
  });
}

export function requestAchievementJobMutation(queryClient: QueryClient, guildId: string) {
  return mutationOptions({
    mutationFn: (variables: JobRequestInput) =>
      requestAchievementJob({ data: { guildId, ...variables } }),
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: queryKeys.achievementsOverview(guildId) }),
  });
}

function kilobytes(bytes: number): string {
  return `${Math.ceil(bytes / 1024)} KB`;
}

// A courtesy only: the api sniffs the bytes and is the authority.
export function refuseBadgeLocally(file: File): string | null {
  if (file.size === 0) return 'That image wasn’t saved: the file is empty.';

  if (file.size > BADGE_UPLOAD_MAX_BYTES) {
    return (
      `That image wasn’t saved: it’s ${kilobytes(file.size)}, and a badge image can be at most ` +
      `${kilobytes(BADGE_UPLOAD_MAX_BYTES)}.`
    );
  }

  if (!(BADGE_CONTENT_TYPES as readonly string[]).includes(file.type)) {
    return 'That image wasn’t saved: it isn’t a PNG, JPEG or GIF.';
  }

  return null;
}

export function badgeUploadMutation(guildId: string) {
  return mutationOptions({
    mutationFn: async (file: File): Promise<BadgeUploadResult> => {
      const refusal = refuseBadgeLocally(file);
      if (refusal !== null) throw new Error(refusal);

      const saved = await fetch(`/api/guilds/${guildId}/achievement-badges`, {
        method: 'PUT',
        headers: { 'content-type': file.type },
        body: file,
      });
      if (!saved.ok) throw new Error((await saved.text()).trim());

      const parsed = badgeUploadResultSchema.safeParse(await saved.json().catch(() => null));
      if (!parsed.success) {
        throw new Error(
          'The image was uploaded, but Proton didn’t confirm it. Reload the page and try again.',
        );
      }

      return parsed.data;
    },
  });
}
