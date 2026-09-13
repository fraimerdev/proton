import { panelFor, ticketsConfigSchema, typeFor, typesOf } from '@proton/module-tickets/config';
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
import { EmptyState, LoadingBoundary, StatusBanner } from '../components/ui/feedback.tsx';
import { SaveBar } from '../components/ui/savebar.tsx';
import { AreaTabs } from '../components/ui/tabs.tsx';
import { useTicketNav, useTicketSearch } from './tickets/nav.ts';
import { PanelEditor } from './tickets/panel-editor.tsx';
import { PanelsArea } from './tickets/panels.tsx';
import { QueueArea } from './tickets/queue.tsx';
import { ResponsesArea } from './tickets/responses.tsx';
import { SettingsArea } from './tickets/settings.tsx';
import { TypeDetail } from './tickets/type-detail.tsx';
import { TypesArea } from './tickets/types.tsx';

const SWITCHED_OFF =
  'Tickets is switched off. Settings are saved, but nothing runs until you switch it on. No panel ' +
  'opens a ticket and no ticket command works.';

const MIGRATED =
  'These settings were saved by an older version of Proton. Each panel’s category, staff roles, ' +
  'opening message and transcript channel became its own ticket type. Those types delete the ' +
  'channel 1 second after the ticket closes and do not allow reopening. Check them, then save to ' +
  'store them in the current format.';

const NO_TYPES =
  'Tickets is switched on but has no ticket types, so members have nothing to open. Create one ' +
  'under Ticket types.';

const NO_PANEL_CARRIES =
  'No panel offers a ticket type, so members cannot open tickets from a panel. They can still use ' +
  '/ticket create.';

const SAVE_NOTE = 'Posted panels keep their old wording until you post them again.';

const MAYBE_DELETED = 'It may have been deleted.';

export default function TicketsPage({
  guildId,
  meta,
  summary,
  area,
}: ModulePageProps): ReactElement {
  const form = useModuleForm({ guildId, moduleId: meta.id, schema: ticketsConfigSchema });
  const toggle = useModuleToggle(guildId, summary);
  const search = useTicketSearch();
  const go = useTicketNav(guildId, meta.id);

  const config = form.value;
  const enabled = summary?.enabled ?? form.view.enabled;

  const selectedType = area === 'types' && search.id !== undefined ? search.id : undefined;
  const selectedPanel = area === 'panels' && search.id !== undefined ? search.id : undefined;

  const openType = selectedType === undefined ? undefined : typeFor(config, selectedType);
  const openPanel = selectedPanel === undefined ? undefined : panelFor(config, selectedPanel);
  const detailId = selectedType ?? selectedPanel;

  const crumb = openType?.name ?? openPanel?.name;

  const noPanelCarries =
    config.types.length > 0 &&
    config.panels.length > 0 &&
    config.panels.every((panel) => typesOf(config, panel).length === 0);

  return (
    <>
      <ModuleHeader
        meta={meta}
        crumb={crumb}
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
          types: config.types.length,
          panels: config.panels.length,
          responses: config.responses.length,
        }}
      />

      <ModuleBanners
        guildId={guildId}
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
                search={{ area: 'types' }}
                className="button button-secondary button-sm"
              >
                Review
              </ModuleLink>
            }
          >
            {MIGRATED}
          </StatusBanner>
        ) : null}

        {enabled && config.types.length === 0 ? (
          <StatusBanner tone="warning">{NO_TYPES}</StatusBanner>
        ) : enabled && noPanelCarries ? (
          <StatusBanner tone="warning">{NO_PANEL_CARRIES}</StatusBanner>
        ) : null}
      </ModuleBanners>

      <LoadingBoundary
        key={detailId === undefined ? area : `${area}:${detailId}`}
        label="Loading tickets"
        minHeight={320}
      >
        {area === 'queue' ? <QueueArea form={form} guildId={guildId} moduleId={meta.id} /> : null}

        {area === 'types' && selectedType === undefined ? (
          <TypesArea form={form} guildId={guildId} moduleId={meta.id} />
        ) : null}

        {area === 'types' && selectedType !== undefined ? (
          openType === undefined ? (
            <EmptyState
              icon="ticket"
              title="Ticket type not found"
              inset
              actions={
                <BackLink onBack={() => go({ id: undefined })} label="Back to ticket types" />
              }
            >
              {MAYBE_DELETED}
            </EmptyState>
          ) : (
            <TypeDetail
              form={form}
              guildId={guildId}
              type={openType}
              index={config.types.indexOf(openType)}
              onBack={() => go({ id: undefined })}
            />
          )
        ) : null}

        {area === 'panels' && selectedPanel === undefined ? (
          <PanelsArea form={form} guildId={guildId} moduleId={meta.id} enabled={enabled} />
        ) : null}

        {area === 'panels' && selectedPanel !== undefined ? (
          openPanel === undefined ? (
            <EmptyState
              icon="megaphone"
              title="Panel not found"
              inset
              actions={<BackLink onBack={() => go({ id: undefined })} label="Back to panels" />}
            >
              {MAYBE_DELETED}
            </EmptyState>
          ) : (
            <PanelEditor
              form={form}
              guildId={guildId}
              panel={openPanel}
              index={config.panels.indexOf(openPanel)}
              onBack={() => go({ id: undefined })}
            />
          )
        ) : null}

        {area === 'responses' ? <ResponsesArea form={form} /> : null}

        {area === 'settings' ? <SettingsArea form={form} guildId={guildId} /> : null}
      </LoadingBoundary>

      <SaveBar
        dirty={form.dirty}
        saving={form.saving}
        onSave={form.save}
        onReset={form.reset}
        note={SAVE_NOTE}
      />
    </>
  );
}

function BackLink({ onBack, label }: { onBack: () => void; label: string }): ReactElement {
  return (
    <button type="button" className="button button-secondary button-sm" onClick={onBack}>
      {label}
    </button>
  );
}
