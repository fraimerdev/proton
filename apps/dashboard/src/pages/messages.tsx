import { messagesConfigSchema } from '@proton/module-messages/config';
import type { ReactElement } from 'react';
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
import { ComponentsArea } from './messages/components.tsx';
import { componentNameKeys, templateKeys, useHeldIndex } from './messages/shared.ts';
import { TemplatesArea } from './messages/templates.tsx';

const MIGRATED =
  'These settings were saved by an older version of Proton, and some may have changed. Open each ' +
  'template, check its embeds, then save once to store them in the current format.';

const SWITCHED_OFF =
  'Messages is switched off. Settings are saved, but nothing runs until you switch it on. ' +
  '/message post is refused, scheduled posts are cancelled, and buttons already posted say the ' +
  'module is off.';

// The whole-message rules land on the item rather than on a field, so the SaveBar carries them.
const ITEM_ISSUE = /^(templates|components)\.\d+$/;

export default function MessagesPage({
  guildId,
  meta,
  summary,
  area,
}: ModulePageProps): ReactElement {
  const form = useModuleForm({ guildId, moduleId: meta.id, schema: messagesConfigSchema });
  const toggle = useModuleToggle(guildId, summary);
  const search = useModuleSearch();

  const enabled = summary?.enabled ?? form.view.enabled;
  const current = area === 'components' ? 'components' : 'templates';

  const templateIndex = useHeldIndex(
    current === 'templates' ? search.id : undefined,
    templateKeys(form.value.templates),
  );

  const componentIndex = useHeldIndex(
    current === 'components' ? search.id : undefined,
    componentNameKeys(form.value.components),
  );

  const open =
    current === 'templates'
      ? form.value.templates[templateIndex]?.name
      : form.value.components[componentIndex]?.name;

  const view = open !== undefined ? 'editor' : search.id !== undefined ? 'missing' : 'list';

  const blocking = [...form.errors].find(([path]) => ITEM_ISSUE.test(path))?.[1];

  return (
    <>
      <ModuleHeader
        meta={meta}
        subtitle="Set who can use /message in Permissions."
        crumb={open}
        backTo={
          open === undefined ? undefined : (
            <ModuleLink
              className="messages-crumb"
              guildId={guildId}
              moduleId={meta.id}
              search={{ area: current }}
            >
              {current === 'templates' ? 'Templates' : 'Saved rows'}
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

      <AreaTabs guildId={guildId} moduleId={meta.id} areas={meta.areas ?? []} current={current} />

      <ModuleBanners
        guildId={guildId}
        moduleName={meta.label}
        status={summary?.status}
        enabled={enabled}
        migrated={form.view.migrated}
        migrationNote={MIGRATED}
        changedElsewhere={form.changedElsewhere}
        saveError={form.saveError}
      >
        {toggle.failure !== null ? (
          <StatusBanner tone="danger" live="assertive" onDismiss={toggle.dismiss}>
            {toggle.failure}
          </StatusBanner>
        ) : null}

        {!enabled ? <StatusBanner tone="neutral">{SWITCHED_OFF}</StatusBanner> : null}
      </ModuleBanners>

      <LoadingBoundary
        key={`${current}:${view}`}
        label={current === 'templates' ? 'Loading templates' : 'Loading saved rows'}
        minHeight={320}
      >
        {current === 'templates' ? (
          <TemplatesArea
            guildId={guildId}
            moduleId={meta.id}
            form={form}
            search={search}
            index={templateIndex}
          />
        ) : (
          <ComponentsArea
            guildId={guildId}
            moduleId={meta.id}
            form={form}
            search={search}
            index={componentIndex}
          />
        )}
      </LoadingBoundary>

      <SaveBar
        dirty={form.dirty}
        saving={form.saving}
        onSave={form.save}
        onReset={form.reset}
        note={blocking}
      />
    </>
  );
}
