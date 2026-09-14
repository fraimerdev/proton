import { type TagsConfig, tagsConfigSchema } from '@proton/module-tags/config';
import { useQuery } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { type ModuleForm, useModuleForm } from '../components/module/form.ts';
import {
  ModuleBanners,
  ModuleHeader,
  ModuleSwitch,
  moduleState,
} from '../components/module/page.tsx';
import type { ModulePageProps } from '../components/module/registry.ts';
import { useModuleToggle } from '../components/module/toggle.ts';
import { LimitCounter } from '../components/ui/collection.tsx';
import { Switch } from '../components/ui/controls.tsx';
import { LoadingBoundary, Spinner, StatusBanner } from '../components/ui/feedback.tsx';
import { Rows, Section, SettingRow } from '../components/ui/layout.tsx';
import { SaveBar } from '../components/ui/savebar.tsx';
import { AreaTabs } from '../components/ui/tabs.tsx';
import { ceilingNote, listCeiling } from '../lib/limits.ts';
import { TagLibraryArea } from './tags/library.tsx';
import { tagCountQuery } from './tags/queries.ts';

const PERMISSIONS = 'Set who can use /tags in Permissions.';

const EPHEMERAL_DESCRIPTION =
  'Only the member who used /tag sees the tag, and it disappears when they dismiss it.';

const MENTIONS_DESCRIPTION = 'A stored @everyone becomes pingable by any member.';

const MENTIONS_NOTE = 'When this is off, mentions still show but do not notify anyone.';

export default function TagsPage({ guildId, meta, summary, area }: ModulePageProps): ReactElement {
  const form = useModuleForm({ guildId, moduleId: meta.id, schema: tagsConfigSchema });
  const toggle = useModuleToggle(guildId, summary);

  const enabled = summary?.enabled ?? form.view.enabled;
  const library = area === 'library';

  const count = useQuery(tagCountQuery(guildId, library));

  const tier = form.view.tier;
  const ceiling = listCeiling(tier, 'tags');
  const used = count.data?.total;

  return (
    <>
      <ModuleHeader
        meta={meta}
        subtitle={PERMISSIONS}
        actions={
          <>
            {library && count.isPending ? (
              <Spinner label="Loading tag count" />
            ) : library && used !== undefined ? (
              <span className="inline inline-8">
                {used >= ceiling ? (
                  <span className="text-xs text-muted">{ceilingNote(tier, 'tags')}</span>
                ) : null}
                <LimitCounter used={used} ceiling={ceiling} label="tags" />
              </span>
            ) : null}
            <ModuleSwitch
              name={meta.label}
              enabled={enabled}
              state={summary ? moduleState(summary) : 'off'}
              busy={toggle.busy}
              onToggle={toggle.toggle}
            />
          </>
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
      </ModuleBanners>

      <LoadingBoundary
        key={area}
        label={library ? 'Loading tags' : 'Loading settings'}
        minHeight={320}
      >
        {library ? <TagLibraryArea guildId={guildId} moduleId={meta.id} /> : null}
        {area === 'settings' ? <TagSettings form={form} /> : null}
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

function TagSettings({ form }: { form: ModuleForm<TagsConfig> }): ReactElement {
  return (
    <Section label="Posting">
      <Rows>
        <SettingRow
          title="Reply privately"
          description={EPHEMERAL_DESCRIPTION}
          error={form.errorAt('ephemeral')}
        >
          <Switch
            label="Reply privately"
            checked={form.value.ephemeral}
            onChange={(next) => form.setValue((current) => ({ ...current, ephemeral: next }))}
          />
        </SettingRow>

        <SettingRow
          title="Allow pings"
          description={MENTIONS_DESCRIPTION}
          note={MENTIONS_NOTE}
          error={form.errorAt('allowMentions')}
        >
          <Switch
            label="Allow pings"
            checked={form.value.allowMentions}
            onChange={(next) => form.setValue((current) => ({ ...current, allowMentions: next }))}
          />
        </SettingRow>
      </Rows>
    </Section>
  );
}
