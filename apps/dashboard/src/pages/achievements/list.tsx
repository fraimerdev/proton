import { TIER_COLOURS, TIER_LABELS, toHexColour } from '@proton/cards/design';
import { LIMIT_LABELS, type ModuleSummary } from '@proton/core';
import type { Achievement, AchievementsConfig } from '@proton/module-achievements/config';
import type { StatusView } from '@proton/module-achievements/evaluate';
import { triggerOf } from '@proton/module-achievements/triggers';
import type { OverviewAchievement } from '@proton/module-achievements/view';
import { useQuery } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { useEffect, useMemo, useState } from 'react';
import type { ModuleForm } from '../../components/module/form.ts';
import { useModuleNavigate, useModuleSearch } from '../../components/module/route.tsx';
import {
  CollectionButtonRow,
  CollectionHeader,
  MetaSeparator,
} from '../../components/ui/collection.tsx';
import {
  Badge,
  Button,
  Chip,
  SearchField,
  Select,
  type SelectOption,
} from '../../components/ui/controls.tsx';
import { EmptyState, Spinner } from '../../components/ui/feedback.tsx';
import { Rows, Section } from '../../components/ui/layout.tsx';
import { readFailure } from '../../lib/errors.ts';
import { ceilingNote, listCeiling } from '../../lib/limits.ts';
import type { ModuleMeta } from '../../lib/modules/catalogue.ts';
import { BadgeGlyph } from './badge.tsx';
import { CreateAchievementDialog } from './create-dialog.tsx';
import { AchievementEditor } from './editor.tsx';
import { earnedMembers, overviewOf } from './progress-panel.tsx';
import { achievementsOverviewQuery } from './queries.ts';
import { configIssues, issueIndexes, savedConfig } from './shape.ts';
import { STATUS_LABELS, statusOf, statusTone, useStatusContext } from './status.tsx';

const SEARCH_FROM = 8;
const SEARCH_DEBOUNCE_MS = 250;

const INTRO =
  'Every achievement starts as a draft and counts nothing until you make it active and save.';

const EMPTY_BODY = 'Create one from scratch or start from a preset.';

const SEARCH_SCOPE = 'Search looks at names, descriptions and what each achievement counts.';

const NOT_FOUND = 'It may have been deleted.';

const NEEDS_FIXING = 'A setting needs fixing before saving';

const UNNAMED = 'Unnamed achievement';

const COUNT = new Intl.NumberFormat('en-GB');

export const STATUS_FILTERS = [
  'all',
  'active',
  'scheduled',
  'draft',
  'paused',
  'expired',
  'archived',
  'attention',
] as const;

export type StatusFilter = (typeof STATUS_FILTERS)[number];

const FILTER_OPTIONS: readonly SelectOption[] = [
  { value: 'all', label: 'All' },
  { value: 'active', label: 'Active' },
  { value: 'scheduled', label: 'Scheduled' },
  { value: 'draft', label: 'Draft' },
  { value: 'paused', label: 'Paused' },
  { value: 'expired', label: 'Expired' },
  { value: 'archived', label: 'Archived' },
  { value: 'attention', label: 'Needs attention' },
];

const FILTER_EMPTY: Record<Exclude<StatusFilter, 'all'>, string> = {
  active: 'No achievement is counting right now.',
  scheduled: 'No achievement is waiting for its start date.',
  draft: 'No achievement is a draft.',
  paused: 'No achievement is paused.',
  expired: 'No achievement is past its deadline.',
  archived: 'No achievement is archived.',
  attention:
    'No setting needs fixing, no rewards failed, and no achievement is waiting on a module ' +
    'that’s off.',
};

export function statusFilterOf(value: string | undefined): StatusFilter {
  return STATUS_FILTERS.find((filter) => filter === value) ?? 'all';
}

export function needsAttention(
  view: StatusView,
  entry: OverviewAchievement | undefined,
  broken = false,
): boolean {
  return broken || (entry?.rewards.failed ?? 0) > 0 || (view.blockedBy?.length ?? 0) > 0;
}

export function matchesFilter(
  filter: StatusFilter,
  view: StatusView,
  entry: OverviewAchievement | undefined,
  broken = false,
): boolean {
  if (filter === 'all') return true;
  if (filter === 'attention') return needsAttention(view, entry, broken);
  return view.status === filter;
}

export function requirementSummary(achievement: Achievement): string {
  return achievement.requirements
    .map((requirement) => triggerOf(requirement.trigger).label)
    .join(', ');
}

export function matchesSearch(achievement: Achievement, term: string): boolean {
  const needle = term.trim().toLowerCase();
  if (needle === '') return true;

  return [achievement.name, achievement.description, requirementSummary(achievement)].some((text) =>
    text.toLowerCase().includes(needle),
  );
}

export function earnedLabel(count: number): string {
  if (count === 0) return 'Not earned yet';
  return `${COUNT.format(count)} ${count === 1 ? 'member' : 'members'} earned`;
}

export function failedLabel(count: number): string {
  return `${COUNT.format(count)} ${count === 1 ? 'reward' : 'rewards'} failed`;
}

function TierChips({ achievement }: { achievement: Achievement }): ReactElement {
  if (achievement.kind === 'single') return <span>Single</span>;

  const requirementId = achievement.requirements[0]?.id;

  return (
    <>
      {achievement.tiers.map((tier) => {
        const target = requirementId === undefined ? undefined : tier.targets[requirementId];

        return (
          <Chip key={tier.id} colour={toHexColour(TIER_COLOURS[tier.id])}>
            {target === undefined
              ? TIER_LABELS[tier.id]
              : `${TIER_LABELS[tier.id]} ${COUNT.format(target)}`}
          </Chip>
        );
      })}
    </>
  );
}

function RowMeta({
  achievement,
  view,
  entry,
  loading,
  broken,
}: {
  achievement: Achievement;
  view: StatusView;
  entry: OverviewAchievement | undefined;
  loading: boolean;
  broken: boolean;
}): ReactElement {
  const failed = entry?.rewards.failed ?? 0;

  return (
    <>
      {broken ? (
        <>
          <span className="text-danger">{NEEDS_FIXING}</span>
          <MetaSeparator />
        </>
      ) : null}
      {view.reason !== undefined ? (
        <>
          <span>{view.reason}</span>
          <MetaSeparator />
        </>
      ) : null}
      <span>{requirementSummary(achievement)}</span>
      <MetaSeparator />
      <TierChips achievement={achievement} />
      {loading ? (
        <>
          <MetaSeparator />
          <Spinner label="Loading progress" />
        </>
      ) : entry !== undefined ? (
        <>
          <MetaSeparator />
          <span>{earnedLabel(earnedMembers(entry))}</span>
        </>
      ) : null}
      {failed > 0 ? (
        <>
          <MetaSeparator />
          <span className="text-warning">{failedLabel(failed)}</span>
        </>
      ) : null}
    </>
  );
}

function AchievementList({
  guildId,
  moduleId,
  form,
}: {
  guildId: string;
  moduleId: string;
  form: ModuleForm<AchievementsConfig>;
}): ReactElement {
  const search = useModuleSearch();
  const go = useModuleNavigate(guildId, moduleId);
  const context = useStatusContext(guildId);
  const overview = useQuery(achievementsOverviewQuery(guildId));
  const [creating, setCreating] = useState(false);

  const urlTerm = search.q ?? '';
  const [term, setTerm] = useState(urlTerm);

  useEffect(() => setTerm(urlTerm), [urlTerm]);

  useEffect(() => {
    const next = term.trim();
    if (next === urlTerm) return;

    const timer = window.setTimeout(
      () => go({ q: next === '' ? undefined : next }),
      SEARCH_DEBOUNCE_MS,
    );
    return () => window.clearTimeout(timer);
  }, [term, urlTerm, go]);

  const achievements = form.value.achievements;
  const tier = form.view.tier;
  const ceiling = listCeiling(tier, 'achievements');
  const full = achievements.length >= ceiling;
  const filter = statusFilterOf(search.status);

  const stored = form.view.config;
  const draft = form.value;
  const broken = useMemo(
    () => issueIndexes(configIssues(savedConfig(stored), draft)),
    [stored, draft],
  );

  const rows = achievements.map((achievement, index) => ({
    achievement,
    view: statusOf(achievement, context),
    entry: overviewOf(overview.data, achievement.id),
    broken: broken.has(index),
  }));

  const shown = rows.filter(
    ({ achievement, view, entry, broken: hasIssue }) =>
      matchesFilter(filter, view, entry, hasIssue) && matchesSearch(achievement, term),
  );

  return (
    <Section intro={INTRO}>
      <CollectionHeader
        title="Achievements"
        used={achievements.length}
        ceiling={ceiling}
        limitLabel={LIMIT_LABELS.achievements}
        actions={
          <>
            {achievements.length > SEARCH_FROM || term !== '' ? (
              <SearchField
                value={term}
                label="Search achievements"
                placeholder="Search achievements…"
                onChange={setTerm}
              />
            ) : null}

            <Select
              aria-label="Filter by status"
              width="sm"
              value={filter}
              options={FILTER_OPTIONS}
              onChange={(next) => go({ status: next === 'all' ? undefined : next })}
            />

            <Button
              tone="primary"
              icon="plus"
              disabled={full}
              title={full ? ceilingNote(tier, 'achievements') : undefined}
              onClick={() => setCreating(true)}
            >
              New achievement
            </Button>
          </>
        }
      />

      {full ? <p className="text-sm text-muted">{ceilingNote(tier, 'achievements')}</p> : null}

      {overview.isError ? (
        <p className="text-sm text-muted">
          {readFailure(overview.error, 'the number of members who earned each achievement')}
        </p>
      ) : null}

      {achievements.length === 0 ? (
        <EmptyState
          icon="trophy"
          title="No achievements yet"
          inset
          actions={
            <Button tone="primary" icon="plus" onClick={() => setCreating(true)}>
              New achievement
            </Button>
          }
        >
          {EMPTY_BODY}
        </EmptyState>
      ) : shown.length === 0 ? (
        <EmptyState icon="magnifying-glass" title="No matching achievements" inset>
          {term.trim() !== '' || filter === 'all' ? SEARCH_SCOPE : FILTER_EMPTY[filter]}
        </EmptyState>
      ) : (
        <Rows>
          {shown.map(({ achievement, view, entry, broken: hasIssue }) => (
            <CollectionButtonRow
              key={achievement.id}
              glyph={<BadgeGlyph guildId={guildId} achievement={achievement} />}
              title={
                achievement.name.trim() === '' ? (
                  <span className="text-muted">{UNNAMED}</span>
                ) : (
                  achievement.name
                )
              }
              badge={<Badge tone={statusTone(view)}>{STATUS_LABELS[view.status]}</Badge>}
              meta={
                <RowMeta
                  achievement={achievement}
                  view={view}
                  entry={entry}
                  loading={overview.isPending}
                  broken={hasIssue}
                />
              }
              onSelect={() => go({ id: achievement.id })}
            />
          ))}
        </Rows>
      )}

      <CreateAchievementDialog
        guildId={guildId}
        open={creating}
        taken={achievements.map((achievement) => achievement.id)}
        onClose={() => setCreating(false)}
        onCreate={(created) => {
          form.setValue((current) => ({
            ...current,
            achievements: [...current.achievements, created],
          }));
          setCreating(false);
          go({ id: created.id });
        }}
      />
    </Section>
  );
}

export function ListArea({
  guildId,
  form,
  meta,
}: {
  guildId: string;
  form: ModuleForm<AchievementsConfig>;
  meta: ModuleMeta;
  summary: ModuleSummary | undefined;
}): ReactElement {
  const search = useModuleSearch();
  const go = useModuleNavigate(guildId, meta.id);

  const achievements = form.value.achievements;
  const index =
    search.id === undefined ? -1 : achievements.findIndex((item) => item.id === search.id);
  const achievement = index >= 0 ? achievements[index] : undefined;

  if (achievement !== undefined) {
    return (
      <AchievementEditor
        key={achievement.id}
        guildId={guildId}
        moduleId={meta.id}
        form={form}
        index={index}
        achievement={achievement}
      />
    );
  }

  if (search.id !== undefined) {
    return (
      <EmptyState
        icon="trophy"
        title="Achievement not found"
        inset
        actions={
          <Button tone="primary" onClick={() => go({ id: undefined })}>
            Back to achievements
          </Button>
        }
      >
        {NOT_FOUND}
      </EmptyState>
    );
  }

  return <AchievementList guildId={guildId} moduleId={meta.id} form={form} />;
}
