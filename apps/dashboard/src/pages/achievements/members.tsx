import { TIER_COLOURS, TIER_LABELS, toHexColour } from '@proton/cards/design';
import {
  ACHIEVEMENT_RETRY_MAX,
  type AchievementRetryStatus,
  type AchievementRewardRef,
  type TierId,
} from '@proton/core';
import type { Achievement, AchievementsConfig } from '@proton/module-achievements/config';
import {
  achievementRevision,
  describeRequirement,
  formatProgress,
  joinAnd,
  nextTier,
  progressBar,
  tierRank,
} from '@proton/module-achievements/evaluate';
import { isTriggerId, triggerOf } from '@proton/module-achievements/triggers';
import type {
  MemberAchievementView,
  MemberDetail,
  RewardRetryOutcome,
  RewardStatus,
  RewardView,
  UnlockDefinition,
  UnlockView,
} from '@proton/module-achievements/view';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ReactElement, ReactNode } from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { MemberCell, MemberProvider, useMember } from '../../components/discord/member.tsx';
import { MemberPicker } from '../../components/discord/member-picker.tsx';
import type { ModuleForm } from '../../components/module/form.ts';
import { useModuleNavigate, useModuleSearch } from '../../components/module/route.tsx';
import { Badge, Button, Checkbox, Chip } from '../../components/ui/controls.tsx';
import { EmptyState, LoadingArea, StatusBanner } from '../../components/ui/feedback.tsx';
import { Rows, Section, SettingRow } from '../../components/ui/layout.tsx';
import { Dialog } from '../../components/ui/overlay.tsx';
import { type Column, DataTable, Pagination } from '../../components/ui/table.tsx';
import type { GuildRole } from '../../lib/discord.ts';
import { failureKind, readFailure, saveFailure } from '../../lib/errors.ts';
import { rolesQuery } from '../../lib/queries.ts';
import { BadgeGlyph } from './badge.tsx';
import {
  achievementMemberQuery,
  achievementRewardsQuery,
  achievementUnlocksQuery,
  failedRewardsFilter,
  memberLookup,
  newRequestId,
  recentUnlocksFilter,
  resetAchievementsMutation,
  retryAchievementRewardsMutation,
} from './queries.ts';
import { savedConfig } from './shape.ts';
import { formatDay, formatZoned, zonedParts } from './time.ts';

type Form = ModuleForm<AchievementsConfig>;

type BadgeTone = 'neutral' | 'success' | 'warning' | 'danger' | 'info';

type RoleIndex = ReadonlyMap<string, GuildRole>;

const FAILED_EMPTY_TITLE = 'No failed rewards';

const FAILED_EMPTY = 'When a role or XP can’t be given, it shows here with the reason.';

const NOTHING_TITLE = 'Nothing yet';

const UNLOCKS_EMPTY_TITLE = 'No unlocks yet';

const UNLOCKS_EMPTY = 'Achievements show here as members earn them.';

const NO_REASON = 'Proton didn’t record why.';

const RESET_CONSEQUENCE: Record<'member_achievement' | 'member_all', string> = {
  member_achievement:
    'Their progress and earned tiers for this achievement are cleared, and they can earn it again ' +
    'from their next activity. Roles and XP already given stay given, and aren’t given again ' +
    'unless you allow it below.',
  member_all:
    'Their progress and earned tiers for every achievement are cleared, and they can earn them ' +
    'again from their next activity. Roles and XP already given stay given, and aren’t given ' +
    'again unless you allow it below.',
};

const REWARDS_AGAIN = 'Let them earn the rewards again';

const REWARDS_AGAIN_CONFIRM =
  'They’re given the roles and XP again when they earn it again, even though they had them before.';

const LEFT_NOTE = 'They can’t earn achievements until they rejoin.';

const COUNT = new Intl.NumberFormat('en-GB');

const REWARD_STATUS: Record<RewardStatus, { label: string; tone: BadgeTone }> = {
  pending: { label: 'Waiting', tone: 'neutral' },
  delivering: { label: 'Being given', tone: 'info' },
  requested: { label: 'Sent to Leveling', tone: 'info' },
  delivered: { label: 'Given', tone: 'success' },
  failed: { label: 'Failed', tone: 'danger' },
  skipped: { label: 'Skipped', tone: 'neutral' },
  cancelled: { label: 'Cancelled', tone: 'neutral' },
};

const ANNOUNCE_STATUS: Record<UnlockView['announceStatus'], { label: string; tone: BadgeTone }> = {
  pending: { label: 'Waiting', tone: 'neutral' },
  sent: { label: 'Announced', tone: 'success' },
  failed: { label: 'Failed', tone: 'danger' },
  skipped: { label: 'Not announced', tone: 'neutral' },
  suppressed: { label: 'Not announced', tone: 'neutral' },
};

const OUTCOME_WORDS: Record<AchievementRetryStatus, string> = {
  delivered: 'given',
  requested: 'sent to Leveling',
  failed: 'failed again',
  skipped: 'skipped',
  not_found: 'no longer there',
  not_retryable: 'can’t be retried',
};

const SETTLED: ReadonlySet<AchievementRetryStatus> = new Set(['delivered', 'requested']);

function plural(count: number, one: string, many = `${one}s`): string {
  return `${COUNT.format(count)} ${count === 1 ? one : many}`;
}

function lowerFirst(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}

// Not saveFailure alone: the api's refusals name what is off or missing, and saveFailure would replace them.
function refusal(error: Error, attempt: string): string {
  return failureKind(error) === 'unknown' && error.message !== ''
    ? error.message
    : saveFailure(error, attempt);
}

export function rewardRef(reward: RewardView): AchievementRewardRef {
  return {
    userId: reward.userId,
    achievementId: reward.achievementId,
    tierId: reward.tierId,
    generation: reward.generation,
    rewardKey: reward.rewardKey,
  };
}

export function refKey(ref: AchievementRewardRef): string {
  return `${ref.userId}:${ref.achievementId}:${ref.tierId}:${ref.generation}:${ref.rewardKey}`;
}

function batchKey(refs: readonly AchievementRewardRef[]): string {
  return refs.map(refKey).sort().join('|');
}

export function rewardText(
  reward: { kind: RewardView['kind']; roleId?: string | null; amount?: number | null },
  roles: RoleIndex,
): string {
  if (reward.kind === 'xp') return `${COUNT.format(reward.amount ?? 0)} XP`;

  const id = reward.roleId ?? '';
  const role = `@${roles.get(id)?.name ?? id}`;
  return reward.kind === 'add_role' ? `Give ${role}` : `Remove ${role}`;
}

export function rewardReason(reward: RewardView, zone: string): string | undefined {
  const retryAt =
    reward.nextAttemptAt === null
      ? ''
      : ` Proton tries again on ${formatZoned(reward.nextAttemptAt, zone)}.`;

  switch (reward.status) {
    case 'failed':
      return `${reward.error ?? NO_REASON}${reward.transient ? retryAt : ''}`;
    case 'pending':
      return retryAt === '' ? undefined : retryAt.trim();
    case 'requested':
      return 'Leveling hasn’t confirmed it yet.';
    case 'delivered':
      return reward.deliveredAt === null
        ? undefined
        : `Given on ${formatZoned(reward.deliveredAt, zone)}.`;
    case 'skipped':
    case 'cancelled':
      return reward.error ?? undefined;
    case 'delivering':
      return undefined;
  }
}

export function announcementText(unlock: UnlockView, zone: string): string {
  switch (unlock.announceStatus) {
    case 'sent':
      return unlock.announcedAt === null
        ? 'Announced.'
        : `Announced on ${formatZoned(unlock.announcedAt, zone)}.`;
    case 'pending':
      return 'Waiting to be announced.';
    case 'failed':
      return `The announcement failed: ${unlock.announceError ?? NO_REASON}`;
    case 'skipped':
      return `Not announced: ${unlock.announceError ?? 'there was nowhere to post it.'}`;
    case 'suppressed':
      return 'Not announced: it was earned in a rebuild or re-check, which don’t announce.';
  }
}

export function versionSentence(
  unlock: UnlockView,
  currentRevision: string | null,
  roles: RoleIndex,
  zone: string,
  nameOf: (id: string) => string | undefined,
): string {
  const { definition } = unlock;
  const date = formatDay(zonedParts(unlock.unlockedAt, zone).date);
  const version =
    currentRevision === unlock.revision ? 'the current version' : 'an earlier version';

  const requirements = joinAnd(
    definition.requirements.map((requirement) =>
      isTriggerId(requirement.trigger)
        ? lowerFirst(
            describeRequirement(
              { ...requirement, trigger: requirement.trigger },
              requirement.target,
              'en-GB',
              nameOf,
            ),
          )
        : requirement.trigger,
    ),
  );

  const rewards =
    definition.rewards.length === 0
      ? 'none'
      : joinAnd(definition.rewards.map((reward) => lowerFirst(rewardText(reward, roles))));

  return `Earned on ${date} under ${version}: ${requirements}; rewards attached: ${rewards}.`;
}

export function retrySummary(outcome: RewardRetryOutcome): {
  tone: 'success' | 'warning';
  text: string;
  reasons: string[];
} {
  const counts = new Map<AchievementRetryStatus, number>();
  for (const result of outcome.results) {
    counts.set(result.status, (counts.get(result.status) ?? 0) + 1);
  }

  const parts = [...counts].map(
    ([status, count]) => `${COUNT.format(count)} ${OUTCOME_WORDS[status]}`,
  );
  const reasons = [
    ...new Set(
      outcome.results
        .filter((result) => !SETTLED.has(result.status) && result.message.trim() !== '')
        .map((result) => result.message.trim()),
    ),
  ];

  return {
    tone: outcome.results.every((result) => SETTLED.has(result.status)) ? 'success' : 'warning',
    text:
      outcome.results.length === 0
        ? 'There was nothing to retry.'
        : `Retried ${plural(outcome.results.length, 'reward')}: ${joinAnd(parts)}.`,
    reasons,
  };
}

function TierLabel({ tier }: { tier: TierId }): ReactElement {
  return tier === 'single' ? (
    <span>{TIER_LABELS.single}</span>
  ) : (
    <Chip colour={toHexColour(TIER_COLOURS[tier])}>{TIER_LABELS[tier]}</Chip>
  );
}

function TierCell({ tier }: { tier: TierId }): ReactElement {
  return tier === 'single' ? <span className="text-muted">None</span> : <TierLabel tier={tier} />;
}

function useRoleIndex(guildId: string): RoleIndex {
  const { data } = useQuery(rolesQuery(guildId));
  return useMemo(() => new Map((data ?? []).map((role) => [role.id, role])), [data]);
}

function useAchievementIndex(form: Form): {
  saved: ReadonlyMap<string, Achievement>;
  nameOf: (id: string) => string | undefined;
} {
  const stored = form.view.config;
  const draft = form.value.achievements;

  return useMemo(() => {
    const saved = new Map(
      (savedConfig(stored)?.achievements ?? draft).map((achievement) => [
        achievement.id,
        achievement,
      ]),
    );
    return { saved, nameOf: (id: string) => saved.get(id)?.name };
  }, [stored, draft]);
}

function useRewardRetry(guildId: string) {
  const queryClient = useQueryClient();
  const requestIds = useRef(new Map<string, string>());
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<RewardRetryOutcome | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const mutation = useMutation(retryAchievementRewardsMutation(queryClient, guildId));

  const run = (refs: readonly AchievementRewardRef[]): void => {
    const batch = refs.slice(0, ACHIEVEMENT_RETRY_MAX);
    if (batch.length === 0) return;

    const key = batchKey(batch);
    // One id per set of rewards until it is answered: a retry after a timeout gets the first answer.
    const requestId = requestIds.current.get(key) ?? newRequestId();
    requestIds.current.set(key, requestId);

    setPendingKey(key);
    setOutcome(null);
    setFailure(null);

    mutation.mutate(
      { requestId, rewards: batch },
      {
        onSuccess: (result) => {
          requestIds.current.delete(key);
          setOutcome(result);
        },
        onError: (error: Error) => setFailure(refusal(error, 'Couldn’t retry the rewards')),
        onSettled: () => setPendingKey(null),
      },
    );
  };

  return {
    run,
    busy: (refs: readonly AchievementRewardRef[]): boolean =>
      pendingKey !== null && pendingKey === batchKey(refs.slice(0, ACHIEVEMENT_RETRY_MAX)),
    pending: pendingKey !== null,
    outcome,
    failure,
    dismiss: () => {
      setOutcome(null);
      setFailure(null);
    },
  };
}

type Retry = ReturnType<typeof useRewardRetry>;

function RetryBanners({ retry }: { retry: Retry }): ReactElement | null {
  if (retry.failure !== null) {
    return (
      <StatusBanner tone="danger" live="assertive" onDismiss={retry.dismiss}>
        {retry.failure}
      </StatusBanner>
    );
  }

  if (retry.outcome === null) return null;

  const summary = retrySummary(retry.outcome);

  return (
    <StatusBanner tone={summary.tone} live="polite" onDismiss={retry.dismiss}>
      <span className="stack stack-4">
        <span>{summary.text}</span>
        {summary.reasons.map((reason) => (
          <span key={reason}>{reason}</span>
        ))}
      </span>
    </StatusBanner>
  );
}

function RetryButton({
  retry,
  refs,
  label,
  children = 'Retry',
}: {
  retry: Retry;
  refs: readonly AchievementRewardRef[];
  label: string;
  children?: ReactNode;
}): ReactElement {
  return (
    <Button
      size="sm"
      aria-label={label}
      busy={retry.busy(refs)}
      disabled={retry.pending && !retry.busy(refs)}
      onClick={() => retry.run(refs)}
    >
      {children}
    </Button>
  );
}

function RowRetry({
  retry,
  reward,
  text,
  achievementName,
}: {
  retry: Retry;
  reward: RewardView;
  text: string;
  achievementName: string;
}): ReactElement {
  const member = useMember(reward.userId);
  const who = member?.displayName ?? reward.userId;

  return (
    <RetryButton
      retry={retry}
      refs={[rewardRef(reward)]}
      label={`Retry ${text} for ${who}, ${achievementName}`}
    />
  );
}

function FailedRewards({
  guildId,
  form,
  roles,
  onLookup,
}: {
  guildId: string;
  form: Form;
  roles: RoleIndex;
  onLookup: (userId: string) => void;
}): ReactElement {
  const [page, setPage] = useState(1);
  const filter = failedRewardsFilter(page);
  const query = useQuery(achievementRewardsQuery(guildId, filter));
  const retry = useRewardRetry(guildId);
  const { nameOf } = useAchievementIndex(form);
  const zone = form.value.timezone;

  const data = query.data;
  const rows = data?.items ?? [];
  const total = data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / filter.pageSize));

  useEffect(() => {
    if (data !== undefined && page > pages) setPage(pages);
  }, [data, page, pages]);

  const refs = rows.map(rewardRef);
  const everything = total <= rows.length;

  const columns: Column<RewardView>[] = [
    {
      id: 'member',
      header: 'Member',
      primary: true,
      cell: (row) => <MemberCell userId={row.userId} />,
    },
    {
      id: 'achievement',
      header: 'Achievement',
      cell: (row) => nameOf(row.achievementId) ?? <span className="mono">{row.achievementId}</span>,
    },
    { id: 'tier', header: 'Tier', cell: (row) => <TierCell tier={row.tierId} /> },
    { id: 'reward', header: 'Reward', cell: (row) => rewardText(row, roles) },
    {
      id: 'reason',
      header: 'Why',
      cell: (row) => <span className="achievements-members-reason">{rewardReason(row, zone)}</span>,
    },
    {
      id: 'retry',
      header: '',
      align: 'right',
      cell: (row) => (
        <RowRetry
          retry={retry}
          reward={row}
          text={rewardText(row, roles)}
          achievementName={nameOf(row.achievementId) ?? row.achievementId}
        />
      ),
    },
  ];

  return (
    <Section
      label="Failed rewards"
      actions={
        rows.length > 0 ? (
          <RetryButton
            retry={retry}
            refs={refs}
            label={everything ? 'Retry all failed rewards' : 'Retry this page of failed rewards'}
          >
            {everything ? 'Retry all' : 'Retry this page'}
          </RetryButton>
        ) : undefined
      }
    >
      <div className="stack stack-10">
        <RetryBanners retry={retry} />

        {query.isError ? (
          <StatusBanner
            tone="danger"
            live="polite"
            actions={
              <Button size="sm" busy={query.isFetching} onClick={() => void query.refetch()}>
                Try again
              </Button>
            }
          >
            {readFailure(query.error, 'failed rewards')}
          </StatusBanner>
        ) : data === undefined ? (
          <LoadingArea label="Loading failed rewards" minHeight={120} size="sm" />
        ) : rows.length === 0 ? (
          <EmptyState inset icon="check-circle" title={FAILED_EMPTY_TITLE}>
            {FAILED_EMPTY}
          </EmptyState>
        ) : (
          <MemberProvider guildId={guildId} userIds={[...new Set(rows.map((row) => row.userId))]}>
            <DataTable
              columns={columns}
              rows={rows}
              rowKey={(row) => refKey(rewardRef(row))}
              onRowClick={(row) => onLookup(row.userId)}
              loading={query.isFetching && query.isPlaceholderData}
              loadingLabel="Loading failed rewards"
              footer={
                total > filter.pageSize ? (
                  <Pagination
                    page={page}
                    pageSize={filter.pageSize}
                    total={total}
                    noun="failed rewards"
                    onPageChange={setPage}
                  />
                ) : undefined
              }
            />
          </MemberProvider>
        )}
      </div>
    </Section>
  );
}

type ResetTarget =
  | { scope: 'member_achievement'; achievementId: string; name: string }
  | { scope: 'member_all' };

function ResetDialog({
  guildId,
  userId,
  target,
  onClose,
  onDone,
}: {
  guildId: string;
  userId: string;
  target: ResetTarget | null;
  onClose: () => void;
  onDone: (message: string) => void;
}): ReactElement | null {
  const queryClient = useQueryClient();
  const member = useMember(userId);
  const who = member?.displayName ?? 'this member';
  const open = target !== null;

  const [shown, setShown] = useState<ResetTarget>(target ?? { scope: 'member_all' });
  const [again, setAgain] = useState(false);
  const [againConfirmed, setAgainConfirmed] = useState(false);
  const [requestId, setRequestId] = useState(newRequestId);
  const [failure, setFailure] = useState<string | null>(null);
  const [wasOpen, setWasOpen] = useState(open);

  if (open !== wasOpen) {
    setWasOpen(open);
    if (open && target !== null) {
      setShown(target);
      setAgain(false);
      setAgainConfirmed(false);
      setFailure(null);
      setRequestId(newRequestId());
    }
  }

  const reset = useMutation({
    ...resetAchievementsMutation(queryClient, guildId),
    onSuccess: (result) =>
      onDone(
        shown.scope === 'member_achievement'
          ? `${shown.name} was reset for ${who}.`
          : `Reset ${plural(result.achievements, 'achievement')} for ${who}.`,
      ),
    onError: (error: Error) => setFailure(refusal(error, 'Couldn’t reset their achievements')),
  });

  const title =
    shown.scope === 'member_achievement'
      ? `Reset ${shown.name} for ${who}?`
      : `Reset all of ${who}’s achievements?`;

  const confirm = (): void => {
    setFailure(null);
    reset.mutate(
      shown.scope === 'member_achievement'
        ? {
            scope: 'member_achievement',
            requestId,
            userId,
            achievementId: shown.achievementId,
            allowRewardsAgain: again,
          }
        : { scope: 'member_all', requestId, userId, allowRewardsAgain: again },
    );
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      dismissible={!reset.isPending}
      title={title}
      size="compact"
      icon="warning"
      tone="danger"
      footer={
        <>
          <Button onClick={onClose} disabled={reset.isPending}>
            Cancel
          </Button>
          <Button
            tone="danger"
            busy={reset.isPending}
            disabled={again && !againConfirmed}
            onClick={confirm}
          >
            {shown.scope === 'member_achievement' ? 'Reset achievement' : 'Reset achievements'}
          </Button>
        </>
      }
    >
      <p className="text-sm text-secondary">{RESET_CONSEQUENCE[shown.scope]}</p>

      {failure !== null ? (
        <StatusBanner tone="danger" live="assertive">
          {failure}
        </StatusBanner>
      ) : null}

      <span className="achievements-members-check">
        <Checkbox
          checked={again}
          label={REWARDS_AGAIN}
          onChange={(next) => {
            setAgain(next);
            if (!next) setAgainConfirmed(false);
          }}
        />
        <span aria-hidden="true">{REWARDS_AGAIN}</span>
      </span>

      {again ? (
        <span className="achievements-members-check achievements-members-check-follow">
          <Checkbox
            checked={againConfirmed}
            label={REWARDS_AGAIN_CONFIRM}
            onChange={setAgainConfirmed}
          />
          <span aria-hidden="true">{REWARDS_AGAIN_CONFIRM}</span>
        </span>
      ) : null}
    </Dialog>
  );
}

function ProgressLines({
  achievement,
  state,
  nameOf,
}: {
  achievement: Achievement;
  state: MemberAchievementView | undefined;
  nameOf: (id: string) => string | undefined;
}): ReactElement | null {
  const values = state?.values ?? {};
  const next = nextTier(achievement, values, state?.unlocked ?? []);

  if (next === null) {
    return achievement.kind === 'tiered' ? (
      <SettingRow title="Progress" description="Every tier earned." />
    ) : null;
  }

  const labelled =
    achievement.requirements.length > 1 ||
    achievement.requirements.some(({ trigger }) => triggerOf(trigger).filters.achievement);

  return (
    <SettingRow
      title={achievement.kind === 'single' ? 'Progress' : `Towards ${TIER_LABELS[next.tier]}`}
      description={
        <span className="stack stack-4">
          {next.requirements.map((progress) => {
            const requirement = achievement.requirements.find(({ id }) => id === progress.id);
            const text = formatProgress(
              progress.current,
              progress.target,
              triggerOf(progress.trigger).unit,
            );

            return (
              <span key={progress.id} className="achievements-members-progress">
                <span>
                  {labelled && requirement !== undefined
                    ? `${describeRequirement(requirement, progress.target, 'en-GB', nameOf)}: ${text}`
                    : text}
                </span>
                <span className="achievements-members-bar" aria-hidden>
                  {progressBar(progress.ratio)}
                </span>
              </span>
            );
          })}
        </span>
      }
    />
  );
}

function RewardLine({
  reward,
  roles,
  zone,
  retry,
  achievementName,
}: {
  reward: RewardView;
  roles: RoleIndex;
  zone: string;
  retry: Retry;
  achievementName: string;
}): ReactElement {
  const status = REWARD_STATUS[reward.status];
  const reason = rewardReason(reward, zone);
  const text = rewardText(reward, roles);

  return (
    <li className="achievements-members-reward">
      <span className="achievements-members-reward-head">
        <span className="achievements-members-reward-name">{text}</span>
        <Badge tone={status.tone}>{status.label}</Badge>
        {reward.status === 'failed' ? (
          <span className="push-right">
            <RetryButton
              retry={retry}
              refs={[rewardRef(reward)]}
              label={`Retry ${text} for ${achievementName}`}
            />
          </span>
        ) : null}
      </span>
      {reason !== undefined ? <span className="achievements-members-reason">{reason}</span> : null}
    </li>
  );
}

function UnlockRow({
  unlock,
  rewards,
  currentRevision,
  roles,
  zone,
  retry,
  achievementName,
  nameOf,
}: {
  unlock: UnlockView;
  rewards: readonly RewardView[];
  currentRevision: string | null;
  roles: RoleIndex;
  zone: string;
  retry: Retry;
  achievementName: string;
  nameOf: (id: string) => string | undefined;
}): ReactElement {
  const announce = ANNOUNCE_STATUS[unlock.announceStatus];

  return (
    <div className="row stacked">
      <div className="row-main">
        <div className="row-title">
          <TierLabel tier={unlock.tierId} />
        </div>
        <p className="row-description">
          {versionSentence(unlock, currentRevision, roles, zone, nameOf)}
        </p>
        <p className="row-note achievements-members-announce">
          <Badge tone={announce.tone}>{announce.label}</Badge>
          <span>{announcementText(unlock, zone)}</span>
        </p>
        {rewards.length > 0 ? (
          <ul
            className="achievements-members-rewards"
            aria-label={`Rewards for ${achievementName}`}
          >
            {rewards.map((reward) => (
              <RewardLine
                key={refKey(rewardRef(reward))}
                reward={reward}
                roles={roles}
                zone={zone}
                retry={retry}
                achievementName={achievementName}
              />
            ))}
          </ul>
        ) : null}
      </div>
    </div>
  );
}

interface MemberAchievement {
  id: string;
  name: string;
  achievement: Achievement | undefined;
  state: MemberAchievementView | undefined;
  unlocks: UnlockView[];
  rewards: RewardView[];
  earlier: RewardView[];
  definition: UnlockDefinition | undefined;
}

export function memberAchievements(
  detail: MemberDetail,
  saved: ReadonlyMap<string, Achievement>,
): MemberAchievement[] {
  const ids = new Set([
    ...detail.achievements.map(({ achievementId }) => achievementId),
    ...detail.unlocks.map(({ achievementId }) => achievementId),
    ...detail.rewards.map(({ achievementId }) => achievementId),
  ]);

  const order = [...saved.keys()];
  const sorted = [...ids].sort((a, b) => {
    const left = order.indexOf(a);
    const right = order.indexOf(b);
    return (left === -1 ? order.length : left) - (right === -1 ? order.length : right);
  });

  return sorted.map((id) => {
    const unlocks = detail.unlocks
      .filter((unlock) => unlock.achievementId === id)
      .sort((a, b) => tierRank(a.tierId) - tierRank(b.tierId));
    const held = new Set(unlocks.map((unlock) => `${unlock.tierId}:${unlock.generation}`));
    const rewards = detail.rewards.filter((reward) => reward.achievementId === id);
    const definition =
      unlocks.at(-1)?.definition ??
      detail.voided.find((unlock) => unlock.achievementId === id)?.definition;
    const achievement = saved.get(id);

    return {
      id,
      name: achievement?.name ?? definition?.name ?? id,
      achievement,
      state: detail.achievements.find((state) => state.achievementId === id),
      unlocks,
      rewards: rewards.filter((reward) => held.has(`${reward.tierId}:${reward.generation}`)),
      earlier: rewards.filter((reward) => !held.has(`${reward.tierId}:${reward.generation}`)),
      definition,
    };
  });
}

function AchievementBlock({
  guildId,
  item,
  roles,
  zone,
  retry,
  nameOf,
  onReset,
}: {
  guildId: string;
  item: MemberAchievement;
  roles: RoleIndex;
  zone: string;
  retry: Retry;
  nameOf: (id: string) => string | undefined;
  onReset: () => void;
}): ReactElement {
  const currentRevision = useMemo(
    () => (item.achievement === undefined ? null : achievementRevision(item.achievement)),
    [item.achievement],
  );
  const resetAt = item.state?.resetAt ?? null;

  return (
    <div className="achievements-members-achievement">
      <div className="achievements-members-head">
        {item.achievement !== undefined ? (
          <BadgeGlyph guildId={guildId} achievement={item.achievement} />
        ) : null}
        <h2 className="achievements-members-name">{item.name}</h2>
        {item.achievement === undefined ? (
          <Badge tone="neutral">No longer in settings</Badge>
        ) : null}
        <span className="push-right">
          <Button size="sm" tone="danger-quiet" onClick={onReset}>
            Reset this achievement…
          </Button>
        </span>
      </div>

      <Rows>
        {item.achievement !== undefined ? (
          <ProgressLines achievement={item.achievement} state={item.state} nameOf={nameOf} />
        ) : null}

        {item.unlocks.map((unlock) => (
          <UnlockRow
            key={`${unlock.tierId}:${unlock.generation}`}
            unlock={unlock}
            rewards={item.rewards.filter(
              (reward) =>
                reward.tierId === unlock.tierId && reward.generation === unlock.generation,
            )}
            currentRevision={currentRevision}
            roles={roles}
            zone={zone}
            retry={retry}
            achievementName={item.name}
            nameOf={nameOf}
          />
        ))}

        {item.earlier.length > 0 ? (
          <div className="row stacked">
            <div className="row-main">
              <div className="row-title">Earlier rewards</div>
              <p className="row-description">From tiers earned before a reset.</p>
              <ul
                className="achievements-members-rewards"
                aria-label={`Earlier rewards for ${item.name}`}
              >
                {item.earlier.map((reward) => (
                  <RewardLine
                    key={refKey(rewardRef(reward))}
                    reward={reward}
                    roles={roles}
                    zone={zone}
                    retry={retry}
                    achievementName={item.name}
                  />
                ))}
              </ul>
            </div>
          </div>
        ) : null}

        {resetAt !== null ? (
          <SettingRow title="Reset" description={`Reset on ${formatZoned(resetAt, zone)}.`} />
        ) : null}
      </Rows>
    </div>
  );
}

function MemberDetailView({
  guildId,
  userId,
  form,
  roles,
}: {
  guildId: string;
  userId: string;
  form: Form;
  roles: RoleIndex;
}): ReactElement {
  const query = useQuery(achievementMemberQuery(guildId, userId));
  const retry = useRewardRetry(guildId);
  const member = useMember(userId);
  const { saved, nameOf } = useAchievementIndex(form);
  const zone = form.value.timezone;
  const [resetting, setResetting] = useState<ResetTarget | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const items = useMemo(
    () => (query.data === undefined ? [] : memberAchievements(query.data, saved)),
    [query.data, saved],
  );

  if (query.isError) {
    return (
      <StatusBanner
        tone="danger"
        live="polite"
        actions={
          <Button size="sm" busy={query.isFetching} onClick={() => void query.refetch()}>
            Try again
          </Button>
        }
      >
        {readFailure(query.error, 'this member’s achievements')}
      </StatusBanner>
    );
  }

  if (query.data === undefined) {
    return <LoadingArea label="Loading this member’s achievements" minHeight={160} size="sm" />;
  }

  const who = member?.displayName ?? 'This member';
  const leftAt = query.data.facts?.leftAt ?? null;
  const earned = items.filter((item) => item.unlocks.length > 0).length;

  return (
    <div className="stack stack-16">
      {done !== null ? (
        <StatusBanner tone="success" live="polite" onDismiss={() => setDone(null)}>
          {done}
        </StatusBanner>
      ) : null}

      <RetryBanners retry={retry} />

      {leftAt !== null ? (
        <StatusBanner tone="neutral">
          {`${who} left the server on ${formatZoned(leftAt, zone)}. ${LEFT_NOTE}`}
        </StatusBanner>
      ) : null}

      {items.length === 0 ? (
        <EmptyState inset icon="trophy" title={NOTHING_TITLE}>
          {`${who} has no progress towards any achievement yet.`}
        </EmptyState>
      ) : (
        <>
          <div className="achievements-members-toolbar">
            <span className="text-sm text-secondary">
              {`${plural(earned, 'achievement')} earned, ${COUNT.format(items.length - earned)} in progress.`}
            </span>
            <span className="push-right">
              <Button
                size="sm"
                tone="danger-quiet"
                onClick={() => {
                  setDone(null);
                  setResetting({ scope: 'member_all' });
                }}
              >
                Reset all achievements…
              </Button>
            </span>
          </div>

          {items.map((item) => (
            <AchievementBlock
              key={item.id}
              guildId={guildId}
              item={item}
              roles={roles}
              zone={zone}
              retry={retry}
              nameOf={nameOf}
              onReset={() => {
                setDone(null);
                setResetting({
                  scope: 'member_achievement',
                  achievementId: item.id,
                  name: item.name,
                });
              }}
            />
          ))}
        </>
      )}

      <ResetDialog
        guildId={guildId}
        userId={userId}
        target={resetting}
        onClose={() => setResetting(null)}
        onDone={(message) => {
          setResetting(null);
          setDone(message);
        }}
      />
    </div>
  );
}

function RecentUnlocks({
  guildId,
  form,
  onLookup,
}: {
  guildId: string;
  form: Form;
  onLookup: (userId: string) => void;
}): ReactElement {
  const search = useModuleSearch();
  const go = useModuleNavigate(guildId, 'achievements');
  const filter = recentUnlocksFilter(search);
  const query = useQuery(achievementUnlocksQuery(guildId, filter));
  const { nameOf } = useAchievementIndex(form);
  const zone = form.value.timezone;

  const rows = query.data?.items ?? [];

  const columns: Column<UnlockView>[] = [
    {
      id: 'member',
      header: 'Member',
      primary: true,
      cell: (row) => <MemberCell userId={row.userId} />,
    },
    {
      id: 'achievement',
      header: 'Achievement',
      cell: (row) => nameOf(row.achievementId) ?? row.definition.name,
    },
    { id: 'tier', header: 'Tier', cell: (row) => <TierCell tier={row.tierId} /> },
    { id: 'earned', header: 'Earned', cell: (row) => formatZoned(row.unlockedAt, zone) },
    {
      id: 'announced',
      header: 'Announcement',
      cell: (row) => (
        <Badge tone={ANNOUNCE_STATUS[row.announceStatus].tone}>
          {ANNOUNCE_STATUS[row.announceStatus].label}
        </Badge>
      ),
    },
  ];

  return (
    <Section label="Recent unlocks">
      {query.isError ? (
        <StatusBanner
          tone="danger"
          live="polite"
          actions={
            <Button size="sm" busy={query.isFetching} onClick={() => void query.refetch()}>
              Try again
            </Button>
          }
        >
          {readFailure(query.error, 'recent unlocks')}
        </StatusBanner>
      ) : (
        <MemberProvider guildId={guildId} userIds={[...new Set(rows.map((row) => row.userId))]}>
          <DataTable
            columns={columns}
            rows={rows}
            rowKey={(row) => `${row.userId}:${row.achievementId}:${row.tierId}:${row.generation}`}
            onRowClick={(row) => onLookup(row.userId)}
            loading={query.isPending || (query.isFetching && query.isPlaceholderData)}
            loadingLabel="Loading recent unlocks"
            empty={{ icon: 'trophy', title: UNLOCKS_EMPTY_TITLE, body: UNLOCKS_EMPTY }}
            footer={
              query.data !== undefined && query.data.total > filter.pageSize ? (
                <Pagination
                  page={filter.page}
                  pageSize={filter.pageSize}
                  total={query.data.total}
                  noun="unlocks"
                  onPageChange={(page) => go({ page })}
                />
              ) : undefined
            }
          />
        </MemberProvider>
      )}
    </Section>
  );
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

export function MembersArea({ guildId, form }: { guildId: string; form: Form }): ReactElement {
  const search = useModuleSearch();
  const go = useModuleNavigate(guildId, 'achievements');
  const roles = useRoleIndex(guildId);
  const lookupRef = useRef<HTMLDivElement>(null);
  const userId = memberLookup(search);

  const lookup = (id: string): void => {
    go({ id });
    lookupRef.current?.scrollIntoView({
      block: 'start',
      behavior: prefersReducedMotion() ? 'auto' : 'smooth',
    });
    lookupRef.current?.focus({ preventScroll: true });
  };

  return (
    <>
      <FailedRewards guildId={guildId} form={form} roles={roles} onLookup={lookup} />

      <Section label="Look up a member">
        <div ref={lookupRef} tabIndex={-1} className="achievements-members-lookup stack stack-16">
          <Rows>
            <SettingRow title="Member">
              <MemberPicker
                guildId={guildId}
                label="Member to look up"
                placeholder="Choose a member"
                noneLabel="No member"
                value={userId ?? null}
                onChange={(id) => go({ id: id ?? undefined })}
              />
            </SettingRow>
          </Rows>

          {userId !== undefined ? (
            <MemberProvider guildId={guildId} userIds={[userId]}>
              <MemberDetailView
                key={userId}
                guildId={guildId}
                userId={userId}
                form={form}
                roles={roles}
              />
            </MemberProvider>
          ) : null}
        </div>
      </Section>

      <RecentUnlocks guildId={guildId} form={form} onLookup={lookup} />
    </>
  );
}
