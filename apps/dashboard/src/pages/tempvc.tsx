import { tempVcConfigSchema } from '@proton/module-tempvc/config';
import { tempvcTemplates } from '@proton/module-tempvc/placeholders';
import { useQuery } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { useCallback } from 'react';
import { ChannelName } from '../components/discord/channel-picker.tsx';
import { useModuleForm } from '../components/module/form.ts';
import {
  ModuleBanners,
  ModuleHeader,
  ModuleSwitch,
  moduleState,
} from '../components/module/page.tsx';
import type { ModulePageProps } from '../components/module/registry.ts';
import {
  ModuleLink,
  type ModuleSearch,
  useModuleNavigate,
  useModuleSearch,
} from '../components/module/route.tsx';
import { useModuleToggle } from '../components/module/toggle.ts';
import { Button } from '../components/ui/controls.tsx';
import { EmptyState, Spinner, StatusBanner } from '../components/ui/feedback.tsx';
import { SaveBar } from '../components/ui/savebar.tsx';
import { AreaTabs } from '../components/ui/tabs.tsx';
import { channelsQuery } from '../lib/queries.ts';
import { HubDetail } from './tempvc/hub-detail.tsx';
import { HubList } from './tempvc/hub-list.tsx';
import { GlobalSettings } from './tempvc/settings.tsx';

const GONE = 'It may have been removed.';

export default function TempVcPage({
  guildId,
  meta,
  summary,
  area,
}: ModulePageProps): ReactElement {
  const form = useModuleForm({
    guildId,
    moduleId: meta.id,
    schema: tempVcConfigSchema,
    templates: tempvcTemplates,
  });
  const toggle = useModuleToggle(guildId, summary);
  const navigate = useModuleNavigate(guildId, meta.id);
  const search = useModuleSearch();

  const go = useCallback(
    (patch: Pick<ModuleSearch, 'id' | 'q'>) => {
      navigate({ area: 'hubs', ...patch });
    },
    [navigate],
  );

  const config = form.value;
  const enabled = summary?.enabled ?? form.view.enabled;

  const selectedId = area === 'hubs' ? search.id : undefined;
  const index =
    selectedId === undefined
      ? -1
      : config.hubs.findIndex((candidate) => candidate.channelId === selectedId);
  const hub = index >= 0 ? config.hubs[index] : undefined;

  const { data: channels, isPending: channelsPending } = useQuery({
    ...channelsQuery(guildId),
    enabled: hub !== undefined,
  });

  return (
    <>
      <ModuleHeader
        meta={meta}
        crumb={
          hub !== undefined ? (
            channelsPending ? (
              <Spinner label="Loading channel" size="lg" />
            ) : (
              <ChannelName
                channel={(channels ?? []).find((channel) => channel.id === hub.channelId)}
                id={hub.channelId}
              />
            )
          ) : undefined
        }
        backTo={
          hub !== undefined ? (
            <ModuleLink guildId={guildId} moduleId={meta.id} search={{ area: 'hubs' }}>
              Creator channels
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

      <AreaTabs
        guildId={guildId}
        moduleId={meta.id}
        areas={meta.areas ?? []}
        current={area}
        counts={{ hubs: config.hubs.length }}
      />

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

      {area === 'settings' ? <GlobalSettings form={form} /> : null}

      {area === 'hubs' && hub !== undefined ? (
        <HubDetail
          form={form}
          guildId={guildId}
          moduleId={meta.id}
          index={index}
          hub={hub}
          onRemoved={() => go({ id: undefined })}
          onChannelChange={(id) => navigate({ area: 'hubs', id }, { replace: true })}
        />
      ) : null}

      {area === 'hubs' && hub === undefined && selectedId !== undefined ? (
        <EmptyState
          icon="warning"
          title="Creator channel not found"
          inset
          actions={
            <Button tone="primary" onClick={() => go({ id: undefined })}>
              Back to creator channels
            </Button>
          }
        >
          {GONE}
        </EmptyState>
      ) : null}

      {area === 'hubs' && selectedId === undefined ? (
        <HubList
          form={form}
          guildId={guildId}
          query={search.q ?? ''}
          onQuery={(next) => go({ q: next === '' ? undefined : next })}
          onOpen={(channelId) => go({ id: channelId })}
        />
      ) : null}

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
