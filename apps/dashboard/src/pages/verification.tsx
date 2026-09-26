import { verificationConfigSchema } from '@proton/module-verification/config';
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
import { GateArea } from './verification/gate.tsx';
import { PanelArea } from './verification/panel.tsx';

const GATE_INCOMPLETE =
  'Choose a member role or an unverified role. Until you do, verifying changes nothing.';

export default function VerificationPage({
  guildId,
  meta,
  summary,
  area,
}: ModulePageProps): ReactElement {
  const form = useModuleForm({ guildId, moduleId: meta.id, schema: verificationConfigSchema });
  const toggle = useModuleToggle(guildId, summary);

  const current = area === 'panel' ? 'panel' : 'gate';

  const enabled = summary?.enabled ?? form.view.enabled;
  const config = form.value;
  const incomplete = enabled && !config.verifiedRoleId && !config.unverifiedRoleId;

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

      <AreaTabs guildId={guildId} moduleId={meta.id} areas={meta.areas ?? []} current={current} />

      <ModuleBanners
        moduleName={meta.label}
        status={summary?.status}
        enabled={enabled}
        offNote="Settings are saved, but nothing runs until you turn it on."
        migrated={form.view.migrated}
        changedElsewhere={form.changedElsewhere}
        saveError={form.saveError}
      >
        {toggle.failure !== null ? (
          <StatusBanner tone="danger" live="assertive" onDismiss={toggle.dismiss}>
            {toggle.failure}
          </StatusBanner>
        ) : null}

        {incomplete ? <StatusBanner tone="warning">{GATE_INCOMPLETE}</StatusBanner> : null}
      </ModuleBanners>

      <LoadingBoundary key={current} label={`Loading ${meta.label}`} minHeight={280}>
        {current === 'gate' ? (
          <GateArea guildId={guildId} form={form} enabled={enabled} />
        ) : (
          <PanelArea guildId={guildId} moduleId={meta.id} form={form} />
        )}
      </LoadingBoundary>

      <SaveBar
        dirty={form.dirty}
        saving={form.saving}
        failures={form.failures}
        onSave={form.save}
        onReset={form.reset}
        note={
          config.panelChannelId !== undefined
            ? 'Saving also posts or updates the verification panel.'
            : undefined
        }
      />
    </>
  );
}
