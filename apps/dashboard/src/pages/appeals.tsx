import type { AppealPanel } from '@proton/module-appeals/config';
import { appealsConfigSchema } from '@proton/module-appeals/config';
import { useQuery } from '@tanstack/react-query';
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
import { moduleConfigQuery, modulesQuery } from '../lib/queries.ts';
import { PanelEditor } from './appeals/editor.tsx';
import { FormsArea } from './appeals/forms.tsx';
import { ReviewArea } from './appeals/review.tsx';
import { panelTitle, useAppealsNav, useAppealsSearch } from './appeals/shape.ts';

/**
 * A form only ever opens if something mints a signed link for it, and the honeypot's block DM is
 * the only thing in Proton that does. This says so rather than writing the honeypot's config.
 */
function useUnreachableForms(
  guildId: string,
  panels: readonly AppealPanel[],
  enabled: boolean,
): boolean {
  const honeypot = useQuery(moduleConfigQuery(guildId, 'honeypot'));
  const index = useQuery(modulesQuery(guildId));

  if (!enabled) return false;

  const live = panels.filter((panel) => panel.enabled);
  if (live.length === 0) return false;

  const summary = index.data?.modules.find((module) => module.id === 'honeypot');
  if (summary === undefined || honeypot.data === undefined) return false;

  if (!summary.enabled) return true;

  const pointed = honeypot.data.config.appealPanelId;
  return typeof pointed !== 'string' || !live.some((panel) => panel.id === pointed);
}

export default function AppealsPage({
  guildId,
  meta,
  summary,
  area,
}: ModulePageProps): ReactElement {
  const form = useModuleForm({ guildId, moduleId: meta.id, schema: appealsConfigSchema });
  const toggle = useModuleToggle(guildId, summary);
  const search = useAppealsSearch();
  const go = useAppealsNav(guildId, meta.id);

  const enabled = summary?.enabled ?? form.view.enabled;
  const unreachable = useUnreachableForms(guildId, form.value.panels, enabled);

  const at =
    area === 'forms' && search.id !== undefined
      ? form.value.panels.findIndex((panel) => panel.id === search.id)
      : -1;
  const editing = at === -1 ? undefined : form.value.panels[at];

  return (
    <>
      <ModuleHeader
        meta={meta}
        crumb={editing ? panelTitle(editing) : undefined}
        backTo={
          editing ? (
            <ModuleLink
              guildId={guildId}
              moduleId={meta.id}
              search={{ area: 'forms' }}
              className="appeals-crumb-link"
            >
              Appeal forms
            </ModuleLink>
          ) : undefined
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
        guildId={guildId}
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

        {unreachable ? (
          <StatusBanner
            tone="info"
            title="No appeal link leads to these forms"
            actions={
              <ModuleLink
                guildId={guildId}
                moduleId={'honeypot'}
                search={{}}
                className="button button-secondary button-sm"
              >
                Open Honeypot
              </ModuleLink>
            }
          >
            Only Honeypot sends appeal links, and only when its action is Ban. Each link opens the
            form chosen in its Appeal form setting.
          </StatusBanner>
        ) : null}
      </ModuleBanners>

      <LoadingBoundary
        key={`${area}:${editing?.id ?? ''}`}
        label={`Loading ${meta.label}`}
        minHeight={320}
      >
        {area === 'review' ? <ReviewArea form={form} guildId={guildId} /> : null}

        {area === 'forms' && editing !== undefined ? (
          <PanelEditor
            key={editing.id}
            form={form}
            panel={editing}
            index={at}
            guildId={guildId}
            moduleId={meta.id}
          />
        ) : null}

        {area === 'forms' && editing === undefined ? (
          <FormsArea form={form} guildId={guildId} onOpen={(id) => go({ id })} />
        ) : null}
      </LoadingBoundary>

      <SaveBar dirty={form.dirty} saving={form.saving} onSave={form.save} onReset={form.reset} />
    </>
  );
}
