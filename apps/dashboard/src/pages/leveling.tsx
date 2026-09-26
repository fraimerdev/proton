import { levelingConfigSchema } from '@proton/module-leveling/config';
import { levelingTemplates } from '@proton/module-leveling/placeholders';
import type { ReactElement } from 'react';
import { useModuleForm } from '../components/module/form.ts';
import {
  ModuleBanners,
  ModuleHeader,
  ModuleSwitch,
  moduleState,
} from '../components/module/page.tsx';
import type { ModulePageProps } from '../components/module/registry.ts';
import { useModuleToggle } from '../components/module/toggle.ts';
import { LoadingBoundary, StatusBanner } from '../components/ui/feedback.tsx';
import { SaveBar } from '../components/ui/savebar.tsx';
import { AreaTabs } from '../components/ui/tabs.tsx';
import { RankCardArea } from './leveling/card.tsx';
import { EventsArea } from './leveling/events.tsx';
import { LeaderboardArea } from './leveling/leaderboard.tsx';
import { LevelUpArea } from './leveling/levelup.tsx';
import { RewardsArea } from './leveling/rewards.tsx';
import { EarningArea } from './leveling/xp.tsx';

export default function LevelingPage({
  guildId,
  meta,
  summary,
  area,
}: ModulePageProps): ReactElement {
  const form = useModuleForm({
    guildId,
    moduleId: meta.id,
    schema: levelingConfigSchema,
    templates: levelingTemplates,
  });
  const toggle = useModuleToggle(guildId, summary);

  const enabled = summary?.enabled ?? form.view.enabled;

  return (
    <>
      <ModuleHeader
        meta={meta}
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
        offNote="Settings are saved, but no one earns XP until you turn it on."
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

      <LoadingBoundary key={area} label={`Loading ${meta.label}`} minHeight={320}>
        {area === 'xp' ? <EarningArea guildId={guildId} form={form} /> : null}
        {area === 'events' ? <EventsArea guildId={guildId} enabled={enabled} /> : null}
        {area === 'levelup' ? <LevelUpArea guildId={guildId} form={form} /> : null}
        {area === 'rewards' ? <RewardsArea guildId={guildId} form={form} /> : null}
        {area === 'card' ? <RankCardArea guildId={guildId} form={form} /> : null}
        {area === 'leaderboard' ? <LeaderboardArea guildId={guildId} /> : null}
      </LoadingBoundary>

      <SaveBar
        dirty={form.dirty}
        saving={form.saving}
        failures={form.failures}
        onSave={form.save}
        onReset={form.reset}
      />
    </>
  );
}
