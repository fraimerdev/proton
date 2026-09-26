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
  'Settings are saved, but messages aren’t checked until you turn it on. Proton’s Discord AutoMod ' +
  'rules are removed while it’s off.';

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
    toggle.failure !== null ? (
      <StatusBanner tone="danger" live="assertive" onDismiss={toggle.dismiss}>
        {toggle.failure}
      </StatusBanner>
    ) : undefined;

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
        offNote={SWITCHED_OFF}
        migrated={form.view.migrated}
        changedElsewhere={form.changedElsewhere}
        saveError={form.saveError}
      >
        {notices}
      </ModuleBanners>

      <LoadingBoundary key={area} label={`Loading ${meta.label}`} minHeight={320}>
        {area === 'checks' ? <ChecksArea form={form} /> : null}
        {area === 'response' ? <ResponseArea form={form} guildId={guildId} /> : null}
        {area === 'native' ? <NativeArea form={form} /> : null}
        {area === 'exemptions' ? <ExemptionsArea form={form} guildId={guildId} /> : null}
      </LoadingBoundary>

      <SaveBar
        dirty={form.dirty}
        saving={form.saving}
        failures={form.failures}
        onSave={form.save}
        onReset={form.reset}
        note="Saving also updates this server’s Discord AutoMod rules."
      />
    </>
  );
}
