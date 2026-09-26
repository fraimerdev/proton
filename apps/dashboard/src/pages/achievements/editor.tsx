import type {
  Achievement,
  AchievementStatus,
  AchievementsConfig,
} from '@proton/module-achievements/config';
import { joinAnd, type StatusView } from '@proton/module-achievements/evaluate';
import { DEPENDENCY_LABELS } from '@proton/module-achievements/triggers';
import type { ReactElement } from 'react';
import { useCallback, useMemo, useState } from 'react';
import type { ModuleForm } from '../../components/module/form.ts';
import { useModuleNavigate } from '../../components/module/route.tsx';
import { Button, TextArea, TextInput } from '../../components/ui/controls.tsx';
import { Rows, SettingRow } from '../../components/ui/layout.tsx';
import { ConfirmDialog, type MenuAction, MenuButton } from '../../components/ui/overlay.tsx';
import { SegmentedTabs } from '../../components/ui/tabs.tsx';
import { listCeiling } from '../../lib/limits.ts';
import { AnnouncementTab } from './announcement-override.tsx';
import { BadgeEditor } from './badge-editor.tsx';
import { EditNotices } from './edit-notices.tsx';
import { ProgressPanel } from './progress-panel.tsx';
import { RequirementsTab } from './requirements.tsx';
import { ScheduleEditor } from './schedule.tsx';
import {
  duplicateAchievement,
  duplicateAsNewVersion,
  savedAchievement,
  savedConfig,
} from './shape.ts';
import { StatusBadge, type StatusContext, statusOf, useStatusContext } from './status.tsx';

const NAME_MAX = 80;
const DESCRIPTION_MAX = 300;

const DESCRIPTION_HELP = 'Members see it in /achievement view, and announcements can include it.';

const NAME_MISSING = 'An achievement needs a name.';

const DELETE_BODY = 'Members keep the badges they earned. It’s removed when you save.';

const UNNAMED = 'an unnamed achievement';

export function deleteBody(dependents: readonly Achievement[]): string {
  if (dependents.length === 0) return DELETE_BODY;

  const names = joinAnd(dependents.map((held) => (held.name.trim() === '' ? UNNAMED : held.name)));
  const one = dependents.length === 1;

  return (
    `${names} ${one ? 'requires' : 'require'} it, so nothing can be saved until ` +
    `${one ? 'that requirement is' : 'those requirements are'} changed. ${DELETE_BODY}`
  );
}

const VERSION_BODY =
  'Proton copies it into a new draft, where progress starts from zero, and archives this one. ' +
  'Members keep the badges they earned from this version, and your unsaved changes go to the ' +
  'copy. Nothing changes until you save.';

type Tab = 'requirements' | 'badge' | 'schedule' | 'announcement' | 'progress';

const TABS: readonly { id: Tab; label: string }[] = [
  { id: 'requirements', label: 'Requirements' },
  { id: 'badge', label: 'Badge' },
  { id: 'schedule', label: 'Schedule' },
  { id: 'announcement', label: 'Announcement' },
  { id: 'progress', label: 'Progress' },
];

const LIFECYCLE: Record<
  AchievementStatus,
  { label: string; next: AchievementStatus; tone: 'primary' | 'secondary' }
> = {
  draft: { label: 'Make active', next: 'active', tone: 'primary' },
  active: { label: 'Pause', next: 'paused', tone: 'secondary' },
  paused: { label: 'Resume', next: 'active', tone: 'secondary' },
  archived: { label: 'Restore', next: 'paused', tone: 'secondary' },
};

type Form = ModuleForm<AchievementsConfig>;

function activationNote(
  achievement: Achievement,
  saved: Achievement | null,
  view: StatusView,
  context: StatusContext,
): string {
  if (achievement.status !== 'active' || saved?.status === 'active') return '';
  if (!context.moduleEnabled) return 'It starts counting once Achievements is on.';

  const blocked = view.blockedBy ?? [];
  if (blocked.length > 0) {
    const names = joinAnd(blocked.map((module) => DEPENDENCY_LABELS[module]));
    return `It stays paused until ${names} ${blocked.length === 1 ? 'is' : 'are'} on.`;
  }

  if (view.status === 'scheduled') return 'It starts counting on its start date.';
  return '';
}

export function AchievementEditor({
  guildId,
  moduleId,
  form,
  index,
  achievement,
}: {
  guildId: string;
  moduleId: string;
  form: Form;
  index: number;
  achievement: Achievement;
}): ReactElement {
  const go = useModuleNavigate(guildId, moduleId);
  const context = useStatusContext(guildId);
  const [tab, setTab] = useState<Tab>('requirements');
  const [switched, setSwitched] = useState(false);
  const [tryValues, setTryValues] = useState<Record<string, number>>({});
  const [confirming, setConfirming] = useState<'delete' | 'version' | null>(null);

  const stored = form.view.config;
  const saved = useMemo(
    () => savedAchievement(savedConfig(stored), achievement.id) ?? null,
    [stored, achievement.id],
  );

  const { setValue } = form;
  const id = achievement.id;
  const update = useCallback(
    (change: (current: Achievement) => Achievement) =>
      setValue((config) => ({
        ...config,
        achievements: config.achievements.map((held) => (held.id === id ? change(held) : held)),
      })),
    [setValue, id],
  );

  const path = `achievements.${index}`;
  const view = statusOf(achievement, context);
  const lifecycle = LIFECYCLE[achievement.status];
  const note = activationNote(achievement, saved, view, context);

  const achievements = form.value.achievements;
  const full = achievements.length >= listCeiling(form.view.tier, 'achievements');
  const taken = achievements.map((held) => held.id);

  const dependents = achievements.filter(
    (held) =>
      held.id !== id &&
      held.requirements.some(
        (requirement) =>
          requirement.trigger === 'achievements.unlocked' && requirement.achievementId === id,
      ),
  );

  const duplicate = (): void => {
    const copy = duplicateAchievement(achievement, taken);
    setValue((config) => ({ ...config, achievements: [...config.achievements, copy] }));
    go({ id: copy.id });
  };

  const duplicateVersion = (): void => {
    const { copy } = duplicateAsNewVersion(achievement, taken);
    const archived: Achievement = { ...(saved ?? achievement), status: 'archived' };

    setValue((config) => ({
      ...config,
      achievements: [
        ...config.achievements.map((held) => (held.id === id ? archived : held)),
        copy,
      ],
    }));
    setConfirming(null);
    go({ id: copy.id });
  };

  const remove = (): void => {
    setValue((config) => ({
      ...config,
      achievements: config.achievements.filter((held) => held.id !== id),
    }));
    setConfirming(null);
    go({ id: undefined });
  };

  const actions: MenuAction[] = [
    {
      id: 'duplicate',
      label: 'Duplicate',
      icon: 'clipboard-text',
      disabled: full,
      onSelect: duplicate,
    },
    ...(achievement.status === 'archived'
      ? []
      : [
          {
            id: 'version',
            label: 'Duplicate as a new version',
            icon: 'clipboard-text' as const,
            disabled: full,
            onSelect: () => setConfirming('version'),
          },
          {
            id: 'archive',
            label: 'Archive',
            icon: 'archive' as const,
            onSelect: () => update((current) => ({ ...current, status: 'archived' })),
          },
        ]),
    ...(achievement.status === 'draft' || achievement.status === 'archived'
      ? [
          {
            id: 'delete',
            label: 'Delete',
            icon: 'trash' as const,
            danger: true,
            onSelect: () => setConfirming('delete'),
          },
        ]
      : []),
  ];

  const nameError =
    form.errorAt(`${path}.name`) ?? (achievement.name.trim() === '' ? NAME_MISSING : undefined);
  const descriptionError = form.errorAt(`${path}.description`);
  const label = achievement.name.trim() === '' ? 'this achievement' : achievement.name;

  return (
    <div className="achievements-editor">
      <div className="achievements-editor-toolbar">
        <div className="achievements-editor-toolbar-main">
          <StatusBadge view={view} />
          <span className="push-right inline inline-8">
            <Button
              tone={lifecycle.tone}
              onClick={() => update((current) => ({ ...current, status: lifecycle.next }))}
            >
              {lifecycle.label}
            </Button>
            <MenuButton label="Achievement actions" actions={actions} />
          </span>
        </div>
        <p className="achievements-editor-activation" aria-live="polite">
          {note}
        </p>
      </div>

      <Rows>
        <SettingRow title="Name" error={nameError}>
          <TextInput
            width="lg"
            aria-label="Name"
            maxLength={NAME_MAX}
            invalid={nameError !== undefined}
            value={achievement.name}
            onChange={(event) => {
              const name = event.currentTarget.value;
              update((current) => ({ ...current, name }));
            }}
          />
        </SettingRow>

        <SettingRow
          title="Description"
          description={DESCRIPTION_HELP}
          error={descriptionError}
          stacked
        >
          <TextArea
            rows={2}
            aria-label="Description"
            maxLength={DESCRIPTION_MAX}
            invalid={descriptionError !== undefined}
            value={achievement.description}
            onChange={(event) => {
              const description = event.currentTarget.value;
              update((current) => ({ ...current, description }));
            }}
          />
        </SettingRow>
      </Rows>

      <EditNotices
        guildId={guildId}
        achievement={achievement}
        saved={saved}
        onDuplicateVersion={() => setConfirming('version')}
      />

      <div className="achievements-editor-tabs">
        <SegmentedTabs
          label="Achievement sections"
          value={tab}
          items={TABS}
          onChange={(next) => {
            setSwitched(true);
            setTab(next);
          }}
        />
      </div>

      <div
        key={tab}
        role="tabpanel"
        aria-label={TABS.find((item) => item.id === tab)?.label}
        className={switched ? 'motion-fade' : undefined}
      >
        {tab === 'requirements' ? (
          <RequirementsTab
            guildId={guildId}
            form={form}
            index={index}
            achievement={achievement}
            saved={saved}
            tryValues={tryValues}
            setTryValues={setTryValues}
          />
        ) : null}

        {tab === 'badge' ? (
          <BadgeEditor
            guildId={guildId}
            achievement={achievement}
            path={path}
            errorAt={form.errorAt}
            update={update}
          />
        ) : null}

        {tab === 'schedule' ? (
          <ScheduleEditor
            guildId={guildId}
            moduleId={moduleId}
            achievement={achievement}
            saved={saved}
            zone={form.value.timezone}
            path={path}
            errorAt={form.errorAt}
            update={update}
          />
        ) : null}

        {tab === 'announcement' ? (
          <AnnouncementTab
            guildId={guildId}
            form={form}
            index={index}
            achievement={achievement}
            tryValues={tryValues}
          />
        ) : null}

        {tab === 'progress' ? (
          <ProgressPanel
            guildId={guildId}
            moduleId={moduleId}
            form={form}
            achievement={achievement}
          />
        ) : null}
      </div>

      <ConfirmDialog
        open={confirming === 'delete'}
        onClose={() => setConfirming(null)}
        onConfirm={remove}
        title={`Delete ${label}?`}
        confirmLabel="Delete achievement"
        icon="trash"
        danger
      >
        {deleteBody(dependents)}
      </ConfirmDialog>

      <ConfirmDialog
        open={confirming === 'version'}
        onClose={() => setConfirming(null)}
        onConfirm={duplicateVersion}
        title={`Duplicate ${label} as a new version?`}
        confirmLabel="Duplicate as new version"
      >
        {VERSION_BODY}
      </ConfirmDialog>
    </div>
  );
}
