import { automodConfigSchema } from '@proton/module-automod/config';
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
import { ChecksArea } from './automod/checks.tsx';
import { ExemptionsArea } from './automod/exemptions.tsx';
import { NativeArea } from './automod/native.tsx';
import { ResponseArea } from './automod/response.tsx';

const SWITCHED_OFF =
  'Settings are saved, but nothing runs until you switch it on. Proton has deleted the Discord ' +
  'AutoMod rules it created.';

export default function AutomodPage({
  guildId,
  meta,
  summary,
  area,
}: ModulePageProps): ReactElement {
  const form = useModuleForm({ guildId, moduleId: meta.id, schema: automodConfigSchema });
  const toggle = useModuleToggle(guildId, summary);

  const enabled = summary?.enabled ?? form.view.enabled;

  const notices =
    toggle.failure !== null || !enabled ? (
      <>
        {toggle.failure !== null ? (
          <StatusBanner tone="danger" live="assertive" onDismiss={toggle.dismiss}>
            {toggle.failure}
          </StatusBanner>
        ) : null}

        {!enabled ? (
          <StatusBanner tone="neutral">{`${meta.label} is switched off. ${SWITCHED_OFF}`}</StatusBanner>
        ) : null}
      </>
    ) : undefined;

  return (
    <>
      <ModuleHeader
        meta={meta}
        subtitle="Screen messages for spam and unwanted content, and manage Discord AutoMod rules."
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
        guildId={guildId}
        moduleName={meta.label}
        status={summary?.status}
        enabled={enabled}
        migrated={form.view.migrated}
        changedElsewhere={form.changedElsewhere}
        saveError={form.saveError}
      >
        {notices}
      </ModuleBanners>

      <LoadingBoundary key={area} label={`Loading ${meta.label}`} minHeight={320}>
        {area === 'checks' ? <ChecksArea form={form} /> : null}
        {area === 'response' ? <ResponseArea form={form} guildId={guildId} /> : null}
        {area === 'native' ? <NativeArea form={form} guildId={guildId} enabled={enabled} /> : null}
        {area === 'exemptions' ? <ExemptionsArea form={form} guildId={guildId} /> : null}
      </LoadingBoundary>

      <SaveBar
        dirty={form.dirty}
        saving={form.saving}
        onSave={form.save}
        onReset={form.reset}
        note="Saving also updates this server’s Discord AutoMod rules."
      />
    </>
  );
}
