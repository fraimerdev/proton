import type { BackupConfig } from '@proton/module-backup/config';
import { backupConfigSchema, MAX_RETAINED_BACKUPS } from '@proton/module-backup/config';
import type { ReactElement } from 'react';
import type { ModuleForm } from '../components/module/form.ts';
import { useModuleForm } from '../components/module/form.ts';
import {
  ModuleBanners,
  ModuleHeader,
  ModuleSwitch,
  moduleState,
} from '../components/module/page.tsx';
import type { ModulePageProps } from '../components/module/registry.ts';
import { useModuleToggle } from '../components/module/toggle.ts';
import { NumberStepper } from '../components/ui/controls.tsx';
import { StatusBanner } from '../components/ui/feedback.tsx';
import { Rows, Section, SettingRow } from '../components/ui/layout.tsx';
import { SaveBar } from '../components/ui/savebar.tsx';
import { AreaTabs } from '../components/ui/tabs.tsx';

function Mono({ children }: { children: string }): ReactElement {
  return <span className="mono">{children}</span>;
}

function BackupsArea(): ReactElement {
  return (
    <Section
      label="Commands"
      note="Each needs Manage Server"
      intro="Use /backup in Discord to create, list and restore snapshots. The dashboard cannot show them; it only sets how many are kept."
    >
      <Rows>
        <SettingRow
          title={<Mono>/backup create</Mono>}
          description="Save every channel, role and permission overwrite Proton can see, and delete the oldest snapshots beyond the number kept. The reply names any channel Proton cannot view."
        />
        <SettingRow
          title={<Mono>/backup list</Mono>}
          description="Show saved snapshots, newest first, with each one’s ID, when and by whom it was taken, and its channel and role counts."
        />
        <SettingRow
          title={<Mono>/backup restore</Mono>}
          description="Recreate a snapshot’s missing channels and roles, using an ID from /backup list. It shows a preview until you add confirm: true, and never deletes or replaces anything."
        />
      </Rows>
    </Section>
  );
}

function SettingsArea({ form }: { form: ModuleForm<BackupConfig> }): ReactElement {
  const error = form.errorAt('retainBackups');

  return (
    <Section label="Retention">
      <Rows>
        <SettingRow
          title="Snapshots to keep"
          description="Each new snapshot deletes the oldest ones beyond this number."
          error={error}
          note={
            <>
              Lowering this deletes the extra snapshots at the next <Mono>/backup create</Mono>, not
              straight away.
            </>
          }
        >
          <NumberStepper
            label="Snapshots to keep"
            value={form.value.retainBackups}
            min={1}
            max={MAX_RETAINED_BACKUPS}
            invalid={error !== undefined}
            onChange={(next) =>
              form.setValue((current) => ({
                ...current,
                retainBackups: next ?? current.retainBackups,
              }))
            }
          />
        </SettingRow>
      </Rows>
    </Section>
  );
}

export default function BackupPage({
  guildId,
  meta,
  summary,
  area,
}: ModulePageProps): ReactElement {
  const form = useModuleForm({ guildId, moduleId: meta.id, schema: backupConfigSchema });
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
        migrated={form.view.migrated}
        changedElsewhere={form.changedElsewhere}
        saveError={form.saveError}
      >
        {toggle.failure !== null ? (
          <StatusBanner tone="danger" live="assertive" onDismiss={toggle.dismiss}>
            {toggle.failure}
          </StatusBanner>
        ) : null}

        {!enabled ? (
          <StatusBanner tone="neutral" icon="info" title="Backup is switched off">
            /backup only replies “Backups are switched off in this server. An admin can turn the
            Backup module back on from the Proton dashboard.”
          </StatusBanner>
        ) : null}
      </ModuleBanners>

      {area === 'backups' ? <BackupsArea /> : null}
      {area === 'settings' ? <SettingsArea form={form} /> : null}

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
