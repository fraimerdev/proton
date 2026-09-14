import { honeypotConfigSchema } from '@proton/module-honeypot/config';
import { honeypotTemplates } from '@proton/module-honeypot/placeholders';
import type { ReactElement } from 'react';
import { useModuleForm } from '../components/module/form.ts';
import {
  ModuleBanners,
  ModuleHeader,
  ModuleSwitch,
  moduleState,
} from '../components/module/page.tsx';
import type { ModulePageProps } from '../components/module/registry.ts';
import { ModuleLink } from '../components/module/route.tsx';
import { useModuleToggle } from '../components/module/toggle.ts';
import { LoadingBoundary, StatusBanner } from '../components/ui/feedback.tsx';
import { SaveBar } from '../components/ui/savebar.tsx';
import { AreaTabs } from '../components/ui/tabs.tsx';
import { CamouflageArea } from './honeypot/camouflage.tsx';
import { ConsequencesArea } from './honeypot/consequences.tsx';
import { DirectMessageArea } from './honeypot/direct-message.tsx';
import { EscalationArea } from './honeypot/escalation.tsx';
import { ExemptionsArea } from './honeypot/exemptions.tsx';
import { NoticeArea } from './honeypot/notice.tsx';
import { armedChannelIds } from './honeypot/shape.ts';
import { TrapsArea } from './honeypot/traps.tsx';

const SWITCHED_OFF =
  'Honeypot is switched off. Settings are saved, but nothing runs until you switch it on. ' +
  'Proton has deleted the warning messages it posted.';

const MIGRATED =
  'These settings were saved when each bait channel had its own action, message deletion window ' +
  'and timeout duration. Honeypot now uses one of each for all bait channels, taken from the ' +
  'first armed one. Check Response before you save.';

const NO_TRAPS = 'Honeypot is switched on, but no bait channel is armed, so nothing is watched.';

const SAVE_NOTE =
  'Saving also posts, updates or deletes warning messages in bait channels, and restarts the ' +
  'daily camouflage job.';

export default function HoneypotPage({
  guildId,
  meta,
  summary,
  area,
}: ModulePageProps): ReactElement {
  const form = useModuleForm({
    guildId,
    moduleId: meta.id,
    schema: honeypotConfigSchema,
    templates: honeypotTemplates,
  });
  const toggle = useModuleToggle(guildId, summary);

  const enabled = summary?.enabled ?? form.view.enabled;
  const armed = armedChannelIds(form.value).length;

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

      <AreaTabs
        guildId={guildId}
        moduleId={meta.id}
        areas={meta.areas ?? []}
        current={area}
        counts={{ channels: form.value.channels.length }}
      />

      <ModuleBanners
        moduleName={meta.label}
        status={summary?.status}
        enabled={enabled}
        changedElsewhere={form.changedElsewhere}
        saveError={form.saveError}
      >
        {toggle.failure !== null ? (
          <StatusBanner tone="danger" live="assertive" onDismiss={toggle.dismiss}>
            {toggle.failure}
          </StatusBanner>
        ) : null}

        {!enabled ? <StatusBanner tone="neutral">{SWITCHED_OFF}</StatusBanner> : null}

        {form.view.migrated ? (
          <StatusBanner
            tone="info"
            title="Settings from an older version"
            actions={
              <ModuleLink
                guildId={guildId}
                moduleId={meta.id}
                search={{ area: 'consequences' }}
                className="button button-secondary button-sm"
              >
                Review
              </ModuleLink>
            }
          >
            {MIGRATED}
          </StatusBanner>
        ) : null}

        {enabled && armed === 0 ? <StatusBanner tone="warning">{NO_TRAPS}</StatusBanner> : null}
      </ModuleBanners>

      <LoadingBoundary key={area} label={`Loading ${meta.label}`} minHeight={280}>
        {area === 'channels' ? <TrapsArea form={form} guildId={guildId} /> : null}
        {area === 'camouflage' ? <CamouflageArea form={form} /> : null}
        {area === 'consequences' ? <ConsequencesArea form={form} /> : null}
        {area === 'exemptions' ? <ExemptionsArea form={form} guildId={guildId} /> : null}
        {area === 'warning' ? <NoticeArea form={form} guildId={guildId} /> : null}
        {area === 'dm' ? <DirectMessageArea form={form} guildId={guildId} /> : null}
        {area === 'escalation' ? <EscalationArea form={form} guildId={guildId} /> : null}
      </LoadingBoundary>

      <SaveBar
        dirty={form.dirty}
        saving={form.saving}
        failures={form.failures}
        onSave={form.save}
        onReset={form.reset}
        note={SAVE_NOTE}
      />
    </>
  );
}
