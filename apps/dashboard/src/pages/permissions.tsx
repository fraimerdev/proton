import { permissionsConfigSchema } from '@proton/module-permissions/config';
import { useSuspenseQuery } from '@tanstack/react-query';
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
import { StatusBanner } from '../components/ui/feedback.tsx';
import { SaveBar } from '../components/ui/savebar.tsx';
import { modulesQuery } from '../lib/queries.ts';
import { CommandMatrix } from './permissions/matrix.tsx';

const MIGRATION_NOTE =
  '/untimeout, /unquarantine and /unlock are now part of /timeout, /quarantine and /lockdown. ' +
  'Their roles moved to those commands, except where a command already had its own. Proton ' +
  'already applies them this way. Save to store them in the current format.';

export default function PermissionsPage({ guildId, meta, summary }: ModulePageProps): ReactElement {
  const form = useModuleForm({ guildId, moduleId: meta.id, schema: permissionsConfigSchema });
  const toggle = useModuleToggle(guildId, summary);
  const { modules } = useSuspenseQuery(modulesQuery(guildId)).data;

  const enabled = summary?.enabled ?? form.view.enabled;

  return (
    <>
      <ModuleHeader
        meta={meta}
        subtitle={meta.subtitle}
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

      <ModuleBanners
        moduleName={meta.label}
        status={summary?.status}
        enabled={enabled}
        migrated={form.view.migrated}
        migrationNote={MIGRATION_NOTE}
        changedElsewhere={form.changedElsewhere}
        saveError={form.saveError}
      >
        {toggle.failure !== null ? (
          <StatusBanner tone="danger" live="assertive" onDismiss={toggle.dismiss}>
            {toggle.failure}
          </StatusBanner>
        ) : null}
      </ModuleBanners>

      <CommandMatrix
        guildId={guildId}
        moduleId={meta.id}
        form={form}
        modules={modules}
        gating={enabled}
      />

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
