import type { Achievement, AchievementsConfig } from '@proton/module-achievements/config';
import { joinAnd } from '@proton/module-achievements/evaluate';
import type { AchievementsOverview } from '@proton/module-achievements/view';
import { useQuery } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { useMemo } from 'react';
import { Button } from '../../components/ui/controls.tsx';
import { StatusBanner } from '../../components/ui/feedback.tsx';
import { earnedMembers, overviewOf } from './progress-panel.tsx';
import { achievementsOverviewQuery } from './queries.ts';
import { savedAchievement, semanticDiff } from './shape.ts';

const TARGETS_NOTICE =
  'New targets apply from the next activity. Earned tiers stay earned. Re-check members to apply ' +
  'them now.';

const REQUIREMENTS_NOTICE =
  'This changes what counts, so progress for it starts again. After saving, you can rebuild it ' +
  'from recorded activity (up to 365 days).';

const REWARDS_NOTICE = 'Only members who earn this tier from now on get the new rewards.';

const DATES_NOTICE =
  'New dates and the recorded progress setting apply from the next activity. After saving, you ' +
  'can rebuild from recorded activity to apply them to the last 365 days.';

const STRUCTURE_CHECKING =
  'Proton is checking whether members already hold this achievement. Until it knows, switching ' +
  'between single and tiered or removing a tier can’t be saved, because members could get their ' +
  'rewards twice.';

const STRUCTURE_UNKNOWN =
  'Proton couldn’t check whether members already hold this achievement, so switching between ' +
  'single and tiered or removing a tier can’t be saved. Members could get their rewards twice. ' +
  'Try again, or undo that change.';

const STRUCTURE_LOCKED =
  'Members already hold this achievement, so it can’t switch between single and tiered or lose ' +
  'tiers, because the tiers they earned would change meaning. Duplicate it as a new version ' +
  'instead: your changes go into a new draft and this one is archived.';

export function hasHolders(overview: AchievementsOverview | undefined, id: string): boolean {
  const entry = overviewOf(overview, id);
  return entry !== undefined && earnedMembers(entry) > 0;
}

function hasProgress(overview: AchievementsOverview | undefined, id: string): boolean {
  const entry = overviewOf(overview, id);
  return entry !== undefined && (earnedMembers(entry) > 0 || entry.inProgress > 0);
}

export function structureChanges(
  saved: AchievementsConfig | null,
  draft: AchievementsConfig,
): Achievement[] {
  if (saved === null) return [];

  return draft.achievements.filter(
    (achievement) => semanticDiff(savedAchievement(saved, achievement.id), achievement).structure,
  );
}

export interface StructureLocks {
  locked: Achievement[];
  known: boolean;
  failed: boolean;
}

// Locked until the holders are known: a switch saved while this is loading pays every holder again.
export function useStructureLocks(
  guildId: string,
  draft: AchievementsConfig,
  saved: AchievementsConfig | null,
): StructureLocks {
  const changed = useMemo(() => structureChanges(saved, draft), [saved, draft]);
  const overview = useQuery({
    ...achievementsOverviewQuery(guildId),
    refetchOnMount: 'always',
    enabled: changed.length > 0,
  });

  const known = overview.data !== undefined;
  const failed = overview.isError;

  return useMemo(
    () => ({
      locked: known
        ? changed.filter((achievement) => hasHolders(overview.data, achievement.id))
        : changed,
      known,
      failed,
    }),
    [changed, overview.data, known, failed],
  );
}

export function structureSaveNote(locks: StructureLocks): string | undefined {
  const { locked, known, failed } = locks;
  if (locked.length === 0) return undefined;

  const names = joinAnd(locked.map((achievement) => achievement.name));

  if (!known) {
    return failed
      ? `Proton couldn’t check whether members hold ${names}, so switching between single and ` +
          'tiered or removing tiers can’t be saved yet. Open it and press Try again.'
      : `Proton is checking whether members hold ${names}…`;
  }

  return (
    `Members already hold ${names}, so ${locked.length === 1 ? 'it' : 'they'} can’t switch ` +
    'between single and tiered or lose tiers. Undo that change, or duplicate it as a new version.'
  );
}

export function EditNotices({
  guildId,
  achievement,
  saved,
  onDuplicateVersion,
}: {
  guildId: string;
  achievement: Achievement;
  saved: Achievement | null;
  onDuplicateVersion: () => void;
}): ReactElement | null {
  const diff = useMemo(() => semanticDiff(saved ?? undefined, achievement), [saved, achievement]);

  const touched = diff.targets || diff.requirements || diff.rewards || diff.dates || diff.structure;
  const overview = useQuery({
    ...achievementsOverviewQuery(guildId),
    refetchOnMount: 'always',
    enabled: touched,
  });

  const unknown = overview.data === undefined;
  const checking = diff.structure && unknown;
  const locked = diff.structure && !unknown && hasHolders(overview.data, achievement.id);
  const counted = hasProgress(overview.data, achievement.id);

  if (!locked && !checking && !counted) return null;

  const notices = [
    diff.requirements
      ? { key: 'requirements', title: 'What counts changed', body: REQUIREMENTS_NOTICE }
      : null,
    diff.targets ? { key: 'targets', title: 'Targets changed', body: TARGETS_NOTICE } : null,
    diff.rewards ? { key: 'rewards', title: 'Rewards changed', body: REWARDS_NOTICE } : null,
    diff.dates ? { key: 'dates', title: 'Dates changed', body: DATES_NOTICE } : null,
  ].filter((notice) => notice !== null);

  if (!locked && !checking && notices.length === 0) return null;

  return (
    <div className="achievements-editor-notices">
      {checking ? (
        <StatusBanner
          tone="warning"
          title={overview.isError ? 'Couldn’t check who holds this' : 'Checking who holds this'}
          actions={
            <Button size="sm" busy={overview.isFetching} onClick={() => void overview.refetch()}>
              Try again
            </Button>
          }
        >
          {overview.isError ? STRUCTURE_UNKNOWN : STRUCTURE_CHECKING}
        </StatusBanner>
      ) : null}

      {locked ? (
        <StatusBanner
          tone="warning"
          title="Needs a new version"
          actions={
            <Button size="sm" onClick={onDuplicateVersion}>
              Duplicate as a new version
            </Button>
          }
        >
          {STRUCTURE_LOCKED}
        </StatusBanner>
      ) : null}

      {counted
        ? notices.map((notice) => (
            <StatusBanner key={notice.key} tone="info" title={notice.title}>
              {notice.body}
            </StatusBanner>
          ))
        : null}
    </div>
  );
}
