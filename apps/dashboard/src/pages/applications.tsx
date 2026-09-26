import { applicationsConfigSchema } from '@proton/module-applications/config';
import { applicationsTemplates } from '@proton/module-applications/placeholders';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { useEffect, useRef } from 'react';
import { useModuleForm } from '../components/module/form.ts';
import {
  ModuleBanners,
  ModuleHeader,
  ModuleSwitch,
  moduleState,
} from '../components/module/page.tsx';
import type { ModulePageProps } from '../components/module/registry.ts';
import { ModuleLink, useModuleNavigate, useModuleSearch } from '../components/module/route.tsx';
import { useModuleToggle } from '../components/module/toggle.ts';
import { Button } from '../components/ui/controls.tsx';
import { EmptyState, LoadingBoundary, StatusBanner } from '../components/ui/feedback.tsx';
import { SaveBar } from '../components/ui/savebar.tsx';
import { AreaTabs } from '../components/ui/tabs.tsx';
import { applicationsAdminKey } from './applications/admin-queries.ts';
import { FormEditor } from './applications/editor.tsx';
import { FormsArea } from './applications/forms.tsx';
import { PanelEditor } from './applications/panel-editor.tsx';
import { PanelsArea } from './applications/panels.tsx';
import { applicationSummaryQuery } from './applications/queries.ts';
import { SettingsArea } from './applications/settings.tsx';
import {
  editorTab,
  errorLocations,
  formTitle,
  moduleSearchFor,
  queueSearchOf,
} from './applications/shape.ts';
import { SubmissionsArea } from './applications/submissions.tsx';

const OFF_NOTE =
  'Members can’t apply and staff can’t make decisions until you turn it on. Submissions stay ' +
  'readable.';

export default function ApplicationsPage({
  guildId,
  meta,
  summary,
  area,
}: ModulePageProps): ReactElement {
  const form = useModuleForm({
    guildId,
    moduleId: meta.id,
    schema: applicationsConfigSchema,
    templates: applicationsTemplates,
  });
  const toggle = useModuleToggle(guildId, summary);
  const search = useModuleSearch();
  const go = useModuleNavigate(guildId, meta.id);
  const queryClient = useQueryClient();
  const queue = useQuery(applicationSummaryQuery(guildId));

  const enabled = summary?.enabled ?? form.view.enabled;
  const config = form.value;

  // A save changes what the forms overview reports, and useModuleForm only refreshes the index.
  const saved = form.view.config;
  const seen = useRef(saved);
  useEffect(() => {
    if (seen.current === saved) return;
    seen.current = saved;
    void queryClient.invalidateQueries({ queryKey: applicationsAdminKey(guildId) });
  }, [saved, queryClient, guildId]);

  const formAt =
    area === 'forms' && search.id !== undefined
      ? config.forms.findIndex((entry) => entry.id === search.id)
      : -1;
  const editingForm = formAt === -1 ? undefined : config.forms[formAt];

  const panelAt =
    area === 'panels' && search.id !== undefined
      ? config.panels.findIndex((entry) => entry.id === search.id)
      : -1;
  const editingPanel = panelAt === -1 ? undefined : config.panels[panelAt];

  const crumb =
    editingForm !== undefined
      ? formTitle(editingForm)
      : editingPanel !== undefined
        ? editingPanel.name
        : undefined;

  const locations =
    form.saveError !== null && form.errors.size > 0
      ? errorLocations(form.errors.keys(), config)
      : [];

  const awaiting = queue.data?.awaiting;

  return (
    <>
      <ModuleHeader
        meta={meta}
        crumb={crumb}
        backTo={
          crumb === undefined ? undefined : (
            <ModuleLink
              guildId={guildId}
              moduleId={meta.id}
              search={{ area }}
              className="applications-crumb-link"
            >
              {area === 'panels' ? 'Panels' : 'Forms'}
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

      <AreaTabs
        guildId={guildId}
        moduleId={meta.id}
        areas={meta.areas ?? []}
        current={area}
        counts={{
          submissions: awaiting !== undefined && awaiting > 0 ? awaiting : undefined,
          forms: config.forms.length > 0 ? config.forms.length : undefined,
          panels: config.panels.length > 0 ? config.panels.length : undefined,
        }}
      />

      <ModuleBanners
        moduleName={meta.label}
        status={summary?.status}
        enabled={enabled}
        offNote={OFF_NOTE}
        migrated={form.view.migrated}
        changedElsewhere={form.changedElsewhere}
        saveError={form.saveError}
      >
        {toggle.failure !== null ? (
          <StatusBanner tone="danger" live="assertive" onDismiss={toggle.dismiss}>
            {toggle.failure}
          </StatusBanner>
        ) : null}

        {locations.length > 0 ? (
          <StatusBanner tone="warning" title="Where to fix it">
            <span className="applications-locations">
              {locations.map((location) => (
                <ModuleLink
                  key={location.key}
                  guildId={guildId}
                  moduleId={meta.id}
                  search={{
                    area: location.area,
                    ...(location.id === undefined ? {} : { id: location.id }),
                    ...(location.status === undefined ? {} : { status: location.status }),
                  }}
                  className="button button-secondary button-sm"
                >
                  {location.label}
                </ModuleLink>
              ))}
            </span>
          </StatusBanner>
        ) : null}
      </ModuleBanners>

      <LoadingBoundary
        key={`${area}:${editingForm?.id ?? editingPanel?.id ?? ''}`}
        label={`Loading ${meta.label}`}
        minHeight={320}
      >
        {area === 'submissions' ? (
          <SubmissionsArea
            guildId={guildId}
            surface="module"
            search={queueSearchOf(search)}
            onSearch={(patch, options) => go(moduleSearchFor(patch), options)}
          />
        ) : null}

        {area === 'forms' && editingForm !== undefined ? (
          <FormEditor
            key={editingForm.id}
            form={form}
            guildId={guildId}
            moduleId={meta.id}
            index={formAt}
            tab={editorTab(search.status)}
            onTab={(status) => go({ status })}
          />
        ) : null}

        {area === 'forms' && search.id !== undefined && editingForm === undefined ? (
          <EmptyState
            icon="warning"
            title="Form not found"
            inset
            actions={
              <Button tone="primary" onClick={() => go({ id: undefined, status: undefined })}>
                Back to forms
              </Button>
            }
          >
            It may have been deleted.
          </EmptyState>
        ) : null}

        {area === 'forms' && search.id === undefined ? (
          <FormsArea form={form} guildId={guildId} onOpen={(id) => go({ id, status: undefined })} />
        ) : null}

        {area === 'panels' && editingPanel !== undefined ? (
          <PanelEditor key={editingPanel.id} form={form} guildId={guildId} index={panelAt} />
        ) : null}

        {area === 'panels' && search.id !== undefined && editingPanel === undefined ? (
          <EmptyState
            icon="warning"
            title="Panel not found"
            inset
            actions={
              <Button tone="primary" onClick={() => go({ id: undefined })}>
                Back to panels
              </Button>
            }
          >
            It may have been deleted.
          </EmptyState>
        ) : null}

        {area === 'panels' && search.id === undefined ? (
          <PanelsArea
            form={form}
            guildId={guildId}
            moduleId={meta.id}
            enabled={enabled}
            onOpen={(id) => go({ id })}
          />
        ) : null}

        {area === 'settings' ? <SettingsArea form={form} guildId={guildId} /> : null}
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
