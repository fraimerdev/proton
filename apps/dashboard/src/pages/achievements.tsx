import {
  type AchievementsConfig,
  achievementsConfigSchema,
} from '@proton/module-achievements/config';
import { achievementsTemplates } from '@proton/module-achievements/placeholders';
import { useQuery } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { useEffect, useMemo } from 'react';
import type { ModuleForm } from '../components/module/form.ts';
import { useModuleForm } from '../components/module/form.ts';
import {
  ModuleBanners,
  ModuleHeader,
  ModuleSwitch,
  moduleState,
} from '../components/module/page.tsx';
import type { ModulePageProps } from '../components/module/registry.ts';
import { ModuleLink, useModuleSearch } from '../components/module/route.tsx';
import { useModuleToggle } from '../components/module/toggle.ts';
import { LoadingBoundary, StatusBanner } from '../components/ui/feedback.tsx';
import { SaveBar } from '../components/ui/savebar.tsx';
import { AreaTabs } from '../components/ui/tabs.tsx';
import { rolesQuery } from '../lib/queries.ts';
import { AnnouncementsArea } from './achievements/announcements.tsx';
import { structureSaveNote, useStructureLocks } from './achievements/edit-notices.tsx';
import { ListArea } from './achievements/list.tsx';
import { MembersArea } from './achievements/members.tsx';
import { protonRolePowerQuery } from './achievements/queries.ts';
import { SettingsArea } from './achievements/settings.tsx';
import {
  bumpVersions,
  changedRoleRewards,
  configIssues,
  issueSaveNote,
  type RewardRoleIssue,
  rewardRoleIssues,
  rewardSaveNote,
  savedConfig,
} from './achievements/shape.ts';

type Form = ModuleForm<AchievementsConfig>;

function useSavedConfig(form: Form): AchievementsConfig | null {
  const stored = form.view.config;
  return useMemo(() => savedConfig(stored), [stored]);
}

// On the draft as it changes, not at save: Test message sends the draft, and the api checks it like a save.
function useVersionBumps(form: Form, saved: AchievementsConfig | null): void {
  const { value, setValue } = form;

  useEffect(() => {
    if (saved === null) return;

    const next = bumpVersions(saved, value);
    if (next !== value) setValue(next);
  }, [saved, value, setValue]);
}

function useRewardRoleIssues(
  guildId: string,
  form: Form,
  saved: AchievementsConfig | null,
): RewardRoleIssue[] {
  const draft = form.value;
  const changed = useMemo(
    () => (saved === null ? 0 : changedRoleRewards(saved, draft).length),
    [saved, draft],
  );

  const roles = useQuery({ ...rolesQuery(guildId), enabled: changed > 0 });
  const power = useQuery({ ...protonRolePowerQuery(guildId), enabled: changed > 0 });

  return useMemo(
    () =>
      saved === null || changed === 0
        ? []
        : rewardRoleIssues(saved, draft, { guildId, roles: roles.data, power: power.data }),
    [saved, draft, changed, guildId, roles.data, power.data],
  );
}

export default function AchievementsPage({
  guildId,
  meta,
  summary,
  area,
}: ModulePageProps): ReactElement {
  const form = useModuleForm({
    guildId,
    moduleId: meta.id,
    schema: achievementsConfigSchema,
    templates: achievementsTemplates,
  });
  const toggle = useModuleToggle(guildId, summary);
  const search = useModuleSearch();

  const saved = useSavedConfig(form);
  useVersionBumps(form, saved);
  const blocked = useRewardRoleIssues(guildId, form, saved);
  const locks = useStructureLocks(guildId, form.value, saved);
  const problems = useMemo(() => configIssues(saved, form.value), [saved, form.value]);

  const enabled = summary?.enabled ?? form.view.enabled;

  const openId = area === 'list' ? search.id : undefined;
  const open = form.value.achievements.find((achievement) => achievement.id === openId);
  const view = open !== undefined ? 'editor' : openId !== undefined ? 'missing' : 'list';

  return (
    <>
      <ModuleHeader
        meta={meta}
        crumb={
          open === undefined ? undefined : open.name.trim() === '' ? (
            <span className="text-muted">Unnamed achievement</span>
          ) : (
            open.name
          )
        }
        backTo={
          open === undefined ? undefined : (
            <ModuleLink guildId={guildId} moduleId={meta.id} search={{ ...search, id: undefined }}>
              Achievements
            </ModuleLink>
          )
        }
        actions={
          <ModuleSwitch
            name={meta.label}
            enabled={enabled}
            state={summary ? moduleState(summary) : 'off'}
            busy={toggle.busy}
            onToggle={toggle.toggle}
          />
        }
      />

      <AreaTabs guildId={guildId} moduleId={meta.id} areas={meta.areas ?? []} current={area} />

      <ModuleBanners
        moduleName={meta.label}
        status={summary?.status}
        enabled={enabled}
        offNote="Settings are saved, but nothing is tracked or awarded until you turn it on."
        migrated={form.view.migrated}
        changedElsewhere={form.changedElsewhere}
        saveError={form.saveError}
      >
        {toggle.failure !== null ? (
          <StatusBanner tone="danger" live="assertive" onDismiss={toggle.dismiss}>
            {toggle.failure}
          </StatusBanner>
        ) : null}
      </ModuleBanners>

      <LoadingBoundary key={`${area}:${view}`} label={`Loading ${meta.label}`} minHeight={320}>
        {area === 'list' ? (
          <ListArea guildId={guildId} form={form} meta={meta} summary={summary} />
        ) : null}
        {area === 'announcements' ? (
          <AnnouncementsArea guildId={guildId} form={form} meta={meta} summary={summary} />
        ) : null}
        {area === 'members' ? <MembersArea guildId={guildId} form={form} /> : null}
        {area === 'settings' ? (
          <SettingsArea guildId={guildId} form={form} meta={meta} summary={summary} />
        ) : null}
      </LoadingBoundary>

      <SaveBar
        dirty={form.dirty}
        saving={form.saving}
        failures={form.failures}
        disabled={blocked.length > 0 || locks.locked.length > 0 || problems.length > 0}
        note={
          rewardSaveNote(blocked) ?? structureSaveNote(locks) ?? issueSaveNote(form.value, problems)
        }
        onSave={form.save}
        onReset={form.reset}
      />
    </>
  );
}
